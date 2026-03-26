import type { QueueSettings } from "./queue.js";

export type ActiveRunQueueAction = "run-now" | "enqueue-followup" | "drop";

export function resolveActiveRunQueueAction(params: {
  isActive: boolean;
  isHeartbeat: boolean;
  shouldFollowup: boolean;
  queueMode: QueueSettings["mode"];
}): ActiveRunQueueAction {
  if (!params.isActive) {
    return "run-now";
  }
  if (params.isHeartbeat) {
    return "drop";
  }
  // "interrupt" is deprecated and remapped to "collect" upstream, but if it
  // somehow arrives here, enqueue instead of running concurrently.
  if (params.shouldFollowup || params.queueMode === "steer" || params.queueMode === "interrupt") {
    return "enqueue-followup";
  }
  return "run-now";
}
