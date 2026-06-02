/** Initial reconnect grace period after sending a mobile/node wake signal. */
export const NODE_WAKE_RECONNECT_WAIT_MS = 3_000;
/** Longer retry window used after the first wake attempt did not reconnect. */
export const NODE_WAKE_RECONNECT_RETRY_WAIT_MS = 12_000;
/** Poll cadence while waiting for a woken node to reconnect. */
export const NODE_WAKE_RECONNECT_POLL_MS = 150;

export type NodeWakeAttempt = {
  /** True when the target node was available or became reachable during wake handling. */
  available: boolean;
  /** True when throttling prevented a new wake send. */
  throttled: boolean;
  /** Stable path code used by logs/tests to distinguish wake outcomes. */
  path: "throttled" | "no-registration" | "no-auth" | "sent" | "send-error";
  /** End-to-end wake handling duration, including reconnect wait time. */
  durationMs: number;
  /** APNS provider status for sent wake attempts, when available. */
  apnsStatus?: number;
  /** APNS provider reason string for rejected wake attempts, when available. */
  apnsReason?: string;
};

type NodeWakeState = {
  lastWakeAtMs: number;
  inFlight?: Promise<NodeWakeAttempt>;
};

export const nodeWakeById = new Map<string, NodeWakeState>();
export const nodeWakeNudgeById = new Map<string, number>();

/** Clears coalescing/throttle state when a node disconnect lifecycle is complete. */
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
