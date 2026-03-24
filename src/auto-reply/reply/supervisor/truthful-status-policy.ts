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

export type TruthfulEarlyStatusGuidance = {
  focus:
    | "expand_active_run_status"
    | "tighten_semantic_contract"
    | "optimize_other_bottlenecks"
    | "observe_more_samples";
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

  if (
    recommendation.level === "prioritize" &&
    (params.queueMode === "followup" || params.queueMode === "collect")
  ) {
    return {
      shouldEmit: true,
      reason: "phase2_supplement_status_enabled_for_visible_silence_reduction",
      decision,
      recommendation,
    };
  }

  if (recommendation.level === "prioritize") {
    return {
      shouldEmit: false,
      reason: "phase2_not_enabled_for_correction_or_parallel_status_yet",
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

export function buildTruthfulEarlyStatusGuidance(params: {
  recommendation: TruthfulEarlyStatusRecommendation;
  summary?: {
    sampleCount: number;
    eligibleCount: number;
    semanticGateCount: number;
    latencyGateCount: number;
  };
}): TruthfulEarlyStatusGuidance {
  const summary = params.summary;
  if (!summary || summary.sampleCount < 3) {
    return {
      focus: "observe_more_samples",
      reason: "not_enough_recent_policy_samples_to_change_behavior_confidently",
    };
  }

  if (params.recommendation.level === "deprioritize") {
    return {
      focus: "optimize_other_bottlenecks",
      reason:
        "first_visible_feedback_already_arrives_early_enough_that_extra_status_would_be_noise",
    };
  }

  if (params.recommendation.level === "observe") {
    return {
      focus: "optimize_other_bottlenecks",
      reason: "dominant_latency_is_not_currently_in_the_visible_silence_window",
    };
  }

  if (
    summary.semanticGateCount > summary.latencyGateCount &&
    summary.semanticGateCount >= summary.eligibleCount
  ) {
    return {
      focus: "tighten_semantic_contract",
      reason: "most_recent_candidates_are_still_blocked_by_truthful_semantics",
    };
  }

  if (summary.latencyGateCount > 0) {
    return {
      focus: "expand_active_run_status",
      reason: "recent_candidates_are_primarily_waiting_on_latency_priority_rather_than_semantics",
    };
  }

  return {
    focus: "observe_more_samples",
    reason:
      "current_policy_is_already_emitting_for_recent_candidates_without_clear_pressure_to_expand",
  };
}
