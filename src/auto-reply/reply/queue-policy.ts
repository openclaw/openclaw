// Resolves queue mode and admission policy for a reply turn.
/** Queue decisions for messages that arrive while an agent run is active. */
export type ActiveRunQueueAction = "run-now" | "enqueue-followup" | "drop";

/** Resolves whether an active session should run, queue, or drop a new inbound turn. */
export function resolveActiveRunQueueAction(params: {
  hasQueuedFollowups?: boolean;
  isActive: boolean;
  isHeartbeat: boolean;
  shouldFollowup: boolean;
  resetTriggered?: boolean;
}): ActiveRunQueueAction {
  if (!params.isActive && !params.hasQueuedFollowups) {
    return "run-now";
  }
  if (params.isHeartbeat) {
    return "drop";
  }
  if (params.resetTriggered) {
    return "run-now";
  }
  if (params.hasQueuedFollowups) {
    return "enqueue-followup";
  }
  // Follow-up queueing is only meaningful for non-heartbeat user turns.
  if (params.shouldFollowup) {
    return "enqueue-followup";
  }
  return "run-now";
}
