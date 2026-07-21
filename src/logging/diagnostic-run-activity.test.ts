// Unit tests for shared run-staleness threshold policy.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { hasInternalDiagnosticEventListeners } from "../infra/diagnostic-event-listener-presence.js";
import {
  emitTrustedDiagnosticEvent,
  getInternalDiagnosticEventSequence,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
  clearDiagnosticEmbeddedRunActivityForSession,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
  resolveRunStaleThresholdMs,
  RUN_STALE_TAKEOVER_MS,
  startDiagnosticRunActivityTracking,
  stopDiagnosticRunActivityTracking,
} from "./diagnostic-run-activity.js";
import {
  getRecoveredOwnerCutoffCountForTest,
  markDiagnosticModelStartedForTest,
} from "./diagnostic-run-activity.test-support.js";

afterEach(() => {
  stopDiagnosticRunActivityTracking();
  resetDiagnosticEventsForTest();
});

describe("diagnostic run activity listener lifecycle", () => {
  it("does not register a listener when the module is imported", async () => {
    stopDiagnosticRunActivityTracking();
    resetDiagnosticEventsForTest();

    await importFreshModule<typeof import("./diagnostic-run-activity.js")>(
      import.meta.url,
      "./diagnostic-run-activity.js?scope=no-import-listener",
    );

    expect(hasInternalDiagnosticEventListeners()).toBe(false);
  });

  it("registers and unregisters through the explicit lifecycle", () => {
    resetDiagnosticEventsForTest();

    startDiagnosticRunActivityTracking();
    expect(hasInternalDiagnosticEventListeners()).toBe(true);
    markDiagnosticEmbeddedRunStarted({ sessionId: "run-before-stop" });
    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "run-before-stop" })).toMatchObject({
      activeWorkKind: "embedded_run",
    });

    stopDiagnosticRunActivityTracking();
    expect(hasInternalDiagnosticEventListeners()).toBe(false);
    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "run-before-stop" })).toEqual({});
  });

  it("ignores diagnostic events queued before tracking restarts", async () => {
    resetDiagnosticEventsForTest();
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      sessionId: "stale-run",
      toolName: "stale-tool",
    });

    startDiagnosticRunActivityTracking();
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "stale-run" })).toEqual({});

    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      sessionId: "current-run",
      toolName: "current-tool",
    });
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "current-run" })).toMatchObject({
      activeWorkKind: "tool_call",
      activeToolName: "current-tool",
    });
  });
});

describe("resolveRunStaleThresholdMs", () => {
  it.each([
    {
      name: "default window when no active work",
      activity: {},
      expected: RUN_STALE_TAKEOVER_MS,
    },
    {
      name: "default window for model_call",
      activity: { activeWorkKind: "model_call" as const },
      expected: RUN_STALE_TAKEOVER_MS,
    },
    {
      name: "default window for embedded_run",
      activity: { activeWorkKind: "embedded_run" as const },
      expected: RUN_STALE_TAKEOVER_MS,
    },
    {
      name: "blocked-tool floor for tool_call",
      activity: { activeWorkKind: "tool_call" as const },
      expected: Math.max(RUN_STALE_TAKEOVER_MS, BLOCKED_TOOL_CALL_ABORT_FLOOR_MS),
    },
  ])("$name", ({ activity, expected }) => {
    expect(resolveRunStaleThresholdMs(activity)).toBe(expected);
  });
});

describe("diagnostic run activity retention", () => {
  it("does not retain identifier-free tool lifecycles", async () => {
    startDiagnosticRunActivityTracking();
    for (let index = 0; index <= 2_000; index += 1) {
      const toolCallId = `identifier-free-tool-${index}`;
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        toolName: "proof-tool",
        toolCallId,
      });
      emitTrustedDiagnosticEvent({
        type: "tool.execution.completed",
        toolName: "proof-tool",
        toolCallId,
        durationMs: 1,
      });
    }
    await waitForDiagnosticEventsDrained();

    const completed = {
      runId: "post-identifier-free-run",
      sessionId: "post-identifier-free-session",
      sessionKey: "agent:main:post-identifier-free",
    };
    markDiagnosticRunProgress({ ...completed, reason: "proof:active" });
    emitTrustedDiagnosticEvent({
      type: "run.completed",
      ...completed,
      durationMs: 1,
      outcome: "completed",
    });

    expect(getDiagnosticSessionActivitySnapshot(completed).lastProgressReason).toBe(
      "run:completed",
    );
  });

  it("evicts completed model calls without a run lifecycle", async () => {
    startDiagnosticRunActivityTracking();
    const synthetic = {
      runId: "synthetic-model-run",
      sessionId: "synthetic-model-session",
      sessionKey: "agent:main:synthetic-model",
      callId: "synthetic-model-call",
      provider: "openai",
      model: "gpt-5.5",
    };
    emitTrustedDiagnosticEvent({ type: "model.call.started", ...synthetic });
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      ...synthetic,
      durationMs: 1,
    });
    await waitForDiagnosticEventsDrained();

    for (let index = 0; index <= 2_000; index += 1) {
      const runId = `post-model-run-${index}`;
      const sessionId = `post-model-session-${index}`;
      const sessionKey = `agent:main:post-model-${index}`;
      markDiagnosticRunProgress({ runId, sessionId, sessionKey, reason: "proof:active" });
      emitTrustedDiagnosticEvent({
        type: "run.completed",
        runId,
        sessionId,
        sessionKey,
        durationMs: 1,
        outcome: "completed",
      });
    }

    expect(getDiagnosticSessionActivitySnapshot(synthetic)).toEqual({});
  });

  it("evicts run ownership retired by stuck-session recovery", () => {
    startDiagnosticRunActivityTracking();
    const recovered = {
      sessionId: "recovered-session",
      sessionKey: "agent:main:recovered",
    };
    markDiagnosticModelStartedForTest({
      ...recovered,
      runId: "recovered-run",
      provider: "openai",
      model: "gpt-5.5",
      seq: 1,
    });
    clearDiagnosticEmbeddedRunActivityForSession({
      ...recovered,
      activeSessionId: recovered.sessionId,
      recoveryStartedAfterDiagnosticEventSequence: 1,
    });

    for (let index = 0; index <= 2_000; index += 1) {
      const runId = `post-recovery-run-${index}`;
      const sessionId = `post-recovery-session-${index}`;
      const sessionKey = `agent:main:post-recovery-${index}`;
      markDiagnosticRunProgress({ runId, sessionId, sessionKey, reason: "proof:active" });
      emitTrustedDiagnosticEvent({
        type: "run.completed",
        runId,
        sessionId,
        sessionKey,
        durationMs: 1,
        outcome: "completed",
      });
    }

    expect(getDiagnosticSessionActivitySnapshot(recovered)).toEqual({});
  });

  it("retains recovery cutoffs through completed-session churn until queued starts drain", async () => {
    startDiagnosticRunActivityTracking();
    const recovered = {
      runId: "queued-recovered-run",
      sessionId: "queued-recovered-session",
      sessionKey: "agent:main:queued-recovered",
    };
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      ...recovered,
      callId: "queued-recovered-call",
      provider: "openai",
      model: "gpt-5.5",
    });
    clearDiagnosticEmbeddedRunActivityForSession({
      ...recovered,
      activeSessionId: recovered.sessionId,
      recoveryStartedAfterDiagnosticEventSequence: getInternalDiagnosticEventSequence(),
    });

    for (let index = 0; index <= 2_000; index += 1) {
      const runId = `cutoff-churn-run-${index}`;
      const sessionId = `cutoff-churn-session-${index}`;
      const sessionKey = `agent:main:cutoff-churn-${index}`;
      markDiagnosticRunProgress({ runId, sessionId, sessionKey, reason: "proof:active" });
      emitTrustedDiagnosticEvent({
        type: "run.completed",
        runId,
        sessionId,
        sessionKey,
        durationMs: 1,
        outcome: "completed",
      });
    }
    await waitForDiagnosticEventsDrained();

    markDiagnosticRunProgress({
      runId: "post-cutoff-drain-run",
      sessionId: "post-cutoff-drain-session",
      sessionKey: "agent:main:post-cutoff-drain",
      reason: "proof:active",
    });
    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "post-cutoff-drain-run",
      sessionId: "post-cutoff-drain-session",
      sessionKey: "agent:main:post-cutoff-drain",
      durationMs: 1,
      outcome: "completed",
    });
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticSessionActivitySnapshot(recovered)).toEqual({});
  });

  it("evicts recovery cutoffs whose queued owner event was dropped", () => {
    startDiagnosticRunActivityTracking();
    const recovered = {
      runId: "dropped-recovered-run",
      sessionId: "dropped-recovered-session",
      sessionKey: "agent:main:dropped-recovered",
    };
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      ...recovered,
      callId: "dropped-recovered-call",
      provider: "openai",
      model: "gpt-5.5",
    });
    clearDiagnosticEmbeddedRunActivityForSession({
      ...recovered,
      activeSessionId: recovered.sessionId,
      recoveryStartedAfterDiagnosticEventSequence: getInternalDiagnosticEventSequence(),
    });
    for (let index = 1; index < 10_000; index += 1) {
      emitTrustedDiagnosticEvent({
        type: "model.call.started",
        runId: `queue-fill-run-${index}`,
        sessionId: `queue-fill-session-${index}`,
        callId: `queue-fill-call-${index}`,
        provider: "openai",
        model: "gpt-5.5",
      });
    }
    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      toolName: "priority-drop-trigger",
      durationMs: 1,
    });

    for (let index = 0; index <= 2_000; index += 1) {
      markDiagnosticRunProgress({
        runId: `post-drop-run-${index}`,
        sessionId: `post-drop-session-${index}`,
        sessionKey: `agent:main:post-drop-${index}`,
        reason: "proof:active",
      });
    }

    expect(getDiagnosticSessionActivitySnapshot(recovered)).toEqual({});
  });

  it("keeps completion guards until a saturated async queue drains", async () => {
    startDiagnosticRunActivityTracking();
    const queuedRunCount = 10_000;
    for (let index = 0; index < queuedRunCount; index += 1) {
      emitTrustedDiagnosticEvent({
        type: "run.progress",
        runId: `queued-run-${index}`,
        sessionId: `queued-session-${index}`,
        sessionKey: `agent:main:queued-${index}`,
        reason: "proof:queued",
      });
    }
    for (let index = 0; index < queuedRunCount * 2; index += 1) {
      emitTrustedDiagnosticEvent({
        type: "run.completed",
        runId: index < queuedRunCount ? `queued-run-${index}` : `later-run-${index}`,
        sessionId: index < queuedRunCount ? `queued-session-${index}` : `later-session-${index}`,
        sessionKey:
          index < queuedRunCount ? `agent:main:queued-${index}` : `agent:main:later-${index}`,
        durationMs: 1,
        outcome: "completed",
      });
    }
    await waitForDiagnosticEventsDrained();

    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "queued-session-0",
        sessionKey: "agent:main:queued-0",
      }),
    ).toEqual({});
  });

  it("does not reactivate completed runs from queued diagnostic events", async () => {
    startDiagnosticRunActivityTracking();
    const completed = {
      runId: "late-progress-run",
      sessionId: "late-progress-session",
      sessionKey: "agent:main:late-progress",
    };
    markDiagnosticRunProgress({ ...completed, reason: "proof:active" });
    emitTrustedDiagnosticEvent({
      type: "run.progress",
      ...completed,
      reason: "proof:queued",
    });
    emitTrustedDiagnosticEvent({
      type: "run.completed",
      ...completed,
      durationMs: 1,
      outcome: "completed",
    });
    await waitForDiagnosticEventsDrained();

    for (let index = 0; index < 2_000; index += 1) {
      const runId = `later-completed-run-${index}`;
      const sessionId = `later-completed-session-${index}`;
      const sessionKey = `agent:main:later-completed-${index}`;
      markDiagnosticRunProgress({ runId, sessionId, sessionKey, reason: "proof:active" });
      emitTrustedDiagnosticEvent({
        type: "run.completed",
        runId,
        sessionId,
        sessionKey,
        durationMs: 1,
        outcome: "completed",
      });
    }

    expect(getDiagnosticSessionActivitySnapshot(completed)).toEqual({});
  });

  it("keeps replacement-run activity when an older run completes in the same session", async () => {
    startDiagnosticRunActivityTracking();
    const session = {
      sessionId: "replacement-session",
      sessionKey: "agent:main:replacement",
    };
    markDiagnosticRunProgress({ ...session, runId: "older-run", reason: "older:active" });
    markDiagnosticRunProgress({
      ...session,
      runId: "replacement-run",
      reason: "replacement:active",
    });
    markDiagnosticEmbeddedRunStarted(session);
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      ...session,
      runId: "replacement-run",
      callId: "replacement-call",
      provider: "openai",
      model: "gpt-5.5",
    });
    await waitForDiagnosticEventsDrained();

    emitTrustedDiagnosticEvent({
      type: "run.completed",
      ...session,
      runId: "older-run",
      durationMs: 1,
      outcome: "completed",
    });

    expect(getDiagnosticSessionActivitySnapshot(session)).toMatchObject({
      activeWorkKind: "model_call",
      hasActiveEmbeddedRun: true,
    });

    emitTrustedDiagnosticEvent({
      type: "run.completed",
      ...session,
      runId: "replacement-run",
      durationMs: 1,
      outcome: "completed",
    });

    const completedSnapshot = getDiagnosticSessionActivitySnapshot(session);
    expect(completedSnapshot).toMatchObject({
      activeWorkKind: undefined,
      lastProgressReason: "run:completed",
    });
    expect(completedSnapshot).not.toHaveProperty("hasActiveEmbeddedRun");
  });

  it("keeps replacement embedded activity from run start before its first progress", () => {
    startDiagnosticRunActivityTracking();
    const session = {
      sessionId: "replacement-startup-session",
      sessionKey: "agent:main:replacement-startup",
    };
    markDiagnosticRunProgress({ ...session, runId: "older-run", reason: "older:active" });
    emitTrustedDiagnosticEvent({
      type: "run.started",
      ...session,
      runId: "replacement-run",
    });
    markDiagnosticEmbeddedRunStarted(session);

    emitTrustedDiagnosticEvent({
      type: "run.completed",
      ...session,
      runId: "older-run",
      durationMs: 1,
      outcome: "completed",
    });

    expect(getDiagnosticSessionActivitySnapshot(session)).toMatchObject({
      activeWorkKind: "embedded_run",
      hasActiveEmbeddedRun: true,
    });

    emitTrustedDiagnosticEvent({
      type: "run.completed",
      ...session,
      runId: "replacement-run",
      durationMs: 1,
      outcome: "completed",
    });

    const completedSnapshot = getDiagnosticSessionActivitySnapshot(session);
    expect(completedSnapshot).toMatchObject({
      activeWorkKind: undefined,
      lastProgressReason: "run:completed",
    });
    expect(completedSnapshot).not.toHaveProperty("hasActiveEmbeddedRun");
  });

  it("bounds completed session activity while preserving active runs", () => {
    startDiagnosticRunActivityTracking();
    const active = {
      runId: "active-run",
      sessionId: "active-session",
      sessionKey: "agent:main:active",
    };
    markDiagnosticRunProgress({ ...active, reason: "proof:active" });

    for (let index = 0; index <= 2_000; index += 1) {
      const runId = `completed-run-${index}`;
      const sessionId = `completed-session-${index}`;
      const sessionKey = `agent:main:completed-${index}`;
      markDiagnosticRunProgress({ runId, sessionId, sessionKey, reason: "proof:active" });
      emitTrustedDiagnosticEvent({
        type: "run.completed",
        runId,
        sessionId,
        sessionKey,
        durationMs: 1,
        outcome: "completed",
      });
    }

    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "completed-session-0",
        sessionKey: "agent:main:completed-0",
      }),
    ).toEqual({});
    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "completed-session-2000",
        sessionKey: "agent:main:completed-2000",
      }).lastProgressReason,
    ).toBe("run:completed");
    expect(getDiagnosticSessionActivitySnapshot(active).lastProgressReason).toBe("proof:active");
  });

  it("bounds rotated session id aliases under a stable session key", () => {
    startDiagnosticRunActivityTracking();
    const sessionKey = "agent:main:stable-rotation";
    for (let index = 0; index <= 2_500; index += 1) {
      const runId = `rotated-run-${index}`;
      const sessionId = `rotated-session-${index}`;
      markDiagnosticRunProgress({ runId, sessionId, sessionKey, reason: "proof:active" });
      emitTrustedDiagnosticEvent({
        type: "run.completed",
        runId,
        sessionId,
        sessionKey,
        durationMs: 1,
        outcome: "completed",
      });
    }

    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "rotated-session-0" })).toEqual({});
    expect(
      getDiagnosticSessionActivitySnapshot({ sessionId: "rotated-session-2500" })
        .lastProgressReason,
    ).toBe("run:completed");
  });

  it("releases recovered-owner cutoffs when the async queue drains", async () => {
    startDiagnosticRunActivityTracking();
    const sessionKey = "agent:main:stable-recovery";
    for (let index = 0; index <= 2_500; index += 1) {
      const sessionId = `recovered-rotation-${index}`;
      emitTrustedDiagnosticEvent({
        type: "model.call.started",
        callId: `recovered-call-${index}`,
        runId: `recovered-run-${index}`,
        sessionId,
        sessionKey,
        provider: "openai",
        model: "gpt-5.5",
      });
      clearDiagnosticEmbeddedRunActivityForSession({
        sessionId,
        sessionKey,
        activeSessionId: sessionId,
        recoveryStartedAfterDiagnosticEventSequence: getInternalDiagnosticEventSequence(),
      });
    }

    await waitForDiagnosticEventsDrained();

    expect(getRecoveredOwnerCutoffCountForTest({ sessionKey })).toBe(0);
    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "recovered-rotation-0" })).toEqual({});
  });

  it("does not restore recovered runs from queued progress", async () => {
    startDiagnosticRunActivityTracking();
    const session = {
      sessionId: "recovered-progress-session",
      sessionKey: "agent:main:recovered-progress",
    };
    emitTrustedDiagnosticEvent({
      type: "run.progress",
      ...session,
      runId: "recovered-progress-run",
      reason: "proof:queued-before-recovery",
    });
    clearDiagnosticEmbeddedRunActivityForSession({
      ...session,
      activeSessionId: session.sessionId,
      recoveryStartedAfterDiagnosticEventSequence: getInternalDiagnosticEventSequence(),
    });
    await waitForDiagnosticEventsDrained();

    markDiagnosticRunProgress({
      ...session,
      runId: "replacement-progress-run",
      reason: "proof:replacement",
    });
    markDiagnosticEmbeddedRunStarted(session);
    emitTrustedDiagnosticEvent({
      type: "run.completed",
      ...session,
      runId: "replacement-progress-run",
      durationMs: 1,
      outcome: "completed",
    });
    await waitForDiagnosticEventsDrained();

    const completedSnapshot = getDiagnosticSessionActivitySnapshot(session);
    expect(completedSnapshot).toMatchObject({
      activeWorkKind: undefined,
      lastProgressReason: "run:completed",
    });
    expect(completedSnapshot).not.toHaveProperty("hasActiveEmbeddedRun");
  });
});
