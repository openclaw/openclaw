export type FollowupQueueDisposition = "queue-cap" | "queue-cap-old" | "queue-cap-new";

/** Resolves whether an active session should run or queue a new inbound turn. */
export function resolveActiveRunQueueAction(params: {
  hasQueuedFollowups?: boolean;
  isActive: boolean;
  shouldFollowup: boolean;
  resetTriggered?: boolean;
  interrupt?: boolean;
}): "run-now" | "enqueue-followup" {
  if (!params.isActive && !params.hasQueuedFollowups) {
    return "run-now";
  }
  if (params.resetTriggered || params.interrupt) {
    return "run-now";
  }
  return params.hasQueuedFollowups || params.shouldFollowup ? "enqueue-followup" : "run-now";
}
