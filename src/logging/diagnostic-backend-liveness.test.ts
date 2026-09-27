import {
  emitDiagnosticEvent as emitPluginDiagnosticEvent,
  emitTrustedDiagnosticEvent as emitPluginTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData as emitPluginTrustedDiagnosticEventWithPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
// Backend silence allowances belong to one live execution, not diagnostic payloads.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitTrustedDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  resetDiagnosticEventsForTest,
} from "../infra/diagnostic-events.js";
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
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "./diagnostic.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticEventsForTest();
});

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
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner });
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

    const snapshot = getDiagnosticSessionActivitySnapshot(ref);
    expect(snapshot).toMatchObject({
      hasActiveEmbeddedRun: true,
      lastProgressReason: "embedded_run:started",
      activeModelCallRequestTimeoutMs: undefined,
    });
    expect(snapshot.activeBackendLivenessDeadlineAtMs).toBeUndefined();
  });

  it.each(["owned tool", "same-id successor"] as const)(
    "does not apply queued nonsemantic progress to the %s",
    async (target) => {
      vi.useFakeTimers();
      const startedAt = Date.parse("2026-08-04T00:00:00Z");
      vi.setSystemTime(startedAt);
      const ref = { sessionId: "queued-progress", sessionKey: "agent:main:queued-progress" };
      const runId = "reused-progress-run";
      const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
      startDiagnosticRunActivityTracking();
      markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner });
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
      const before = getDiagnosticSessionActivitySnapshot(ref);
      expect(before).toMatchObject({
        activeWorkKind: target === "owned tool" ? "tool_call" : "embedded_run",
        lastProgressAgeMs: 1_000,
        lastProgressReason: target === "owned tool" ? "tool:read:started" : "embedded_run:started",
      });

      await vi.advanceTimersByTimeAsync(0);
      await waitForDiagnosticEventsDrained();

      expect(getDiagnosticSessionActivitySnapshot(ref)).toEqual(before);
    },
  );

  it("starts before output and separates backend activity from model progress", () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const ref = { sessionId: "cli-session", sessionKey: "agent:main:cli" };
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId: "cli-run" });
    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, runId: owner.runId, owner });
    const backend = beginDiagnosticBackendActivity({
      owner,
      noOutputTimeoutMs: 480_000,
      assertCurrent: () => {},
    });
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: "embedded_run",
      lastProgressReason: "embedded_run:started",
      activeBackendLivenessDeadlineAtMs: now + 480_000,
    });

    now += 60_000;
    backend.observeOutput(false);
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      lastProgressAgeMs: 60_000,
      lastProgressReason: "embedded_run:started",
      activeBackendLivenessDeadlineAtMs: now + 480_000,
    });

    now += 60_000;
    expect(backend.observeOutput(true)).toBe(true);
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      lastProgressAgeMs: 0,
      lastProgressReason: "model_call:stream_progress",
      activeBackendLivenessDeadlineAtMs: now + 480_000,
      activeModelCallRequestTimeoutMs: undefined,
    });

    backend.close();
    const closed = getDiagnosticSessionActivitySnapshot(ref);
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
      const owner = createDiagnosticEmbeddedRunOwner(ref);
      markDiagnosticEmbeddedRunStarted({ ...ref, owner });
      const backend = beginDiagnosticBackendActivity({
        owner,
        noOutputTimeoutMs,
        assertCurrent: () => {},
      });
      try {
        vi.setSystemTime(startedAt + 60_000);
        backend.setOutstandingWork(true);
        const deadline = startedAt + Math.max(noOutputTimeoutMs, BLOCKED_TOOL_CALL_ABORT_FLOOR_MS);
        expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
          activeBackendLivenessDeadlineAtMs: deadline,
          lastProgressAgeMs: 60_000,
          lastProgressReason: "embedded_run:started",
        });
        vi.setSystemTime(deadline);
        backend.setOutstandingWork(true);
        expect(getDiagnosticSessionActivitySnapshot(ref).activeBackendLivenessDeadlineAtMs).toBe(
          deadline,
        );
        backend.setOutstandingWork(false);
        expect(getDiagnosticSessionActivitySnapshot(ref).activeBackendLivenessDeadlineAtMs).toBe(
          startedAt + noOutputTimeoutMs,
        );
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
      const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
      startDiagnosticRunActivityTracking();
      markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner });
      let current = true;
      const backend = beginDiagnosticBackendActivity({
        owner,
        noOutputTimeoutMs: 480_000,
        assertCurrent: () => {
          if (!current) {
            throw new Error("Execution authority expired");
          }
        },
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
      expect(
        getDiagnosticSessionActivitySnapshot(ref).activeBackendLivenessDeadlineAtMs,
      ).toBeUndefined();

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
        expect(getDiagnosticSessionActivitySnapshot(ref).activeBackendLivenessDeadlineAtMs).toBe(
          now + 90_000,
        );
      }
      now += 1_000;
      const before = getDiagnosticSessionActivitySnapshot(ref);
      expect(backend.observeOutput(true)).toBe(false);
      backend.setOutstandingWork(false);
      backend.setOutstandingWork(true);
      backend.close();
      expect(getDiagnosticSessionActivitySnapshot(ref)).toEqual(before);
      replacement?.close();
    },
  );

  it("does not abort an Agent call while attributed subagent progress stays inside the floor", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-24T00:00:00Z"));
    const recoverStuckSession = vi.fn();
    startDiagnosticHeartbeat(
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
    const owner = createDiagnosticEmbeddedRunOwner(ref);
    markDiagnosticEmbeddedRunStarted({ ...ref, owner });
    markDiagnosticToolStartedForTest({
      ...ref,
      toolName: "Agent",
      toolCallId: "toolu_parent",
    });
    const backend = beginDiagnosticBackendActivity({
      owner,
      noOutputTimeoutMs: 180_000,
      assertCurrent: () => {},
    });
    try {
      vi.advanceTimersByTime(14 * 60_000);
      expect(recoverStuckSession).not.toHaveBeenCalled();
      expect(backend.observeAttributedAgentProgress("toolu_bash")).toBe(false);
      expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
        activeToolName: "Agent",
        activeToolCallId: "toolu_parent",
        lastProgressReason: "tool:Agent:started",
        lastProgressAgeMs: 14 * 60_000,
      });

      expect(backend.observeAttributedAgentProgress("toolu_parent")).toBe(true);
      expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
        lastProgressReason: "tool:Agent:subagent_progress",
        lastProgressAgeMs: 0,
        activeToolAgeMs: 14 * 60_000,
      });

      vi.advanceTimersByTime(14 * 60_000);
      expect(recoverStuckSession).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(recoverStuckSession).toHaveBeenCalled();
    } finally {
      backend.close();
      closeDiagnosticEmbeddedRunOwner(owner);
      stopDiagnosticHeartbeat();
      resetDiagnosticSessionStateForTest();
    }
  });
});
