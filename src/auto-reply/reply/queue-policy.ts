import type { QueueSettings } from "./queue.js";

export type ActiveRunQueueAction = "run-now" | "enqueue-followup" | "drop";

export function resolveActiveRunQueueAction(params: {
  isActive: boolean;
  hasQueuedFollowups: boolean;
  isHeartbeat: boolean;
  shouldFollowup: boolean;
  queueMode: QueueSettings["mode"];
}): ActiveRunQueueAction {
  const queueBusy = params.isActive || params.hasQueuedFollowups;
  if (!queueBusy) {
    return "run-now";
  }
  if (params.isHeartbeat) {
    return "drop";
  }
  if (params.shouldFollowup || params.queueMode === "steer") {
    return "enqueue-followup";
  }
  return "run-now";
}
