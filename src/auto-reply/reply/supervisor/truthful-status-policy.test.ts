import { describe, expect, it } from "vitest";
import {
  decideTruthfulEarlyStatus,
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
});
