import {
  emitDiagnosticEvent as emitPluginDiagnosticEvent,
  emitTrustedDiagnosticEvent as emitPluginTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData as emitPluginTrustedDiagnosticEventWithPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitTrustedDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  resetDiagnosticEventsForTest,
} from "../infra/diagnostic-events.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
  beginDiagnosticBackendActivity,
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticOwnedToolActivity,
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "./diagnostic-run-activity.js";
import { markDiagnosticToolStartedForTest } from "./diagnostic-run-activity.test-support.js";
import { resetDiagnosticSessionStateForTest } from "./diagnostic-session-state.js";
import {
  logSessionStateChange,
  startGatewayDiagnosticHeartbeat,
  stopGatewayDiagnosticHeartbeat,
} from "./diagnostic.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticEventsForTest();
});

function startOwnedRun(ref: Parameters<typeof createDiagnosticEmbeddedRunOwner>[0]) {
  const owner = createDiagnosticEmbeddedRunOwner(ref);
  startDiagnosticRunActivityTracking();
  markDiagnosticEmbeddedRunStarted({ ...ref, owner });
  return {
    owner,
    snapshot: () =>
      getDiagnosticSessionActivitySnapshot({
        sessionId: ref.sessionId,
        sessionKey: ref.sessionKey,
      }),
    begin: (noOutputTimeoutMs = 480_000, assertCurrent = () => {}) =>
      beginDiagnosticBackendActivity({ owner, noOutputTimeoutMs, assertCurrent }),
  };
}

describe("owned backend silence allowances", () => {
  it.each([
    { name: "public emitter", emit: emitPluginDiagnosticEvent },
    { name: "trusted emitter", emit: emitPluginTrustedDiagnosticEvent },
    {
      name: "trusted private-data emitter",
      emit: (event: Parameters<typeof emitPluginDiagnosticEvent>[0]) => {
        const privateData = {
          modelContent: { inputMessages: ["forged allowance"] },
          backendLivenessTimeoutMs: 480_000,
          activeBackendLivenessDeadlineAtMs: Date.now() + 480_000,
        };
        emitPluginTrustedDiagnosticEventWithPrivateData(event, privateData);
      },
    },
  ])("does not accept backend allowance fields from the $name", async ({ emit }) => {
    const ref = { sessionId: "forged-allowance", sessionKey: "agent:main:forged-allowance" };
    const runId = "forged-allowance-run";
    const { snapshot } = startOwnedRun({ ...ref, runId });
    const forged = {
      type: "run.progress" as const,
      ...ref,
      runId,
      reason: "model_call:stream_progress",
      backendLivenessTimeoutMs: 480_000,
      activeBackendLivenessDeadlineAtMs: Date.now() + 480_000,
    };

    emit(forged);
    await waitForDiagnosticEventsDrained();

    expect(snapshot()).toMatchObject({
      hasActiveEmbeddedRun: true,
      lastProgressReason: "embedded_run:started",
      activeModelCallRequestTimeoutMs: undefined,
    });
    expect(snapshot().activeBackendLivenessDeadlineAtMs).toBeUndefined();
  });

  it.each(["owned tool", "same-id successor"] as const)(
    "does not apply queued nonsemantic progress to the %s",
    async (target) => {
      vi.useFakeTimers();
      const startedAt = Date.parse("2026-08-04T00:00:00Z");
      vi.setSystemTime(startedAt);
      const ref = { sessionId: "queued-progress", sessionKey: "agent:main:queued-progress" };
      const runId = "reused-progress-run";
      const { owner, snapshot } = startOwnedRun({ ...ref, runId });
      emitTrustedDiagnosticEvent({
        type: "run.progress",
        ...ref,
        runId,
        reason: "model_call:stream_progress",
      });

      vi.setSystemTime(startedAt + 1_000);
      if (target === "owned tool") {
        markDiagnosticOwnedToolActivity(owner, {
          phase: "start",
          toolName: "read",
          toolCallId: "owned-read",
        });
      } else {
        closeDiagnosticEmbeddedRunOwner(owner);
        const successor = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
        markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner: successor });
      }
      vi.setSystemTime(startedAt + 2_000);
      const before = snapshot();
      expect(before).toMatchObject({
        activeWorkKind: target === "owned tool" ? "tool_call" : "embedded_run",
        lastProgressAgeMs: 1_000,
        lastProgressReason: target === "owned tool" ? "tool:read:started" : "embedded_run:started",
      });

      await vi.advanceTimersByTimeAsync(0);
      await waitForDiagnosticEventsDrained();

      expect(snapshot()).toEqual(before);
    },
  );

  it("starts before output and separates backend activity from model progress", () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const ref = { sessionId: "cli-session", sessionKey: "agent:main:cli" };
    const { snapshot, begin } = startOwnedRun({ ...ref, runId: "cli-run" });
    const backend = begin();
    expect(snapshot()).toMatchObject({
      activeWorkKind: "embedded_run",
      lastProgressReason: "embedded_run:started",
      activeBackendLivenessDeadlineAtMs: now + 480_000,
    });

    now += 60_000;
    backend.observeOutput(false);
    expect(snapshot()).toMatchObject({
      lastProgressAgeMs: 60_000,
      lastProgressReason: "embedded_run:started",
      activeBackendLivenessDeadlineAtMs: now + 480_000,
    });

    now += 60_000;
    expect(backend.observeOutput(true)).toBe(true);
    expect(snapshot()).toMatchObject({
      lastProgressAgeMs: 0,
      lastProgressReason: "model_call:stream_progress",
      activeBackendLivenessDeadlineAtMs: now + 480_000,
      activeModelCallRequestTimeoutMs: undefined,
    });

    backend.close();
    const closed = snapshot();
    expect(closed.activeWorkKind).toBe("embedded_run");
    expect(closed.activeBackendLivenessDeadlineAtMs).toBeUndefined();
  });

  it.each([30_000, 1_200_000])(
    "changes the %ims allowance without manufacturing output or progress",
    (noOutputTimeoutMs) => {
      vi.useFakeTimers();
      const startedAt = 1_000_000;
      vi.setSystemTime(startedAt);
      const ref = { sessionId: "background-allowance", runId: "background-allowance-run" };
      const { owner, snapshot, begin } = startOwnedRun(ref);
      const backend = begin(noOutputTimeoutMs);
      try {
        vi.setSystemTime(startedAt + 60_000);
        backend.setOutstandingWork(true);
        const deadline = startedAt + Math.max(noOutputTimeoutMs, BLOCKED_TOOL_CALL_ABORT_FLOOR_MS);
        expect(snapshot()).toMatchObject({
          activeBackendLivenessDeadlineAtMs: deadline,
          lastProgressAgeMs: 60_000,
          lastProgressReason: "embedded_run:started",
        });
        vi.setSystemTime(deadline);
        backend.setOutstandingWork(true);
        expect(snapshot().activeBackendLivenessDeadlineAtMs).toBe(deadline);
        backend.setOutstandingWork(false);
        expect(snapshot().activeBackendLivenessDeadlineAtMs).toBe(startedAt + noOutputTimeoutMs);
      } finally {
        backend.close();
        closeDiagnosticEmbeddedRunOwner(owner);
      }
    },
  );

  it.each(["attempt close", "owner close", "authority expiry", "owner replacement"] as const)(
    "revokes the allowance and retained observations after %s",
    (closure) => {
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const ref = { sessionId: "reused-session", sessionKey: "agent:main:reused" };
      const runId = "reused-run";
      const { owner, snapshot, begin } = startOwnedRun({ ...ref, runId });
      let current = true;
      const backend = begin(480_000, () => {
        if (!current) {
          throw new Error("Execution authority expired");
        }
      });
      expect(backend.observeOutput(true)).toBe(true);
      backend.setOutstandingWork(true);

      if (closure === "attempt close") {
        backend.close();
      } else if (closure === "authority expiry") {
        current = false;
      } else {
        closeDiagnosticEmbeddedRunOwner(owner);
      }
      expect(snapshot().activeBackendLivenessDeadlineAtMs).toBeUndefined();

      const replacementOwner =
        closure === "owner replacement"
          ? createDiagnosticEmbeddedRunOwner({ ...ref, runId })
          : owner;
      if (closure === "owner replacement") {
        markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner: replacementOwner });
      }
      const replacement =
        closure === "owner replacement" || closure === "attempt close"
          ? beginDiagnosticBackendActivity({
              owner: replacementOwner,
              noOutputTimeoutMs: 90_000,
              assertCurrent: () => {},
            })
          : undefined;
      if (replacement) {
        expect(snapshot().activeBackendLivenessDeadlineAtMs).toBe(now + 90_000);
      }
      now += 1_000;
      const before = snapshot();
      expect(backend.observeOutput(true)).toBe(false);
      backend.setOutstandingWork(false);
      backend.setOutstandingWork(true);
      backend.close();
      expect(snapshot()).toEqual(before);
      replacement?.close();
    },
  );

  it("does not abort an Agent call while attributed subagent progress stays inside the floor", async () => {
    const clock = createGatewaySchedulerClock(Date.parse("2026-09-24T00:00:00Z"));
    const scheduler = createTestGatewayScheduler(clock.clock);
    vi.spyOn(Date, "now").mockImplementation(clock.clock.now);
    const advanceHeartbeats = async (durationMs: number) => {
      // Recovery discounts scheduler lateness, so advance ordinary heartbeat windows.
      for (let elapsed = 0; elapsed < durationMs; elapsed += 30_000) {
        await clock.advanceBy(30_000);
      }
    };
    const recoverStuckSession = vi.fn();
    startGatewayDiagnosticHeartbeat(
      scheduler,
      { diagnostics: { enabled: true } },
      {
        recoverStuckSession,
        testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 60_000 },
      },
    );
    const ref = {
      sessionId: "agent-progress",
      sessionKey: "agent:main:agent-progress",
      runId: "agent-run",
    };
    logSessionStateChange({ ...ref, state: "processing" });
    const { owner, snapshot, begin } = startOwnedRun(ref);
    markDiagnosticToolStartedForTest({
      ...ref,
      toolName: "Agent",
      toolCallId: "toolu_parent",
    });
    const backend = begin(180_000);
    try {
      await advanceHeartbeats(14 * 60_000);
      expect(recoverStuckSession).not.toHaveBeenCalled();
      expect(backend.observeAttributedAgentProgress("toolu_bash")).toBe(false);
      expect(snapshot()).toMatchObject({
        activeToolName: "Agent",
        activeToolCallId: "toolu_parent",
        lastProgressReason: "tool:Agent:started",
        lastProgressAgeMs: 14 * 60_000,
      });

      expect(backend.observeAttributedAgentProgress("toolu_parent")).toBe(true);
      expect(snapshot()).toMatchObject({
        lastProgressReason: "tool:Agent:subagent_progress",
        lastProgressAgeMs: 0,
        activeToolAgeMs: 14 * 60_000,
      });

      await advanceHeartbeats(14 * 60_000);
      expect(recoverStuckSession).not.toHaveBeenCalled();
      await advanceHeartbeats(60_000);
      expect(recoverStuckSession).toHaveBeenCalled();
    } finally {
      backend.close();
      closeDiagnosticEmbeddedRunOwner(owner);
      stopGatewayDiagnosticHeartbeat();
      await scheduler.stop();
      resetDiagnosticSessionStateForTest();
    }
  });
});
