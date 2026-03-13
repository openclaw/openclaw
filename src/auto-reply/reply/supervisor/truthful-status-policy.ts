import type { QueueMode } from "../queue.js";

export type TruthfulEarlyStatusDecision = {
  shouldEmit: boolean;
  reason: string;
};

export function decideTruthfulEarlyStatus(params: {
  queueMode: QueueMode;
  isActive: boolean;
  isHeartbeat: boolean;
  isExternallyRoutable: boolean;
  isStreaming: boolean;
}): TruthfulEarlyStatusDecision {
  if (!params.isExternallyRoutable) {
    return {
      shouldEmit: false,
      reason: "non_routable_delivery",
    };
  }
  if (params.isHeartbeat) {
    return {
      shouldEmit: false,
      reason: "heartbeat_runs_do_not_emit_user_status",
    };
  }
  if (!params.isActive) {
    return {
      shouldEmit: false,
      reason: "no_active_run_to_acknowledge",
    };
  }

  switch (params.queueMode) {
    case "interrupt":
      return {
        shouldEmit: true,
        reason: "replacement_of_active_foreground_task_is_user_visible",
      };
    case "steer":
    case "steer-backlog":
      return {
        shouldEmit: true,
        reason: "same_task_correction_should_acknowledge_direction_change",
      };
    case "followup":
    case "collect":
      return {
        shouldEmit: true,
        reason: "same_task_supplement_should_acknowledge_new_material",
      };
    case "queue":
      return {
        shouldEmit: false,
        reason: params.isStreaming
          ? "defer_semantics_are_not_truthful_while_active_run_keeps_foreground_progress"
          : "defer_path_not_yet_modeled_as_truthful_early_status",
      };
  }
}
