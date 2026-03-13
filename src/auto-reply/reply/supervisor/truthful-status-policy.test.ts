import { describe, expect, it } from "vitest";
import {
  buildTruthfulEarlyStatusGuidance,
  decideTruthfulEarlyStatus,
  evaluateTruthfulEarlyStatusActivation,
  recommendTruthfulEarlyStatusFromLatency,
} from "./truthful-status-policy.js";

describe("decideTruthfulEarlyStatus", () => {
  it("allows interrupt for active externally routable runs", () => {
    expect(
      decideTruthfulEarlyStatus({
        queueMode: "interrupt",
        isActive: true,
        isHeartbeat: false,
        isExternallyRoutable: true,
        isStreaming: true,
      }),
    ).toEqual({
      shouldEmit: true,
      reason: "replacement_of_active_foreground_task_is_user_visible",
    });
  });

  it("allows steer and supplement modes for active externally routable runs", () => {
    expect(
      decideTruthfulEarlyStatus({
        queueMode: "steer",
        isActive: true,
        isHeartbeat: false,
        isExternallyRoutable: true,
        isStreaming: true,
      }).shouldEmit,
    ).toBe(true);
    expect(
      decideTruthfulEarlyStatus({
        queueMode: "collect",
        isActive: true,
        isHeartbeat: false,
        isExternallyRoutable: true,
        isStreaming: false,
      }).shouldEmit,
    ).toBe(true);
  });

  it("suppresses defer until runtime semantics become truthful", () => {
    expect(
      decideTruthfulEarlyStatus({
        queueMode: "queue",
        isActive: true,
        isHeartbeat: false,
        isExternallyRoutable: true,
        isStreaming: true,
      }),
    ).toEqual({
      shouldEmit: false,
      reason: "defer_semantics_are_not_truthful_while_active_run_keeps_foreground_progress",
    });
  });

  it("suppresses non-routable, inactive, and heartbeat turns", () => {
    expect(
      decideTruthfulEarlyStatus({
        queueMode: "interrupt",
        isActive: true,
        isHeartbeat: false,
        isExternallyRoutable: false,
        isStreaming: true,
      }).reason,
    ).toBe("non_routable_delivery");
    expect(
      decideTruthfulEarlyStatus({
        queueMode: "interrupt",
        isActive: false,
        isHeartbeat: false,
        isExternallyRoutable: true,
        isStreaming: true,
      }).reason,
    ).toBe("no_active_run_to_acknowledge");
    expect(
      decideTruthfulEarlyStatus({
        queueMode: "interrupt",
        isActive: true,
        isHeartbeat: true,
        isExternallyRoutable: true,
        isStreaming: true,
      }).reason,
    ).toBe("heartbeat_runs_do_not_emit_user_status");
  });

  it("prioritizes early status work when visible feedback lags behind runtime start", () => {
    expect(
      recommendTruthfulEarlyStatusFromLatency({
        dominantSegments: [{ segment: "runToFirstVisible", count: 4 }],
      }),
    ).toEqual({
      level: "prioritize",
      reason: "runtime_started_but_visible_feedback_arrives_late",
    });
  });

  it("deprioritizes early status when the bottleneck is after first visible output", () => {
    expect(
      recommendTruthfulEarlyStatusFromLatency({
        dominantSegments: [{ segment: "firstVisibleToFinal", count: 3 }],
      }),
    ).toEqual({
      level: "deprioritize",
      reason: "users_already_have_visible_feedback_so_extra_status_would_be_noise",
    });
  });

  it("keeps pre-visible orchestration bottlenecks in observe mode", () => {
    expect(
      recommendTruthfulEarlyStatusFromLatency({
        dominantSegments: [{ segment: "runToFirstEvent", count: 2 }],
      }),
    ).toEqual({
      level: "observe",
      reason: "latency_is_dominant_before_visible_feedback_is_semantically_decidable",
    });
  });

  it("activates collect when latency signals a first-visible silence problem", () => {
    expect(
      evaluateTruthfulEarlyStatusActivation({
        queueMode: "collect",
        isActive: true,
        isHeartbeat: false,
        isExternallyRoutable: true,
        isStreaming: true,
        dominantSegments: [{ segment: "runToFirstVisible", count: 2 }],
      }),
    ).toMatchObject({
      shouldEmit: true,
      reason: "phase2_supplement_status_enabled_for_visible_silence_reduction",
      recommendation: {
        level: "prioritize",
      },
    });
  });

  it("keeps steer disabled until phase-2 expands beyond supplements", () => {
    expect(
      evaluateTruthfulEarlyStatusActivation({
        queueMode: "steer",
        isActive: true,
        isHeartbeat: false,
        isExternallyRoutable: true,
        isStreaming: true,
        dominantSegments: [{ segment: "runToFirstVisible", count: 2 }],
      }),
    ).toMatchObject({
      shouldEmit: false,
      reason: "phase2_not_enabled_for_correction_or_parallel_status_yet",
      recommendation: {
        level: "prioritize",
      },
    });
    expect(
      evaluateTruthfulEarlyStatusActivation({
        queueMode: "steer",
        isActive: true,
        isHeartbeat: false,
        isExternallyRoutable: true,
        isStreaming: true,
        dominantSegments: [{ segment: "runToFirstEvent", count: 2 }],
      }),
    ).toMatchObject({
      shouldEmit: false,
      reason: "latency_priority_observe",
      recommendation: {
        level: "observe",
      },
    });
  });

  it("keeps interrupt visible even without a dominant latency signal", () => {
    expect(
      evaluateTruthfulEarlyStatusActivation({
        queueMode: "interrupt",
        isActive: true,
        isHeartbeat: false,
        isExternallyRoutable: true,
        isStreaming: true,
      }),
    ).toMatchObject({
      shouldEmit: true,
      reason: "replacement_of_active_task_is_prioritized_even_without_latency_signal",
    });
  });

  it("recommends expanding active-run status when prioritize + latency gate dominate", () => {
    expect(
      buildTruthfulEarlyStatusGuidance({
        recommendation: {
          level: "prioritize",
          reason: "runtime_started_but_visible_feedback_arrives_late",
        },
        summary: {
          sampleCount: 5,
          eligibleCount: 1,
          semanticGateCount: 1,
          latencyGateCount: 3,
        },
      }),
    ).toEqual({
      focus: "expand_active_run_status",
      reason: "recent_candidates_are_primarily_waiting_on_latency_priority_rather_than_semantics",
    });
  });

  it("recommends tightening semantics when prioritize + semantic gate dominate", () => {
    expect(
      buildTruthfulEarlyStatusGuidance({
        recommendation: {
          level: "prioritize",
          reason: "runtime_started_but_visible_feedback_arrives_late",
        },
        summary: {
          sampleCount: 5,
          eligibleCount: 1,
          semanticGateCount: 3,
          latencyGateCount: 1,
        },
      }),
    ).toEqual({
      focus: "tighten_semantic_contract",
      reason: "most_recent_candidates_are_still_blocked_by_truthful_semantics",
    });
  });

  it("recommends optimizing other bottlenecks when priority is not high", () => {
    expect(
      buildTruthfulEarlyStatusGuidance({
        recommendation: {
          level: "observe",
          reason: "latency_is_dominant_before_visible_feedback_is_semantically_decidable",
        },
        summary: {
          sampleCount: 5,
          eligibleCount: 1,
          semanticGateCount: 1,
          latencyGateCount: 3,
        },
      }),
    ).toEqual({
      focus: "optimize_other_bottlenecks",
      reason: "dominant_latency_is_not_currently_in_the_visible_silence_window",
    });
  });
});
