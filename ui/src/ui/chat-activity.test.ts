import { describe, expect, it } from "vitest";
import { resolveChatActivityState } from "./chat-activity.ts";

describe("resolveChatActivityState", () => {
  it("treats tool-only active work as running_tool instead of idle", () => {
    const activity = resolveChatActivityState({
      now: 10_000,
      connected: true,
      sending: false,
      runId: "run-1",
      stream: null,
      activeToolCallCount: 1,
      reconnectPendingAt: null,
      lastActivityAt: 9_500,
      lastToolActivityAt: 9_500,
      lastTerminalAt: null,
      lastTerminalKind: null,
      sessionStatus: "running",
      sessionEndedAt: undefined,
    });

    expect(activity.kind).toBe("running_tool");
  });

  it("treats a recently reconnected run without fresh output as unknown instead of idle", () => {
    const activity = resolveChatActivityState({
      now: 20_000,
      connected: true,
      sending: false,
      runId: null,
      stream: null,
      activeToolCallCount: 0,
      reconnectPendingAt: 19_000,
      lastActivityAt: 18_500,
      lastToolActivityAt: null,
      lastTerminalAt: null,
      lastTerminalKind: null,
      sessionStatus: undefined,
      sessionEndedAt: undefined,
    });

    expect(activity.kind).toBe("unknown");
  });

  it("uses session status to keep a silent run visible", () => {
    const activity = resolveChatActivityState({
      now: 30_000,
      connected: true,
      sending: false,
      runId: null,
      stream: null,
      activeToolCallCount: 0,
      reconnectPendingAt: null,
      lastActivityAt: 27_000,
      lastToolActivityAt: null,
      lastTerminalAt: null,
      lastTerminalKind: null,
      sessionStatus: "running",
      sessionEndedAt: undefined,
    });

    expect(activity.kind).toBe("silent_processing");
  });

  it("does not treat an empty placeholder stream as active replying output", () => {
    const activity = resolveChatActivityState({
      now: 31_000,
      connected: true,
      sending: false,
      runId: "run-2",
      stream: "",
      activeToolCallCount: 0,
      reconnectPendingAt: null,
      lastActivityAt: 30_000,
      lastToolActivityAt: null,
      lastTerminalAt: null,
      lastTerminalKind: null,
      sessionStatus: "running",
      sessionEndedAt: undefined,
    });

    expect(activity.kind).toBe("silent_processing");
  });

  it("does not keep claiming work after a terminal session snapshot", () => {
    const activity = resolveChatActivityState({
      now: 40_000,
      connected: true,
      sending: false,
      runId: null,
      stream: null,
      activeToolCallCount: 0,
      reconnectPendingAt: null,
      lastActivityAt: 39_500,
      lastToolActivityAt: null,
      lastTerminalAt: 39_600,
      lastTerminalKind: "completed",
      sessionStatus: "done",
      sessionEndedAt: 39_700,
    });

    expect(activity.kind).toBe("completed");
  });

  it("prefers a terminal snapshot over a stale running session row", () => {
    const activity = resolveChatActivityState({
      now: 41_000,
      connected: true,
      sending: false,
      runId: null,
      stream: null,
      activeToolCallCount: 0,
      reconnectPendingAt: null,
      lastActivityAt: 39_500,
      lastToolActivityAt: null,
      lastTerminalAt: 40_000,
      lastTerminalKind: "aborted",
      sessionStatus: "running",
      sessionEndedAt: undefined,
    });

    expect(activity.kind).toBe("completed");
    expect(activity.label).toBe("Run stopped");
  });

  it("keeps completed visible after the old terminal toast window expires", () => {
    const activity = resolveChatActivityState({
      now: 80_000,
      connected: true,
      sending: false,
      runId: null,
      stream: null,
      activeToolCallCount: 0,
      reconnectPendingAt: null,
      lastActivityAt: 39_500,
      lastToolActivityAt: null,
      lastTerminalAt: 40_000,
      lastTerminalKind: "completed",
      sessionStatus: "done",
      sessionEndedAt: 40_100,
    });

    expect(activity.kind).toBe("completed");
    expect(activity.summaryKind).toBe("completed");
  });

  it("does not trust a stale running session row forever after output stops", () => {
    const activity = resolveChatActivityState({
      now: 60_000,
      connected: true,
      sending: false,
      runId: null,
      stream: null,
      activeToolCallCount: 0,
      reconnectPendingAt: null,
      lastActivityAt: 20_000,
      lastToolActivityAt: null,
      lastTerminalAt: null,
      lastTerminalKind: null,
      sessionStatus: "running",
      sessionEndedAt: undefined,
    });

    expect(activity.kind).toBe("idle");
  });

  it("surfaces approval blocking instead of pretending the run is still advancing", () => {
    const activity = resolveChatActivityState({
      now: 50_000,
      connected: true,
      sending: false,
      runId: "run-3",
      stream: null,
      activeToolCallCount: 1,
      reconnectPendingAt: null,
      lastActivityAt: 49_000,
      lastToolActivityAt: 49_000,
      lastTerminalAt: null,
      lastTerminalKind: null,
      sessionStatus: "running",
      sessionEndedAt: undefined,
      currentSessionApproval: {
        kind: "exec",
        count: 1,
        createdAtMs: 49_500,
      },
    });

    expect(activity.kind).toBe("awaiting_approval");
    expect(activity.label).toBe("Waiting for approval");
  });

  it("keeps approval-blocked work visible while reconnecting after disconnect", () => {
    const activity = resolveChatActivityState({
      now: 55_000,
      connected: false,
      sending: false,
      runId: null,
      stream: null,
      activeToolCallCount: 0,
      reconnectPendingAt: null,
      lastActivityAt: 53_000,
      lastToolActivityAt: null,
      lastTerminalAt: null,
      lastTerminalKind: null,
      sessionStatus: undefined,
      sessionEndedAt: undefined,
      currentSessionApproval: {
        kind: "exec",
        count: 1,
        createdAtMs: 54_000,
      },
    });

    expect(activity.kind).toBe("reconnecting");
    expect(activity.summaryKind).toBe("in_progress");
  });
});
