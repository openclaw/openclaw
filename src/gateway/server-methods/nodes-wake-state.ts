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
  lifecycleController?: AbortController;
};

export const nodeWakeById = new Map<string, NodeWakeState>();
export const nodeWakeNudgeById = new Map<string, number>();

export function captureNodeWakeLifecycle(nodeId: string): NodeWakeLifecycle {
  const state = nodeWakeById.get(nodeId) ?? { lastWakeAtMs: 0 };
  if (!state.lifecycleController || state.lifecycleController.signal.aborted) {
    state.lifecycleController = new AbortController();
  }
  nodeWakeById.set(nodeId, state);
  return state.lifecycleController.signal;
}

export function isNodeWakeLifecycleCurrent(nodeId: string, lifecycle: NodeWakeLifecycle): boolean {
  return !lifecycle.aborted && nodeWakeById.get(nodeId)?.lifecycleController?.signal === lifecycle;
}

export function releaseNodeWakeLifecycleIfIdle(nodeId: string, lifecycle: NodeWakeLifecycle): void {
  const state = nodeWakeById.get(nodeId);
  if (
    state?.lifecycleController?.signal !== lifecycle ||
    state.inFlight ||
    state.lastWakeAtMs !== 0
  ) {
    return;
  }
  state.lifecycleController.abort();
  nodeWakeById.delete(nodeId);
}

export function clearNodeWakeState(nodeId: string): void {
  nodeWakeById.get(nodeId)?.lifecycleController?.abort();
  nodeWakeById.delete(nodeId);
  nodeWakeNudgeById.delete(nodeId);
}
