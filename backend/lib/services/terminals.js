//
// Copyright (c) 2019 by SAP SE or an SAP affiliate company. All rights reserved. This file is licensed under the Apache Software License, v. 2 except as noted otherwise in the LICENSE file
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//

'use strict'

const _ = require('lodash')

const kubernetes = require('../kubernetes')
const Resources = kubernetes.Resources
const {
  getKubeconfig,
  getShootIngressDomain,
  getConfigValue,
  getSoilIngressDomainForSeed,
  decodeBase64
} = require('../utils')
const {
  toTerminalResource
} = require('../utils/terminals/terminalResources')
const { getSeeds } = require('../cache')
const authorization = require('./authorization')
const shoots = require('./shoots')
const { Forbidden } = require('../errors')
const logger = require('../logger')
const fnv = require('fnv-plus')

const TERMINAL_CONTAINER_NAME = 'terminal'

function Garden ({ auth }) {
  return kubernetes.garden({ auth })
}

function Gardendashboard ({ auth }) {
  return kubernetes.gardendashboard({ auth })
}

function Core ({ auth }) {
  return kubernetes.core({ auth })
}

async function readServiceAccountToken ({ coreClient, namespace, serviceAccountName, waitUntilReady = true }) {
  let serviceAccount
  if (waitUntilReady) {
    const resourceName = serviceAccountName
    const conditionFunction = isServiceAccountReady
    const watch = coreClient.ns(namespace).serviceaccounts.watch({ name: serviceAccountName })
    serviceAccount = await kubernetes.waitUntilResourceHasCondition({ watch, conditionFunction, resourceName, waitTimeout: 10 * 1000 })
  } else {
    try {
      serviceAccount = await coreClient.ns(namespace).serviceaccounts.get({ name: serviceAccountName })
    } catch (err) {
      if (err.code !== 404) {
        throw err
      }
    }
  }
  const secrets = _.get(serviceAccount, 'secrets')
  const secretName = _.get(_.first(secrets), 'name')
  if (_.isEmpty(secretName)) {
    return
  }

  const secret = await coreClient.ns(namespace).secrets.get({ name: secretName })
  const token = decodeBase64(secret.data.token)
  const caData = secret.data['ca.crt']
  return { token, caData }
}

function isServiceAccountReady ({ secrets } = {}) {
  const secretName = _.get(_.first(secrets), 'name')
  return !_.isEmpty(secretName)
}

async function existsShoot ({ gardenClient, seedName }) {
  try {
    await shoots.read({ gardenClient, namespace: 'garden', name: seedName })
    return true
  } catch (err) {
    if (err.code === 404) {
      return false
    }
    throw err
  }
}

async function getKubeApiServerHost ({ user, seed }) {
  const gardenClient = Garden(user)
  const isSoil = _.get(seed, ['metadata', 'labels', 'garden.sapcloud.io/role']) === 'soil' || !await existsShoot({ gardenClient, seedName: seed.metadata.name })
  let soilIngressDomain
  const projectsClient = gardenClient.projects
  const namespacesClient = Core(user).namespaces
  if (isSoil) {
    const soilSeed = seed
    soilIngressDomain = await getSoilIngressDomainForSeed(projectsClient, namespacesClient, soilSeed)
  } else {
    const seedName = seed.metadata.name
    const seedShootResource = await readShoot({ user, namespace: 'garden', name: seedName })
    soilIngressDomain = await getShootIngressDomain(projectsClient, namespacesClient, seedShootResource)

    const seedShootNS = _.get(seedShootResource, 'status.technicalID')
    if (!seedShootNS) {
      throw new Error(`could not get namespace for seed ${seedName} on soil`)
    }
  }

  return `api.${soilIngressDomain}`
}

async function readShoot ({ user, namespace, name }) {
  try {
    return await shoots.read({ user, namespace, name })
  } catch (err) {
    if (err.code !== 404) {
      throw err
    }
    return undefined
  }
}

async function findExistingTerminalResource ({ gardendashboardClient, username, namespace, name, target }) {
  let selectors = [
    `dashboard.gardener.cloud/targetType=${target}`,
    `garden.sapcloud.io/createdBy=${fnv.hash(username, 64).str()}`
  ]
  if (!_.isEmpty(name)) {
    selectors = _.concat(selectors, `garden.sapcloud.io/name=${name}`)
  }
  const qs = { labelSelector: selectors.join(',') }

  let { items: existingTerminals } = await gardendashboardClient.ns(namespace).terminals.get({ qs })
  existingTerminals = _.filter(existingTerminals, terminal => _.isEmpty(terminal.metadata.deletionTimestamp))

  return _.find(existingTerminals, item => item.metadata.annotations['garden.sapcloud.io/createdBy'] === username)
}

async function findExistingTerminal ({ gardendashboardClient, hostCoreClient, username, namespace, name, target }) {
  let existingTerminal = await findExistingTerminalResource({ gardendashboardClient, username, namespace, name, target })

  if (!existingTerminal) {
    return undefined
  }
  if (!isTerminalReady(existingTerminal)) {
    existingTerminal = await readTerminalUntilReady({ gardendashboardClient, namespace, name })
  }
  const pod = existingTerminal.status.podName
  const attachServiceAccount = existingTerminal.status.attachServiceAccountName
  const hostNamespace = existingTerminal.spec.host.namespace

  const waitUntilReady = false // if the service account token is not there it is maybe in the process of beeing deleted -> handle as create new terminal
  const serviceAccountTokenObj = await readServiceAccountToken({ coreClient: hostCoreClient, namespace: hostNamespace, serviceAccountName: attachServiceAccount, waitUntilReady })
  const token = _.get(serviceAccountTokenObj, 'token')
  if (_.isEmpty(token)) {
    // TODO delete terminal resource?
    return undefined
  }

  logger.debug(`Found terminal session for user ${username}: ${existingTerminal.metadata.name}`)
  return { pod, token, attachServiceAccount, namespace: hostNamespace }
}

exports.create = async function ({ user, namespace, name, target }) {
  const isAdmin = await authorization.isAdmin(user)
  const username = user.id

  ensureTerminalAllowed({ isAdmin })

  return getOrCreateTerminalSession({ user, username, namespace, name, target })
}

async function getRuntimeClusterSecrets ({ gardenCoreClient }) {
  const qs = { labelSelector: 'runtime=garden' }
  return gardenCoreClient.ns('garden').secrets.get({ qs })
}

async function getGardenRuntimeClusterSecretRef ({ gardenCoreClient }) {
  const { items: runtimeSecrets } = await getRuntimeClusterSecrets({ gardenCoreClient })
  const secret = _.head(runtimeSecrets)
  if (!secret) {
    throw new Error('could not fetch garden runtime secret')
  }
  const { metadata: { name, namespace } } = secret
  return {
    name,
    namespace
  }
}

async function getContext ({ user, namespace, name, target }) {
  let hostNamespace
  let targetCredentials
  let hostSecretRef
  let kubecfgCtxNamespaceTargetCluster
  let bindingKind
  let targetNamespace
  let kubeApiServer

  const gardenCoreClient = Core(user)

  if (target === 'garden') {
    hostNamespace = undefined // this will create a temporary namespace
    kubeApiServer = _.head(getConfigValue({ path: 'terminal.gardenCluster.kubeApiServer.hosts' }))
    kubecfgCtxNamespaceTargetCluster = namespace
    targetNamespace = 'garden'

    targetCredentials = {
      serviceAccountRef: {
        name: getConfigValue({ path: 'terminal.gardenCluster.serviceAccountName', defaultValue: 'dashboard-terminal-admin' }),
        namespace: 'garden'
      }
    }
    hostSecretRef = await getGardenRuntimeClusterSecretRef({ gardenCoreClient })

    bindingKind = 'ClusterRoleBinding'
  } else {
    const shootResource = await shoots.read({ user, namespace, name })
    const seedShootNS = getSeedShootNamespace(shootResource)
    hostNamespace = seedShootNS
    const seedName = shootResource.spec.cloud.seed
    const seed = _.find(getSeeds(), ['metadata.name', seedName])

    kubeApiServer = await getKubeApiServerHost({ user, seed })

    hostSecretRef = _.get(seed, 'spec.secretRef')

    if (target === 'shoot') {
      targetNamespace = undefined // this will create a temporary namespace
      kubecfgCtxNamespaceTargetCluster = 'default'

      targetCredentials = {
        secretRef: {
          name: `${name}.kubeconfig`,
          namespace
        }
      }
      bindingKind = 'ClusterRoleBinding'
    } else { // target cp
      kubecfgCtxNamespaceTargetCluster = seedShootNS
      targetNamespace = seedShootNS

      targetCredentials = {
        secretRef: _.get(seed, 'spec.secretRef')
      }
      bindingKind = 'RoleBinding'
    }
  }

  return { kubeApiServer, hostNamespace, kubecfgCtxNamespaceTargetCluster, targetCredentials, hostSecretRef, bindingKind, targetNamespace }
}

async function createTerminal ({ gardendashboardClient, user, namespace, name, target, context }) {
  const { hostNamespace, kubecfgCtxNamespaceTargetCluster, targetCredentials, bindingKind, targetNamespace, hostSecretRef } = context

  const containerImage = getConfigValue({ path: 'terminal.operator.image' })

  const podLabels = getPodLabels(target)

  const terminalHost = createHost({ namespace: hostNamespace, secretRef: hostSecretRef, containerImage, podLabels })
  const terminalTarget = createTarget({ kubeconfigContextNamespace: kubecfgCtxNamespaceTargetCluster, credentials: targetCredentials, bindingKind, namespace: targetNamespace })

  const labels = {
    'dashboard.gardener.cloud/targetType': target,
    'dashboard.gardener.cloud/targetNamespace': fnv.hash(terminalTarget.kubeconfigContextNamespace, 64).str(),
    'garden.sapcloud.io/createdBy': fnv.hash(user.id, 64).str()
  }
  if (!_.isEmpty(name)) {
    labels['garden.sapcloud.io/name'] = name
  }
  const annotations = {
    'dashboard.gardener.cloud/targetNamespace': terminalTarget.kubeconfigContextNamespace
  }
  const prefix = `term-${target}-`
  const terminalResource = toTerminalResource({ prefix, namespace, annotations, labels, host: terminalHost, target: terminalTarget })

  return gardendashboardClient.ns(namespace).terminals.post({ body: terminalResource })
}

function getPodLabels (target) {
  let labels = {
    'networking.gardener.cloud/to-dns': 'allowed',
    'networking.gardener.cloud/to-public-networks': 'allowed',
    'networking.gardener.cloud/to-private-networks': 'allowed'
  }
  switch (target) {
    case 'garden':
      labels = {} // no network restrictions for now
      break
    case 'cp':
      labels['networking.gardener.cloud/to-seed-apiserver'] = 'allowed'
      break
    case 'shoot':
      labels['networking.gardener.cloud/to-shoot-apiserver'] = 'allowed'
      labels['networking.gardener.cloud/to-shoot-networks'] = 'allowed'
      break
  }
  return labels
}

function createHost ({ secretRef, namespace, containerImage, podLabels }) {
  const temporaryNamespace = _.isEmpty(namespace)
  return {
    credentials: {
      secretRef
    },
    namespace,
    temporaryNamespace,
    pod: {
      labels: podLabels,
      containerImage
    }
  }
}

function createTarget ({ kubeconfigContextNamespace, credentials, bindingKind, namespace }) {
  const temporaryNamespace = _.isEmpty(namespace)
  return {
    credentials,
    kubeconfigContextNamespace,
    bindingKind,
    roleName: 'cluster-admin',
    namespace,
    temporaryNamespace
  }
}

function isTerminalReady (terminal) {
  return !_.isEmpty(_.get(terminal, 'status.podName')) && !_.isEmpty(_.get(terminal, 'status.attachServiceAccountName'))
}

async function readTerminalUntilReady ({ gardendashboardClient, namespace, name }) {
  const conditionFunction = isTerminalReady
  const watch = gardendashboardClient.ns(namespace).terminals.watch({ name })
  return kubernetes.waitUntilResourceHasCondition({ watch, conditionFunction, resourceName: Resources.Terminal.name, waitTimeout: 10 * 1000 })
}

async function getOrCreateTerminalSession ({ user, username, namespace, name, target }) {
  const context = await getContext({ user, namespace, name, target })

  const terminalInfo = {
    container: TERMINAL_CONTAINER_NAME,
    server: context.kubeApiServer
  }

  const gardendashboardClient = Gardendashboard(user)
  const gardenCoreClient = Core(user)

  const hostKubeconfig = await getKubeconfig({ coreClient: gardenCoreClient, ...context.hostSecretRef })
  const hostCoreClient = kubernetes.core(kubernetes.fromKubeconfig(hostKubeconfig))

  const existingTerminal = await findExistingTerminal({ gardendashboardClient, hostCoreClient, username, namespace, name, target })
  if (existingTerminal) {
    _.assign(terminalInfo, existingTerminal)
    return terminalInfo
  }

  logger.debug(`No terminal found for user ${username}. Creating new..`)
  let terminalResource = await createTerminal({ gardendashboardClient, user, namespace, name, target, context })

  terminalResource = await readTerminalUntilReady({ gardendashboardClient, namespace, name: terminalResource.metadata.name })

  const { token } = await readServiceAccountToken({ coreClient: hostCoreClient, namespace: terminalResource.spec.host.namespace, serviceAccountName: terminalResource.status.attachServiceAccountName })

  const pod = terminalResource.status.podName
  _.assign(terminalInfo, {
    pod,
    token,
    namespace: terminalResource.spec.host.namespace
  })
  return terminalInfo
}

function getSeedShootNamespace (shoot) {
  const seedShootNS = _.get(shoot, 'status.technicalID')
  if (_.isEmpty(seedShootNS)) {
    throw new Error(`could not determine namespace in seed for shoot ${shoot.metadata.name}`)
  }
  return seedShootNS
}

function ensureTerminalAllowed ({ isAdmin }) {
  const terminalAllowed = isAdmin
  if (!terminalAllowed) {
    throw new Forbidden('Terminal usage is not allowed')
  }
}

exports.heartbeat = async function ({ user, namespace, name, target }) {
  const isAdmin = await authorization.isAdmin(user)
  const username = user.id

  ensureTerminalAllowed({ isAdmin })

  const gardendashboardClient = Gardendashboard(user)

  const terminal = await findExistingTerminalResource({ gardendashboardClient, username, namespace, name, target })
  if (!terminal) {
    throw new Error(`Can't process heartbeat, cannot find terminal resource for ${namespace}/${name} with target ${target}`)
  }

  const annotations = {
    'dashboard.gardener.cloud/operation': `keepalive`
  }
  try {
    const name = terminal.metadata.name
    await gardendashboardClient.ns(namespace).terminals.mergePatch({ name, body: { metadata: { annotations } } })
  } catch (e) {
    logger.error(`Could not update terminal on heartbeat. Error: ${e}`)
    throw new Error(`Could not update terminal on heartbeat`)
  }
}