import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import {
  formatNodeRunnerUpdateRequired,
  NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
  NODE_WORKER_PREPARED_WORKSPACE_VERSION,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  resolveNodeWorkerExecutionIssue,
  type NodeRunnerInventoryIssue,
  type NodeWorkerHostDeclaration,
  type NodeWorkerCapacitySnapshot,
} from "../infra/node-runner-inventory.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { NodeWorkerBundleStatus } from "../shared/node-list-types.js";

type NodeWorkerHostClientId =
  | typeof GATEWAY_CLIENT_IDS.NODE_HOST
  | typeof GATEWAY_CLIENT_IDS.MACOS_APP;

/** Both first-party hosts run the shared node runtime without changing client identity. */
export function isNodeWorkerHostClientId(
  clientId: string | undefined,
): clientId is NodeWorkerHostClientId {
  return clientId === GATEWAY_CLIENT_IDS.NODE_HOST || clientId === GATEWAY_CLIENT_IDS.MACOS_APP;
}

export type NodeWorkerBundleStatusObservation = {
  bundleHash: string;
  status: NodeWorkerBundleStatus;
};

export function sameBundleStatusObservation(
  left: NodeWorkerBundleStatusObservation | undefined,
  right: NodeWorkerBundleStatusObservation | undefined,
): boolean {
  return (
    left?.bundleHash === right?.bundleHash &&
    left?.status.status === right?.status.status &&
    (left?.status.status !== "installed" ||
      (right?.status.status === "installed" && left.status.version === right.status.version))
  );
}

export type NodeRunnerRegistrySession = {
  nodeId: string;
  connId: string;
  pairingIdentity?: string;
  pairingGeneration?: string;
  client: { invalidated?: boolean };
  clientId?: string;
  clientMode?: string;
  commands: string[];
};

export type NodeWorkerSupervisorNodeProof = {
  nodeId: string;
  connId: string;
  pairingIdentity: string;
  pairingGeneration: string;
  clientId: NodeWorkerHostClientId;
  clientMode: "node";
  protocolFeature: typeof NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE;
  workerHost: Extract<NodeWorkerHostDeclaration, { enabled: true }>;
  commands: readonly string[];
};

export type NodeRunnerInventoryRecord = Omit<
  NodeWorkerSupervisorNodeProof,
  "commands" | "pairingGeneration" | "protocolFeature" | "workerHost"
> & {
  pairingGeneration?: string;
  protocolFeatures: readonly string[];
  workerHost?: NodeWorkerHostDeclaration;
};

export type NodeRunnerStateChange = {
  inventoryChanged: boolean;
  availabilityChanged: boolean;
};

export function createNodeRunnerStatePublisher(
  getNode: (nodeId: string) => NodeRunnerRegistrySession | undefined,
  runnerInventoryByConn: ReadonlyMap<string, NodeRunnerInventoryRecord>,
) {
  // Availability is an edge over the last published proof, not an inventory mutation alias.
  const availableNodeIds = new Set<string>();
  const observers = new Map<string, Set<() => void>>();
  let listener = (_nodeId: string, _change: NodeRunnerStateChange) => {};
  const hasCurrent = (nodeId: string) => {
    const node = getNode(nodeId);
    return Boolean(
      node &&
      node.client.invalidated !== true &&
      resolveNodeWorkerSupervisorProof(node, runnerInventoryByConn),
    );
  };
  return {
    hasCurrent,
    reconcile: (nodeId: string, inventoryChanged: boolean) => {
      const available = hasCurrent(nodeId);
      const availabilityChanged = availableNodeIds.has(nodeId) !== available;
      if (available) {
        availableNodeIds.add(nodeId);
      } else {
        availableNodeIds.delete(nodeId);
      }
      if (inventoryChanged || availabilityChanged) {
        for (const notify of observers.get(nodeId) ?? []) {
          notify();
        }
        listener(nodeId, { inventoryChanged, availabilityChanged });
      }
    },
    setListener: (next: typeof listener) => {
      listener = next;
    },
    subscribe: (nodeId: string, notify: () => void) => {
      const listeners = observers.get(nodeId) ?? new Set();
      listeners.add(notify);
      observers.set(nodeId, listeners);
      return () => {
        listeners.delete(notify);
        if (listeners.size === 0) {
          observers.delete(nodeId);
        }
      };
    },
  };
}

export type NodeRunnerStatePublisher = ReturnType<typeof createNodeRunnerStatePublisher>;

/** Availability wakes admission; only a freshly read pairing-bound proof completes the wait. */
export async function waitForNodeRunnerAvailability(
  publisher: NodeRunnerStatePublisher,
  transport: {
    getCurrentNode: (nodeId: string) => Promise<NodeWorkerSupervisorNodeProof | undefined>;
    isCurrent: (node: NodeWorkerSupervisorNodeProof) => boolean;
    getIssue?: (nodeId: string) => NodeRunnerInventoryIssue | undefined;
  },
  nodeId: string,
  options: { signal: AbortSignal; assertCurrent: () => void },
): Promise<void> {
  let changed = createDeferredCore();
  const unsubscribe = publisher.subscribe(nodeId, () => changed.resolve());
  const assertCurrent = () => {
    options.signal.throwIfAborted();
    options.assertCurrent();
  };
  try {
    for (;;) {
      assertCurrent();
      const node = await racePromiseWithAbortSignal(
        transport.getCurrentNode(nodeId),
        options.signal,
      );
      assertCurrent();
      if (node && transport.isCurrent(node)) {
        return;
      }
      const issue = transport.getIssue?.(nodeId);
      if (issue) {
        throw new Error(formatNodeRunnerUpdateRequired(nodeId, issue));
      }
      await racePromiseWithAbortSignal(changed.promise, options.signal);
      changed = createDeferredCore();
    }
  } finally {
    unsubscribe();
  }
}

/** Project current connection facts without pairing reads, publications, or execution admission. */
export function collectNodeRunnerCatalogState(params: {
  connectedNodes: ReadonlyArray<
    Pick<NodeRunnerRegistrySession, "nodeId" | "connId" | "pairingGeneration">
  >;
  requireWorkerExecution: boolean;
  state?: {
    getNode: (nodeId: string) => NodeRunnerRegistrySession | undefined;
    runnerInventoryByConn: ReadonlyMap<string, NodeRunnerInventoryRecord>;
    bundleStatusByConn: ReadonlyMap<string, NodeWorkerBundleStatusObservation>;
  };
}) {
  const sessionHostNodeIds = new Set<string>();
  const issuesByNodeId = new Map<string, NodeRunnerInventoryIssue[]>();
  const workerSlotsByNodeId = new Map<string, NodeWorkerCapacitySnapshot>();
  const workerBundleByNodeId = new Map<string, NodeWorkerBundleStatus>();
  const { state } = params;
  for (const node of params.connectedNodes) {
    const current = state?.getNode(node.nodeId);
    if (!state || !current || current.connId !== node.connId) {
      continue;
    }
    const proof = resolveNodeWorkerSupervisorProof(current, state.runnerInventoryByConn);
    if (proof && proof.pairingGeneration === node.pairingGeneration) {
      sessionHostNodeIds.add(node.nodeId);
    }
    const issue =
      resolveNodeRunnerInventoryIssue(current, state.runnerInventoryByConn) ??
      (params.requireWorkerExecution && proof
        ? resolveNodeWorkerExecutionIssue(proof.workerHost)
        : undefined);
    if (issue) {
      issuesByNodeId.set(node.nodeId, [issue]);
    }
    if (proof) {
      workerSlotsByNodeId.set(node.nodeId, { ...proof.workerHost.capacity });
    }
    const observation = state.bundleStatusByConn.get(node.connId);
    if (observation) {
      workerBundleByNodeId.set(node.nodeId, structuredClone(observation.status));
    }
  }
  return { sessionHostNodeIds, issuesByNodeId, workerSlotsByNodeId, workerBundleByNodeId };
}

export function sameNodeWorkerHostDeclaration(
  left: NodeWorkerHostDeclaration | undefined,
  right: NodeWorkerHostDeclaration | undefined,
): boolean {
  return (
    left?.enabled === right?.enabled &&
    (left?.enabled !== true ||
      (right?.enabled === true &&
        left.capacity.total === right.capacity.total &&
        left.capacity.available === right.capacity.available &&
        left.bundlePrewarm === right.bundlePrewarm &&
        left.bundleRetention === right.bundleRetention &&
        left.bundleStatus === right.bundleStatus &&
        left.portalStream === right.portalStream &&
        left.environmentSession === right.environmentSession &&
        left.preparedWorkspace === right.preparedWorkspace &&
        left.capturedExecPolicy === right.capturedExecPolicy))
  );
}

export function resolveNodeWorkerSupervisorProof(
  node: NodeRunnerRegistrySession,
  runnerInventoryByConn: ReadonlyMap<string, NodeRunnerInventoryRecord>,
): NodeWorkerSupervisorNodeProof | undefined {
  const declaration = runnerInventoryByConn.get(node.connId);
  if (
    !declaration ||
    !node.pairingIdentity ||
    !node.pairingGeneration ||
    !isNodeWorkerHostClientId(node.clientId) ||
    node.clientMode !== "node" ||
    declaration.nodeId !== node.nodeId ||
    declaration.pairingIdentity !== node.pairingIdentity ||
    declaration.pairingGeneration !== node.pairingGeneration ||
    declaration.clientId !== node.clientId ||
    declaration.clientMode !== node.clientMode ||
    !declaration.protocolFeatures.includes(NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE) ||
    declaration.workerHost?.enabled !== true
  ) {
    return undefined;
  }
  return {
    nodeId: node.nodeId,
    connId: node.connId,
    pairingIdentity: node.pairingIdentity,
    pairingGeneration: node.pairingGeneration,
    clientId: node.clientId,
    clientMode: "node",
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: {
      ...declaration.workerHost,
      capacity: { ...declaration.workerHost.capacity },
    },
    commands: [...node.commands],
  };
}

export function resolveNodeRunnerInventoryIssue(
  node: NodeRunnerRegistrySession,
  runnerInventoryByConn: ReadonlyMap<string, NodeRunnerInventoryRecord>,
): NodeRunnerInventoryIssue | undefined {
  const declaration = runnerInventoryByConn.get(node.connId);
  return declaration &&
    node.client.invalidated !== true &&
    declaration.nodeId === node.nodeId &&
    declaration.pairingIdentity === node.pairingIdentity &&
    declaration.pairingGeneration !== undefined &&
    declaration.pairingGeneration === node.pairingGeneration &&
    isNodeWorkerHostClientId(node.clientId) &&
    declaration.clientId === node.clientId &&
    node.clientMode === "node" &&
    declaration.clientMode === "node" &&
    declaration.protocolFeatures.length === 1 &&
    declaration.protocolFeatures[0] !== NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE
    ? NODE_RUNNER_UPDATE_REQUIRED_ISSUE
    : undefined;
}

export function isNodeWorkerSupervisorProofCurrent(
  node: NodeRunnerRegistrySession | undefined,
  runnerInventoryByConn: ReadonlyMap<string, NodeRunnerInventoryRecord>,
  proof: NodeWorkerSupervisorNodeProof,
  requirements: {
    launchEligibility?: boolean;
    commands?: readonly string[];
    environmentSession?: boolean;
    preparedWorkspace?: boolean;
    capturedExecPolicy?: boolean;
  } = {},
): boolean {
  if (!node || node.client.invalidated === true || node.connId !== proof.connId) {
    return false;
  }
  const current = resolveNodeWorkerSupervisorProof(node, runnerInventoryByConn);
  return (
    current?.pairingIdentity === proof.pairingIdentity &&
    current.pairingGeneration === proof.pairingGeneration &&
    current.clientId === proof.clientId &&
    current.clientMode === proof.clientMode &&
    current.protocolFeature === proof.protocolFeature &&
    (!requirements.launchEligibility || current.workerHost.capacity.available > 0) &&
    (!requirements.environmentSession ||
      current.workerHost.environmentSession === NODE_WORKER_ENVIRONMENT_SESSION_VERSION) &&
    (!requirements.preparedWorkspace ||
      current.workerHost.preparedWorkspace === NODE_WORKER_PREPARED_WORKSPACE_VERSION) &&
    (!requirements.capturedExecPolicy || !resolveNodeWorkerExecutionIssue(current.workerHost)) &&
    (requirements.commands ?? []).every((command) => current.commands.includes(command))
  );
}
