import type { QueueMode } from "../queue.js";

export type TruthfulEarlyStatusDecision = {
  shouldEmit: boolean;
  reason: string;
};

export type TruthfulEarlyStatusLatencySegment =
  | "dispatchToQueue"
  | "queueToRun"
  | "acpEnsureToRun"
  | "runToFirstEvent"
  | "firstEventToFirstVisible"
  | "runToFirstVisible"
  | "firstVisibleToFinal"
  | "endToEnd";

export type TruthfulEarlyStatusRecommendation = {
  level: "prioritize" | "observe" | "deprioritize";
  reason: string;
};

export type TruthfulEarlyStatusActivation = {
  shouldEmit: boolean;
  reason: string;
  decision: TruthfulEarlyStatusDecision;
  recommendation: TruthfulEarlyStatusRecommendation;
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

export function recommendTruthfulEarlyStatusFromLatency(params: {
  dominantSegments?: Array<{
    segment: TruthfulEarlyStatusLatencySegment;
    count: number;
  }>;
}): TruthfulEarlyStatusRecommendation {
  const top = params.dominantSegments?.[0];
  if (!top) {
    return {
      level: "observe",
      reason: "no_dominant_latency_pattern_yet",
    };
  }

  switch (top.segment) {
    case "firstEventToFirstVisible":
    case "runToFirstVisible":
      return {
        level: "prioritize",
        reason: "runtime_started_but_visible_feedback_arrives_late",
      };
    case "dispatchToQueue":
    case "queueToRun":
    case "acpEnsureToRun":
    case "runToFirstEvent":
      return {
        level: "observe",
        reason: "latency_is_dominant_before_visible_feedback_is_semantically_decidable",
      };
    case "firstVisibleToFinal":
      return {
        level: "deprioritize",
        reason: "users_already_have_visible_feedback_so_extra_status_would_be_noise",
      };
    case "endToEnd":
      return {
        level: "observe",
        reason: "end_to_end_is_high_without_a_specific_actionable_bottleneck",
      };
  }
}

export function evaluateTruthfulEarlyStatusActivation(params: {
  queueMode: QueueMode;
  isActive: boolean;
  isHeartbeat: boolean;
  isExternallyRoutable: boolean;
  isStreaming: boolean;
  dominantSegments?: Array<{
    segment: TruthfulEarlyStatusLatencySegment;
    count: number;
  }>;
}): TruthfulEarlyStatusActivation {
  const decision = decideTruthfulEarlyStatus(params);
  const recommendation = recommendTruthfulEarlyStatusFromLatency({
    dominantSegments: params.dominantSegments,
  });

  if (!decision.shouldEmit) {
    return {
      shouldEmit: false,
      reason: decision.reason,
      decision,
      recommendation,
    };
  }

  if (params.queueMode === "interrupt") {
    return {
      shouldEmit: true,
      reason: "replacement_of_active_task_is_prioritized_even_without_latency_signal",
      decision,
      recommendation,
    };
  }

  if (recommendation.level === "prioritize") {
    return {
      shouldEmit: true,
      reason: "latency_pattern_indicates_a_truthful_status_would_reduce_visible_silence",
      decision,
      recommendation,
    };
  }

  return {
    shouldEmit: false,
    reason: `latency_priority_${recommendation.level}`,
    decision,
    recommendation,
  };
}
