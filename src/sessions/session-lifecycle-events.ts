/**
 * Structured info surfaced when reason === "subagent-delivery-failed".
 * Attached so the requester can decide how to recover — e.g. read the child
 * transcript at `sessionKey` — instead of silently hanging on a lost announce.
 */
export type SubagentDeliveryFailureInfo = {
  runId: string;
  taskName?: string;
  giveUpReason: "retry-limit" | "expiry";
  finalStatus?: "ok" | "error" | "timeout" | "killed";
  deliveryError?: string;
};

/** Session lifecycle event broadcast to observers when a session is created or linked. */
export type SessionLifecycleEvent = {
  sessionKey: string;
  reason: string;
  parentSessionKey?: string;
  label?: string;
  displayName?: string;
  /**
   * Populated when reason === "subagent-delivery-failed" — the subagent
   * completed but every announce delivery attempt failed. Requester should
   * read the child transcript at `sessionKey` to surface the outcome.
   */
  deliveryFailure?: SubagentDeliveryFailureInfo;
};

type SessionLifecycleListener = (event: SessionLifecycleEvent) => void;

const SESSION_LIFECYCLE_LISTENERS = new Set<SessionLifecycleListener>();

/** Registers a session lifecycle listener. */
export function onSessionLifecycleEvent(listener: SessionLifecycleListener): () => void {
  SESSION_LIFECYCLE_LISTENERS.add(listener);
  return () => {
    SESSION_LIFECYCLE_LISTENERS.delete(listener);
  };
}

/** Emits a best-effort session lifecycle event to all listeners. */
export function emitSessionLifecycleEvent(event: SessionLifecycleEvent): void {
  for (const listener of SESSION_LIFECYCLE_LISTENERS) {
    try {
      listener(event);
    } catch {
      // Best-effort, do not propagate listener errors.
    }
  }
}
