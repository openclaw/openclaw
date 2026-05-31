/** Time to wait for a node to reconnect after a successful wake send. */
export const NODE_WAKE_RECONNECT_WAIT_MS = 3_000;
/** Longer wait after retrying a wake for an already nudged node. */
export const NODE_WAKE_RECONNECT_RETRY_WAIT_MS = 12_000;
/** Poll interval while waiting for a woken node to reconnect. */
export const NODE_WAKE_RECONNECT_POLL_MS = 150;

/** Summary of one push/nudge attempt used by node invocation wake logic. */
export type NodeWakeAttempt = {
  available: boolean;
  throttled: boolean;
  path: "throttled" | "no-registration" | "no-auth" | "sent" | "send-error";
  durationMs: number;
  apnsStatus?: number;
  apnsReason?: string;
};

type NodeWakeState = {
  lastWakeAtMs: number;
  inFlight?: Promise<NodeWakeAttempt>;
};

export const nodeWakeById = new Map<string, NodeWakeState>();
export const nodeWakeNudgeById = new Map<string, number>();

/** Clear all wake bookkeeping for a node after reconnect, failure, or test cleanup. */
export function clearNodeWakeState(nodeId: string): void {
  nodeWakeById.delete(nodeId);
  nodeWakeNudgeById.delete(nodeId);
}

// Narrow read-only seam for tests that assert nodeWakeById is cleaned up on
// early-return paths. Mirrors the pattern used in agent-wait-dedupe.ts:223
// and agents.ts:78 — keep production surface untouched and do not expose the
// underlying Map reference.
export const testing = {
  getNodeWakeByIdSize(): number {
    return nodeWakeById.size;
  },
  hasNodeWakeEntry(nodeId: string): boolean {
    return nodeWakeById.has(nodeId);
  },
  resetWakeState(): void {
    nodeWakeById.clear();
    nodeWakeNudgeById.clear();
  },
};
export { testing as __testing };
