import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  emitDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { DiagnosticLivenessSample } from "./diagnostic-liveness.js";
import { withDiagnosticPhase } from "./diagnostic-phase.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunEnded,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
} from "./diagnostic-run-activity.js";
import {
  markDiagnosticModelStartedForTest,
  markDiagnosticToolStartedForTest,
} from "./diagnostic-run-activity.test-support.js";
import { diagnosticSessionStates, getDiagnosticSessionState } from "./diagnostic-session-state.js";
import { getDiagnosticStabilitySnapshot } from "./diagnostic-stability.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";
import {
  diagnosticLogger,
  logMessageQueued,
  logSessionStateChange,
  markDiagnosticSessionProgress,
  startGatewayDiagnosticHeartbeat,
} from "./diagnostic.js";
import {
  resetDiagnosticStateForTest,
  startEnabledDiagnosticHeartbeatForTest as startEnabledDiagnosticHeartbeat,
} from "./diagnostic.test-support.js";
import { createDiagnosticMessageLifecycle } from "./message-lifecycle.js";

const livenessSample = (
  overrides: Partial<DiagnosticLivenessSample> = {},
): DiagnosticLivenessSample => ({
  reasons: ["event_loop_delay"],
  intervalMs: 30_000,
  eventLoopDelayP99Ms: 1_500,
  eventLoopDelayMaxMs: 2_000,
  ...overrides,
});

function createEmitMemorySampleMock() {
  return vi.fn(() => ({
    rssBytes: 100,
    heapTotalBytes: 80,
    heapUsedBytes: 40,
    externalBytes: 10,
    arrayBuffersBytes: 5,
  }));
}

function expectLoggerMessageContaining(spy: unknown, text: string, present = true): void {
  const assertion = expect(spy);
  (present ? assertion : assertion.not).toHaveBeenCalledWith(expect.stringContaining(text));
}

let events: DiagnosticEventPayload[];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  resetDiagnosticStateForTest();
  resetDiagnosticEventsForTest();
  events = [];
  onDiagnosticEvent((event) => events.push(event));
});
afterEach(() => {
  resetDiagnosticEventsForTest();
  resetDiagnosticStateForTest();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("diagnostic session state pruning", () => {
  it("evicts stale idle session states", () => {
    getDiagnosticSessionState({ sessionId: "stale-1" });
    expect(diagnosticSessionStates.size).toBe(1);

    vi.advanceTimersByTime(31 * 60 * 1000);
    getDiagnosticSessionState({ sessionId: "fresh-1" });

    expect(diagnosticSessionStates.size).toBe(1);
  });

  it("caps tracked session states even when the oldest key is empty", () => {
    const oldestKey = "";
    const now = Date.now();
    for (let i = 0; i < 2001; i += 1) {
      vi.setSystemTime(now + i);
      getDiagnosticSessionState({
        sessionKey: i === 0 ? oldestKey : `session-${i}`,
      }).queueDepth = 1;
    }

    expect(diagnosticSessionStates.size).toBe(2000);
    expect(diagnosticSessionStates.has(oldestKey)).toBe(false);
  });

  it.each([false, true])("canonicalizes session aliases with existing keyed state=%s", (split) => {
    const sessionKey = "agent:main:demo-channel:channel:c1";
    const keyed = split ? getDiagnosticSessionState({ sessionKey }) : undefined;
    if (keyed) {
      keyed.queueDepth = 1;
      keyed.lastActivity = 1;
    }
    const pending = getDiagnosticSessionState({ sessionId: "s1" });
    pending.queueDepth = 1;
    if (split) {
      pending.state = "processing";
      pending.lastActivity = 2;
    }
    const merged = getDiagnosticSessionState({ sessionId: "s1", sessionKey });
    expect(merged).toBe(keyed ?? pending);
    expect(merged).toMatchObject({
      queueDepth: split ? 2 : 1,
      state: split ? "processing" : "idle",
    });
    expect(diagnosticSessionStates.has("s1")).toBe(false);
    expect(diagnosticSessionStates.get(sessionKey)).toBe(merged);
    expect(getDiagnosticSessionState({ sessionKey })).toBe(merged);
    expect(getDiagnosticSessionState({ sessionId: "s1" })).toBe(merged);
    expect(diagnosticSessionStates.size).toBe(1);
    if (split) {
      logSessionStateChange({
        sessionId: "s1",
        sessionKey,
        state: "idle",
        reason: "run_completed",
      });
      logSessionStateChange({ sessionKey, state: "idle", reason: "message_completed" });
      expect(getDiagnosticSessionState({ sessionKey }).queueDepth).toBe(0);
      expect(diagnosticSessionStates.size).toBe(1);
    }
  });

  it("does not create or rewrite idle state when a controller retires", () => {
    const diagnosticsEnabled = areDiagnosticsEnabledForProcess();
    setDiagnosticsEnabledForProcess(true);
    try {
      const sessionKey = "agent:main:controller-retired";
      const retirement = {
        sessionKey,
        sessionId: "original-session",
        state: "idle" as const,
        consumeQueuedTurn: false,
      };
      logSessionStateChange(retirement);
      expect(diagnosticSessionStates.size).toBe(0);

      vi.setSystemTime(1_000);
      logMessageQueued({ sessionKey, sessionId: "adopted-session", source: "pending-followup" });
      vi.setSystemTime(2_000);
      logSessionStateChange(retirement);

      expect(diagnosticSessionStates.get(sessionKey)).toMatchObject({
        sessionId: "adopted-session",
        state: "idle",
        queueDepth: 1,
        lastActivity: 1_000,
      });
    } finally {
      setDiagnosticsEnabledForProcess(diagnosticsEnabled);
    }
  });
});

describe("stuck session diagnostics threshold", () => {
  let recoverStuckSession = vi.fn();
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const session = { sessionId: "s1", sessionKey: "main" };
  const eventsOf = <Type extends DiagnosticEventPayload["type"]>(type: Type) =>
    events.filter(
      (event): event is Extract<DiagnosticEventPayload, { type: Type }> => event.type === type,
    );
  const lastEvent = <Type extends DiagnosticEventPayload["type"]>(type: Type) =>
    eventsOf(type).at(-1);
  function startHeartbeat(options: Parameters<typeof startEnabledDiagnosticHeartbeat>[0] = {}) {
    startEnabledDiagnosticHeartbeat({ recoverStuckSession, ...options });
  }
  function startSession(
    options: Parameters<typeof startEnabledDiagnosticHeartbeat>[0] = {},
    embedded = true,
  ) {
    startHeartbeat(options);
    logSessionStateChange({ ...session, state: "processing" });
    if (embedded) {
      markDiagnosticEmbeddedRunStarted(session);
    }
  }
  function startTool(toolName = "bash", toolCallId = "cmd-1") {
    markDiagnosticToolStartedForTest({ ...session, runId: "run-1", toolName, toolCallId });
  }
  function startModel(
    overrides: Partial<Parameters<typeof markDiagnosticModelStartedForTest>[0]> = {},
  ) {
    markDiagnosticModelStartedForTest({
      ...session,
      runId: "run-1",
      provider: "openai",
      model: "gpt-5",
      ...overrides,
    });
  }
  const repeatedRequest = {
    provider: "mock",
    model: "retrying-model",
    observationUnit: "request",
  } as const;
  function expectStability(fields: Record<string, unknown>, limit = 10) {
    expect(getDiagnosticStabilitySnapshot({ limit }).events).toContainEqual(
      expect.objectContaining(fields),
    );
  }

  beforeEach(() => {
    recoverStuckSession = vi.fn();
    vi.spyOn(diagnosticLogger, "isEnabled").mockReturnValue(true);
    warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
  });

  it("does not count a single in-flight turn as queued work without an active run", () => {
    const sessionFile = "/tmp/openclaw-heartbeat-session.jsonl";
    startHeartbeat();
    logMessageQueued({ ...session, source: "test" });
    logSessionStateChange({ ...session, sessionFile, state: "processing" });
    vi.advanceTimersByTime(61_000);

    expect(eventsOf("session.long_running")).toHaveLength(0);
    const stuckEvents = eventsOf("session.stuck");
    expect(stuckEvents).toHaveLength(1);
    expect(stuckEvents[0]).toMatchObject({
      classification: "stale_session_state",
      reason: "stale_session_state",
      queueDepth: 0,
    });
    expect(recoverStuckSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ operation: undefined, allowActiveAbort: false, queueDepth: 0 }),
    );
    vi.advanceTimersByTime(61_000);
    expect(eventsOf("session.stuck").map((event) => event.ageMs)).toEqual([60_000, 120_000]);
    expect(eventsOf("session.recovery.requested").map((event) => event.ageMs)).toEqual([
      60_000, 90_000, 120_000,
    ]);
  });

  it.each([
    { name: "material stall", progressAt: 20_000, tickAt: 35_000, warns: true },
    { name: "ordinary jitter", progressAt: 15_500, tickAt: 30_999, warns: false },
  ])("reports $name without inventing ownerless recovery", ({ progressAt, tickAt, warns }) => {
    startSession();

    vi.advanceTimersByTime(progressAt);
    markDiagnosticSessionProgress(session);
    markDiagnosticRunProgress({ ...session, reason: "embedded_run:progress" });
    vi.advanceTimersByTime(30_000 - progressAt);

    vi.setSystemTime(tickAt);
    vi.advanceTimersByTime(30_000);

    expectLoggerMessageContaining(warnSpy, "liveness heartbeat delayed", warns);
    expect(recoverStuckSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);

    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it.each(["embedded_run", "model_call"] as const)(
    "reports silent %s at its threshold without ownerless recovery",
    (activeWorkKind) => {
      const isModel = activeWorkKind === "model_call";
      // The embedded case deliberately exercises the production default.
      startGatewayDiagnosticHeartbeat(
        createTestGatewayScheduler("fake-timers"),
        { diagnostics: { enabled: true } },
        {
          recoverStuckSession,
          ...(isModel
            ? { testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 90_000 } }
            : {}),
        },
      );
      logSessionStateChange({ ...session, state: "processing" });
      markDiagnosticEmbeddedRunStarted(session);
      if (isModel) {
        startModel();
      }
      vi.advanceTimersByTime(isModel ? 60_000 : 330_000);
      expect(recoverStuckSession).not.toHaveBeenCalled();
      if (isModel) {
        expect(eventsOf("session.stalled")).toHaveLength(0);
        expect(lastEvent("session.long_running")).toMatchObject({
          classification: "long_running",
          reason: "active_model_call_without_progress",
          activeWorkKind,
          lastProgressReason: "model_call:started",
        });
      }
      vi.advanceTimersByTime(30_000);
      expect(lastEvent("session.stalled")).toMatchObject({
        reason: "active_work_without_progress",
        activeWorkKind,
        ...(isModel ? { lastProgressReason: "model_call:started" } : {}),
      });
      expect(recoverStuckSession).not.toHaveBeenCalled();
    },
  );

  it.each(["blocked", "progressing", "ended"] as const)(
    "uses the owned-work clock for a %s tool while inbound keeps arriving",
    (phase) => {
      startSession({}, false);
      if (phase === "blocked") {
        getDiagnosticSessionState(session).lastActivity = Date.now() - 120_000;
      }
      markDiagnosticEmbeddedRunStarted(session);
      startTool();
      if (phase === "blocked") {
        vi.advanceTimersByTime(60_000);
        expect(recoverStuckSession).not.toHaveBeenCalled();
      } else if (phase === "ended") {
        markDiagnosticEmbeddedRunEnded(session);
        expect(getDiagnosticSessionActivitySnapshot(session).activeWorkKind).toBeUndefined();
      }
      for (let elapsed = 0; elapsed < 20 * 60_000; elapsed += 25_000) {
        vi.advanceTimersByTime(25_000);
        logMessageQueued({ ...session, source: "dispatch" });
        if (phase === "progressing") {
          markDiagnosticRunProgress({
            ...session,
            runId: "run-1",
            reason: "cli_live:stream_progress",
          });
        }
      }
      if (phase === "blocked") {
        const stalled = lastEvent("session.stalled");
        expect(stalled).toMatchObject({
          classification: "blocked_tool_call",
          reason: "blocked_tool_call",
          activeWorkKind: "tool_call",
          activeToolName: "bash",
          activeToolCallId: "cmd-1",
        });
        expect(stalled?.ageMs).toBeGreaterThanOrEqual(15 * 60_000);
      } else {
        expect(eventsOf("session.stalled")).toHaveLength(0);
      }
      expect(recoverStuckSession).not.toHaveBeenCalled();
    },
  );

  it.each(["model_call", "tool_call"] as const)(
    "reports repeated requests during %s without granting recovery authority",
    (activeWorkKind) => {
      const recover = vi.fn(recoverStuckDiagnosticSession);
      const stuckSessionWarnMs = 30_000;
      const stuckSessionAbortMs = activeWorkKind === "tool_call" ? 900_000 : 90_000;
      startHeartbeat({
        recoverStuckSession: recover,
        testTimings: { stuckSessionWarnMs, stuckSessionAbortMs },
      });
      logSessionStateChange({ ...session, state: "processing" });
      markDiagnosticEmbeddedRunStarted({ ...session, runId: "run-1" });
      startModel(repeatedRequest);
      if (activeWorkKind === "tool_call") {
        // An open tool must not hide mature repeated-request evidence.
        startTool("read", "read-during-retries");
      }

      for (let attempt = 2; attempt <= 6; attempt += 1) {
        vi.advanceTimersByTime(stuckSessionAbortMs / 3);
        logSessionStateChange({ ...session, state: "processing", reason: "run_started" });
        startModel(repeatedRequest);
      }

      expect(eventsOf("session.stalled")).toContainEqual(
        expect.objectContaining({
          reason: "repeated_model_requests_without_progress",
          repeatedRequestNoProgressAgeMs: stuckSessionAbortMs,
          activeWorkKind,
        }),
      );
      expect(recover).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "reconciles idle queued work only without an embedded owner (%s)",
    async (owned) => {
      const recover = owned ? recoverStuckSession : vi.fn(recoverStuckDiagnosticSession);
      startSession({ recoverStuckSession: recover }, owned);
      startModel();
      logSessionStateChange({ ...session, state: "idle" });
      vi.advanceTimersByTime(59_000);
      logMessageQueued({ ...session, source: "test-followup" });
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      if (owned) {
        expect(recover).not.toHaveBeenCalled();
        expect(getDiagnosticSessionState(session).queueDepth).toBe(1);
      } else {
        expect(lastEvent("session.stuck")).toMatchObject({
          state: "idle",
          reason: "queued_work_without_active_run",
          queueDepth: 1,
          lastProgressReason: "model_call:started",
        });
        expect(recover).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ operation: undefined, allowActiveAbort: false }),
        );
        expect(getDiagnosticSessionState(session)).toMatchObject({
          state: "waiting",
          queueDepth: 1,
        });
      }
    },
  );

  it("throttles repeated long-running active-work warnings", () => {
    startSession({}, false);
    vi.advanceTimersByTime(45_000);
    markDiagnosticEmbeddedRunStarted(session);
    vi.advanceTimersByTime(16_000);

    expect(eventsOf("session.long_running")).toHaveLength(1);

    vi.advanceTimersByTime(28_000);
    emitDiagnosticEvent({ type: "run.progress", ...session, reason: "stream" });
    vi.advanceTimersByTime(2_000);

    const longRunningEvents = eventsOf("session.long_running");
    expect(longRunningEvents).toHaveLength(1);
    expect(longRunningEvents[0]).toMatchObject({
      classification: "long_running",
      reason: "active_work",
      activeWorkKind: "embedded_run",
      queueDepth: 0,
    });
    expect(
      events.some((event) => event.type === "session.stuck" || event.type === "session.stalled"),
    ).toBe(false);
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("reports terminal embedded progress without inventing queued recovery", () => {
    const terminalReason = "codex_app_server:notification:rawResponseItem/completed";
    startHeartbeat();
    logMessageQueued({ ...session, source: "test" });
    logSessionStateChange({ ...session, state: "processing" });
    markDiagnosticEmbeddedRunStarted(session);
    markDiagnosticRunProgress({ ...session, reason: terminalReason });
    vi.advanceTimersByTime(29_999);
    logMessageQueued({ ...session, source: "test" });
    vi.advanceTimersByTime(30_001);

    const attention = events.filter(({ type }) =>
      ["session.long_running", "session.stalled", "session.stuck"].includes(type),
    );
    expect(attention.at(-1)).toMatchObject({
      type: "session.stalled",
      reason: "queued_behind_terminal_active_work",
      activeWorkKind: "embedded_run",
      queueDepth: 1,
      terminalProgressStale: true,
      lastProgressReason: terminalReason,
    });
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("starts and stops the stability recorder with the heartbeat lifecycle", () => {
    startHeartbeat();
    logSessionStateChange({ ...session, state: "processing" });

    expectStability({ type: "session.state", outcome: "processing" });
    const [event] = getDiagnosticStabilitySnapshot({ limit: 10 }).events;
    expect(event).not.toHaveProperty("sessionId");
    expect(event).not.toHaveProperty("sessionKey");

    resetDiagnosticStateForTest();
    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });

    expect(getDiagnosticStabilitySnapshot({ limit: 10 }).events).toStrictEqual([]);
  });

  it("does not track session state when diagnostics are disabled", () => {
    setDiagnosticsEnabledForProcess(false);
    logSessionStateChange({ ...session, state: "processing" });

    expect(events).toStrictEqual([]);
    expect(diagnosticSessionStates.size).toBe(0);
  });

  it("records idle liveness samples without warning in the gateway log", () => {
    const emitMemorySample = createEmitMemorySampleMock();
    startHeartbeat({
      emitMemorySample,
      sampleLiveness: () =>
        livenessSample({
          reasons: ["cpu"],
          eventLoopDelayP99Ms: 12,
          eventLoopDelayMaxMs: 22,
          eventLoopUtilization: 0.99,
          cpuCoreRatio: 1,
        }),
    });

    vi.advanceTimersByTime(30_000);

    expect(events.map((event) => event.type)).toContain("diagnostic.liveness.warning");
    expectLoggerMessageContaining(warnSpy, "liveness warning:", false);
    expect(emitMemorySample).toHaveBeenLastCalledWith({ emitSample: true });
    expectStability({
      type: "diagnostic.liveness.warning",
      level: "info",
      reason: "cpu",
      durationMs: 30_000,
      active: 0,
      waiting: 0,
      queued: 0,
    });

    logMessageQueued({ ...session, source: "test" });
    vi.advanceTimersByTime(30_000);
    expectLoggerMessageContaining(warnSpy, "liveness warning:");
  });

  it("warns and records the full duration for persistent idle event-loop degradation", () => {
    startHeartbeat({
      emitMemorySample: createEmitMemorySampleMock(),
      sampleLiveness: () =>
        livenessSample({
          degradedSinceMs: 60_000,
          eventLoopDelayP99Ms: 1_200,
          eventLoopDelayMaxMs: 1_500,
        }),
    });

    vi.advanceTimersByTime(30_000);

    expectLoggerMessageContaining(warnSpy, "degradedFor=60s");
    expect(lastEvent("diagnostic.liveness.warning")).toMatchObject({ degradedSinceMs: 60_000 });
    expectStability({ type: "diagnostic.liveness.warning", level: "warning", durationMs: 60_000 });

    vi.advanceTimersByTime(90_000);
    expect(eventsOf("diagnostic.liveness.warning")).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(eventsOf("diagnostic.liveness.warning")).toHaveLength(2);
  });

  it("suppresses liveness warnings during startupGraceMs while still sampling", () => {
    const sampleLiveness = vi.fn(() => livenessSample());

    startHeartbeat({
      emitMemorySample: createEmitMemorySampleMock(),
      recoverStuckSession,
      sampleLiveness,
      startupGraceMs: 60_000,
      testTimings: { stuckSessionWarnMs: 1_000, stuckSessionAbortMs: 1_000 },
    });

    logMessageQueued({ ...session, source: "test" });
    logSessionStateChange({ ...session, state: "processing" });
    markDiagnosticEmbeddedRunStarted(session);
    vi.setSystemTime(1_001);
    for (const tick of [1, 2]) {
      vi.advanceTimersByTime(30_000);
      expect(sampleLiveness).toHaveBeenCalledTimes(tick);
      if (tick === 1) {
        expectLoggerMessageContaining(warnSpy, "liveness heartbeat delayed", false);
      }
      expectLoggerMessageContaining(warnSpy, "liveness warning:", tick === 2);
      expect(events.some(({ type }) => type === "diagnostic.liveness.warning")).toBe(tick === 2);
      expect(recoverStuckSession).not.toHaveBeenCalled();
    }
  });

  it("adds phase and work labels to liveness warnings", async () => {
    await withDiagnosticPhase("stale.phase", () => undefined);
    vi.advanceTimersByTime(60_000);
    await withDiagnosticPhase("recent.phase", () => undefined);
    const { promise, resolve: completePhase } = createDeferredCore();
    const phase = withDiagnosticPhase("startup.plugins.load", () => promise);

    try {
      startHeartbeat({
        emitMemorySample: createEmitMemorySampleMock(),
        sampleLiveness: () => livenessSample(),
      });

      logMessageQueued({ ...session, source: "telegram" });
      vi.advanceTimersByTime(30_000);
    } finally {
      completePhase();
      await phase;
    }

    expectLoggerMessageContaining(warnSpy, "phase=startup.plugins.load");
    expectLoggerMessageContaining(warnSpy, "work=[queued=main(");
    expectLoggerMessageContaining(warnSpy, "recentPhases=recent.phase:");
    expectLoggerMessageContaining(warnSpy, "stale.phase", false);
    expect(lastEvent("diagnostic.liveness.warning")).toMatchObject({
      recentPhases: [expect.objectContaining({ name: "recent.phase" })],
      phase: "startup.plugins.load",
      queuedWorkLabels: expect.arrayContaining([expect.stringContaining("main(")]),
    });
  });

  it.each(["before", "after"])(
    "counts only waiting messages when admission happens %s enqueue",
    (admission) => {
      startHeartbeat({
        emitMemorySample: createEmitMemorySampleMock(),
        sampleLiveness: () => livenessSample({ eventLoopDelayP99Ms: 53.6 }),
      });

      const message = createDiagnosticMessageLifecycle({
        ...session,
        enabled: true,
        channel: "cron",
        source: "cron-isolated",
        trackSessionState: true,
      });
      const operation =
        admission === "before"
          ? createReplyOperation({ ...session, resetTriggered: false })
          : undefined;
      message.markProcessing();
      const admittedOperation =
        operation ?? createReplyOperation({ ...session, resetTriggered: false });
      try {
        vi.advanceTimersByTime(30_000);

        expectLoggerMessageContaining(warnSpy, "liveness warning:", false);
        expectStability({
          type: "diagnostic.liveness.warning",
          level: "info",
          active: 1,
          waiting: 0,
          queued: 0,
        });

        message.markProcessing();
        vi.advanceTimersByTime(120_000);
        expectLoggerMessageContaining(warnSpy, "liveness warning:");
        expectStability(
          {
            type: "diagnostic.liveness.warning",
            level: "warning",
            active: 1,
            waiting: 0,
            queued: 1,
          },
          20,
        );
      } finally {
        admittedOperation.complete();
      }
    },
  );
});
