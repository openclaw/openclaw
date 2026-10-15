/** Queue decisions for messages that arrive while an agent run is active. */
export type ActiveRunQueueAction = "run-now" | "enqueue-followup";

/** Resolves whether an active session should run or queue a new inbound turn. */
export function resolveActiveRunQueueAction(params: {
  hasQueuedFollowups?: boolean;
  isActive: boolean;
  shouldFollowup: boolean;
  resetTriggered?: boolean;
}): ActiveRunQueueAction {
  if (!params.isActive && !params.hasQueuedFollowups) {
    return "run-now";
  }
  if (params.resetTriggered) {
    return "run-now";
  }
  return params.hasQueuedFollowups || params.shouldFollowup ? "enqueue-followup" : "run-now";
}
