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

export const nodeWakeById = new Map<string, NodeWakeState>();
export const nodeWakeNudgeById = new Map<string, number>();
const nodeWakeLifecycleById = new Map<string, NodeWakeLifecycleState>();

export function captureNodeWakeLifecycle(nodeId: string): NodeWakeLifecycle {
  let lifecycleState = nodeWakeLifecycleById.get(nodeId);
  if (!lifecycleState || lifecycleState.controller.signal.aborted) {
    lifecycleState = { controller: new AbortController(), users: 0 };
    nodeWakeLifecycleById.set(nodeId, lifecycleState);
  }
  lifecycleState.users += 1;
  nodeWakeById.set(nodeId, nodeWakeById.get(nodeId) ?? { lastWakeAtMs: 0 });
  return lifecycleState.controller.signal;
}

export function isNodeWakeLifecycleCurrent(nodeId: string, lifecycle: NodeWakeLifecycle): boolean {
  return !lifecycle.aborted && nodeWakeLifecycleById.get(nodeId)?.controller.signal === lifecycle;
}

export function releaseNodeWakeLifecycle(nodeId: string, lifecycle: NodeWakeLifecycle): void {
  const lifecycleState = nodeWakeLifecycleById.get(nodeId);
  if (lifecycleState?.controller.signal !== lifecycle) {
    return;
  }
  lifecycleState.users = Math.max(0, lifecycleState.users - 1);
  if (lifecycleState.users > 0) {
    return;
  }

  const wakeState = nodeWakeById.get(nodeId);
  if (wakeState && !wakeState.inFlight && wakeState.lastWakeAtMs === 0) {
    nodeWakeById.delete(nodeId);
  }
  if (nodeWakeById.has(nodeId) || nodeWakeNudgeById.has(nodeId)) {
    return;
  }
  lifecycleState.controller.abort();
  nodeWakeLifecycleById.delete(nodeId);
}

export function clearNodeWakeState(nodeId: string): void {
  nodeWakeById.delete(nodeId);
  nodeWakeNudgeById.delete(nodeId);
  const lifecycleState = nodeWakeLifecycleById.get(nodeId);
  if (lifecycleState && lifecycleState.users === 0) {
    lifecycleState.controller.abort();
    nodeWakeLifecycleById.delete(nodeId);
  }
}

export function invalidateNodeWakeState(nodeId: string): void {
  nodeWakeLifecycleById.get(nodeId)?.controller.abort();
  nodeWakeLifecycleById.delete(nodeId);
  nodeWakeById.delete(nodeId);
  nodeWakeNudgeById.delete(nodeId);
}
