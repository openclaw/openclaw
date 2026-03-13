import { describe, expect, it } from "vitest";
import { decideTruthfulEarlyStatus } from "./truthful-status-policy.js";

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
});
