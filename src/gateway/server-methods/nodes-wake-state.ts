// Node wake state tracks APNs wake attempts and reconnect nudges for paired
// nodes, plus a narrow read-only testing seam.
export const NODE_WAKE_RECONNECT_WAIT_MS = 3_000;
export const NODE_WAKE_RECONNECT_RETRY_WAIT_MS = 12_000;
export const NODE_WAKE_RECONNECT_POLL_MS = 150;

export type NodeWakeAttempt = {
  available: boolean;
  throttled: boolean;
  path: "throttled" | "no-registration" | "no-auth" | "sent" | "send-error" | "invalidated";
  durationMs: number;
  apnsStatus?: number;
  apnsReason?: string;
};

export type NodeWakeLifecycle = AbortSignal;

type NodeWakeState = {
  lastWakeAtMs: number;
  inFlight?: Promise<NodeWakeAttempt>;
};

type NodeWakeLifecycleState = {
  controller: AbortController;
  users: number;
};

type NodeWakeLifecycleOwner = {
  nodeId: string;
  stateKey: string;
};

export const nodeWakeByOwner = new Map<string, NodeWakeState>();
export const nodeWakeNudgeByOwner = new Map<string, number>();
const nodeWakeLifecycleByOwner = new Map<string, NodeWakeLifecycleState>();
const nodeWakeLifecycleOwnerBySignal = new WeakMap<NodeWakeLifecycle, NodeWakeLifecycleOwner>();

/** Isolates dedupe and throttle state across durable pairing generations. */
export function nodeWakeStateKey(nodeId: string, pairingGeneration?: string): string {
  return JSON.stringify([nodeId.trim(), pairingGeneration?.trim() || null]);
}

function nodeWakeStateKeyBelongsToNode(stateKey: string, nodeId: string): boolean {
  try {
    const parsed = JSON.parse(stateKey) as unknown;
    return Array.isArray(parsed) && parsed[0] === nodeId;
  } catch {
    return false;
  }
}

export function captureNodeWakeLifecycle(
  nodeId: string,
  pairingGeneration?: string,
): NodeWakeLifecycle {
  const normalizedNodeId = nodeId.trim();
  const stateKey = nodeWakeStateKey(normalizedNodeId, pairingGeneration);
  let lifecycleState = nodeWakeLifecycleByOwner.get(stateKey);
  if (!lifecycleState || lifecycleState.controller.signal.aborted) {
    lifecycleState = { controller: new AbortController(), users: 0 };
    nodeWakeLifecycleByOwner.set(stateKey, lifecycleState);
    nodeWakeLifecycleOwnerBySignal.set(lifecycleState.controller.signal, {
      nodeId: normalizedNodeId,
      stateKey,
    });
  }
  lifecycleState.users += 1;
  nodeWakeByOwner.set(stateKey, nodeWakeByOwner.get(stateKey) ?? { lastWakeAtMs: 0 });
  return lifecycleState.controller.signal;
}

export function isNodeWakeLifecycleCurrent(
  nodeId: string,
  lifecycle: NodeWakeLifecycle,
  pairingGeneration?: string,
): boolean {
  const owner = nodeWakeLifecycleOwnerBySignal.get(lifecycle);
  const expectedStateKey = nodeWakeStateKey(nodeId, pairingGeneration);
  return (
    !lifecycle.aborted &&
    owner?.nodeId === nodeId.trim() &&
    owner.stateKey === expectedStateKey &&
    nodeWakeLifecycleByOwner.get(expectedStateKey)?.controller.signal === lifecycle
  );
}

export function releaseNodeWakeLifecycle(nodeId: string, lifecycle: NodeWakeLifecycle): void {
  const owner = nodeWakeLifecycleOwnerBySignal.get(lifecycle);
  if (owner?.nodeId !== nodeId.trim()) {
    return;
  }
  const lifecycleState = nodeWakeLifecycleByOwner.get(owner.stateKey);
  if (lifecycleState?.controller.signal !== lifecycle) {
    return;
  }
  lifecycleState.users = Math.max(0, lifecycleState.users - 1);
  if (lifecycleState.users > 0) {
    return;
  }

  const wakeState = nodeWakeByOwner.get(owner.stateKey);
  if (wakeState && !wakeState.inFlight && wakeState.lastWakeAtMs === 0) {
    nodeWakeByOwner.delete(owner.stateKey);
  }
  if (nodeWakeByOwner.has(owner.stateKey) || nodeWakeNudgeByOwner.has(owner.stateKey)) {
    return;
  }
  lifecycleState.controller.abort();
  nodeWakeLifecycleByOwner.delete(owner.stateKey);
  nodeWakeLifecycleOwnerBySignal.delete(lifecycle);
}

export function clearNodeWakeState(nodeId: string): void {
  const normalizedNodeId = nodeId.trim();
  for (const stateKey of nodeWakeByOwner.keys()) {
    if (nodeWakeStateKeyBelongsToNode(stateKey, normalizedNodeId)) {
      nodeWakeByOwner.delete(stateKey);
    }
  }
  for (const stateKey of nodeWakeNudgeByOwner.keys()) {
    if (nodeWakeStateKeyBelongsToNode(stateKey, normalizedNodeId)) {
      nodeWakeNudgeByOwner.delete(stateKey);
    }
  }
  for (const [stateKey, lifecycleState] of nodeWakeLifecycleByOwner) {
    if (nodeWakeStateKeyBelongsToNode(stateKey, normalizedNodeId) && lifecycleState.users === 0) {
      lifecycleState.controller.abort();
      nodeWakeLifecycleByOwner.delete(stateKey);
      nodeWakeLifecycleOwnerBySignal.delete(lifecycleState.controller.signal);
    }
  }
}

export function invalidateNodeWakeState(nodeId: string): void {
  const normalizedNodeId = nodeId.trim();
  for (const [stateKey, lifecycleState] of nodeWakeLifecycleByOwner) {
    if (!nodeWakeStateKeyBelongsToNode(stateKey, normalizedNodeId)) {
      continue;
    }
    lifecycleState.controller.abort();
    nodeWakeLifecycleByOwner.delete(stateKey);
    nodeWakeLifecycleOwnerBySignal.delete(lifecycleState.controller.signal);
  }
  for (const stateKey of nodeWakeByOwner.keys()) {
    if (nodeWakeStateKeyBelongsToNode(stateKey, normalizedNodeId)) {
      nodeWakeByOwner.delete(stateKey);
    }
  }
  for (const stateKey of nodeWakeNudgeByOwner.keys()) {
    if (nodeWakeStateKeyBelongsToNode(stateKey, normalizedNodeId)) {
      nodeWakeNudgeByOwner.delete(stateKey);
    }
  }
}
