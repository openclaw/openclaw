import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { emitCoreModelRequestStartedDiagnosticEvent } from "../infra/diagnostic-model-request.js";
import { emitCoreSemanticRunProgressDiagnosticEvent } from "../infra/diagnostic-semantic-run-progress.js";
import { DEFAULT_UNDICI_STREAM_TIMEOUT_MS } from "../infra/net/undici-global-dispatcher.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withDiagnosticPhase } from "./diagnostic-phase.js";
import {
  beginDiagnosticBackendActivity,
  closeDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  createDiagnosticEmbeddedRunOwner,
  markDiagnosticEmbeddedRunEnded,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "./diagnostic-run-activity.js";
import {
  markDiagnosticModelStartedForTest,
  markDiagnosticToolStartedForTest,
} from "./diagnostic-run-activity.test-support.js";
import type { SessionAttentionClassification } from "./diagnostic-session-attention.js";
import {
  requestStuckSessionRecovery,
  resetDiagnosticSessionRecoveryCoordinatorForTest,
} from "./diagnostic-session-recovery-coordinator.js";
import type { StuckSessionRecoveryOutcome } from "./diagnostic-session-recovery.js";
import {
  diagnosticSessionStates,
  getDiagnosticSessionState,
  peekDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "./diagnostic-session-state.js";
import {
  getDiagnosticStabilitySnapshot,
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "./diagnostic-stability.js";
import {
  diagnosticLogger,
  logMessageQueued,
  logSessionStateChange,
  markDiagnosticSessionProgress,
} from "./diagnostic.js";
import {
  resetDiagnosticStateForTest,
  resolveStuckSessionAbortMs,
  resolveStuckSessionWarnMs,
  startDiagnosticHeartbeatForTest as startDiagnosticHeartbeat,
  startEnabledDiagnosticHeartbeatForTest as startEnabledDiagnosticHeartbeat,
} from "./diagnostic.test-support.js";

function createEmitMemorySampleMock() {
  return vi.fn(() => ({
    rssBytes: 100,
    heapTotalBytes: 80,
    heapUsedBytes: 40,
    externalBytes: 10,
    arrayBuffersBytes: 5,
  }));
}

function flushDiagnosticEvents() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** Drives a lane that keeps receiving inbound, the traffic that refreshes lastActivity. */
function advanceLaneWithInbound(params: {
  sessionId: string;
  sessionKey: string;
  totalMs: number;
  inboundEveryMs: number;
  onInbound?: () => void;
}) {
  const ticks = Math.floor(params.totalMs / params.inboundEveryMs);
  for (let i = 0; i < ticks; i += 1) {
    vi.advanceTimersByTime(params.inboundEveryMs);
    logMessageQueued({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      source: "dispatch",
    });
    params.onInbound?.();
  }
}

const requireRecord = createRequireRecord("object", "label-not-object");

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function requireMatchingRecord(
  items: readonly unknown[],
  fields: Record<string, unknown>,
  label: string,
) {
  expect(items, label).toContainEqual(expect.objectContaining(fields));
}

type DiagnosticMock = { mock: { calls: unknown[][] } };

function requireFirstMockCallArg(mock: DiagnosticMock, label: string) {
  return requireRecord(mock.mock.calls[0]?.[0], `${label} argument`);
}

function expectLoggerMessageContaining(spy: unknown, text: string): void {
  expect(spy).toHaveBeenCalledWith(expect.stringContaining(text));
}

function expectNoLoggerMessageContaining(spy: unknown, text: string): void {
  expect(spy).not.toHaveBeenCalledWith(expect.stringContaining(text));
}

function expectRecoveryCall(recoverStuckSession: DiagnosticMock, fields: Record<string, unknown>) {
  const params = requireFirstMockCallArg(recoverStuckSession, "recoverStuckSession");
  expectRecordFields(params, fields);
  expect(typeof params.ageMs).toBe("number");
  expect(typeof params.stateGeneration).toBe("number");
}

describe("diagnostic session state pruning", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDiagnosticSessionStateForTest();
  });

  afterEach(() => {
    resetDiagnosticSessionStateForTest();
    vi.useRealTimers();
  });

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

  it("canonicalizes sessionId-only state when the sessionKey becomes known", () => {
    const sessionKey = "agent:main:demo-channel:channel:c1";
    const pending = getDiagnosticSessionState({ sessionId: "s1" });
    pending.queueDepth = 1;

    const keyed = getDiagnosticSessionState({ sessionId: "s1", sessionKey });

    expect(keyed).toBe(pending);
    expect(keyed.queueDepth).toBe(1);
    expect(diagnosticSessionStates.has("s1")).toBe(false);
    expect(diagnosticSessionStates.get(sessionKey)).toBe(keyed);
    expect(getDiagnosticSessionState({ sessionKey })).toBe(keyed);
    expect(getDiagnosticSessionState({ sessionId: "s1" })).toBe(keyed);
    expect(diagnosticSessionStates.size).toBe(1);
  });

  it("merges split sessionId and sessionKey state without leaving stale queued work", () => {
    const sessionKey = "agent:main:demo-channel:channel:c1";
    const keyed = getDiagnosticSessionState({ sessionKey });
    keyed.queueDepth = 1;
    keyed.lastActivity = 1;
    const bySessionId = getDiagnosticSessionState({ sessionId: "s1" });
    bySessionId.queueDepth = 1;
    bySessionId.state = "processing";
    bySessionId.lastActivity = 2;

    const merged = getDiagnosticSessionState({ sessionId: "s1", sessionKey });

    expect(merged).toBe(keyed);
    expect(merged.queueDepth).toBe(2);
    expect(merged.state).toBe("processing");
    expect(diagnosticSessionStates.has("s1")).toBe(false);
    expect(diagnosticSessionStates.size).toBe(1);

    logSessionStateChange({ sessionId: "s1", sessionKey, state: "idle", reason: "run_completed" });
    logSessionStateChange({ sessionKey, state: "idle", reason: "message_completed" });

    expect(getDiagnosticSessionState({ sessionKey }).queueDepth).toBe(0);
    expect(diagnosticSessionStates.size).toBe(1);
  });
});

describe("diagnostic session activity aliases", () => {
  beforeEach(() => {
    resetDiagnosticStateForTest();
  });

  afterEach(() => {
    resetDiagnosticStateForTest();
  });

  it("keeps embedded diagnostic work active until every owner ends", () => {
    markDiagnosticEmbeddedRunStarted({ sessionId: "s1" });
    markDiagnosticEmbeddedRunStarted({
      sessionId: "s1",
      sessionKey: "main",
      workKey: "reply:main",
    });

    expect(getDiagnosticSessionActivitySnapshot({ sessionKey: "main" }).activeWorkKind).toBe(
      "embedded_run",
    );
    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "s1" }).activeWorkKind).toBe(
      "embedded_run",
    );

    markDiagnosticEmbeddedRunEnded({
      sessionId: "s1",
      sessionKey: "main",
      workKey: "reply:main",
      clearRunActivity: false,
    });

    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "s1", sessionKey: "main" })).toEqual(
      expect.objectContaining({ activeWorkKind: "embedded_run" }),
    );

    markDiagnosticEmbeddedRunEnded({ sessionId: "s1", sessionKey: "main" });

    expect(
      getDiagnosticSessionActivitySnapshot({ sessionId: "s1", sessionKey: "main" }).activeWorkKind,
    ).toBeUndefined();
  });
});

describe("stuck session diagnostics threshold", () => {
  const session = { sessionId: "s1", sessionKey: "main" };
  let events: DiagnosticEventPayload[];

  beforeEach(() => {
    vi.useFakeTimers();
    resetDiagnosticStateForTest();
    resetDiagnosticEventsForTest();
    events = [];
    onDiagnosticEvent((event) => events.push(event));
    vi.spyOn(diagnosticLogger, "isEnabled").mockReturnValue(true);
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticStateForTest();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not count a single in-flight turn as queued work without an active run", () => {
    const recoverStuckSession = vi.fn();
    const sessionFile = "/tmp/openclaw-heartbeat-session.jsonl";
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logMessageQueued({ ...session, source: "test" });
    logSessionStateChange({ ...session, sessionFile, state: "processing" });
    vi.advanceTimersByTime(61_000);

    expect(events.some((event) => event.type === "session.long_running")).toBe(false);
    const stuckEvents = events.filter((event) => event.type === "session.stuck");
    expect(stuckEvents).toHaveLength(1);
    expectRecordFields(requireRecord(stuckEvents[0], "stuck event"), {
      classification: "stale_session_state",
      reason: "stale_session_state",
      queueDepth: 0,
    });
    expectRecoveryCall(recoverStuckSession, { ...session, sessionFile, queueDepth: 0 });
  });

  it("defers a material heartbeat stall even when elapsed time is below the abort threshold", () => {
    const recoverStuckSession = vi.fn();
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    vi.setSystemTime(0);
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({ ...session, state: "processing" });
    markDiagnosticEmbeddedRunStarted(session);

    vi.advanceTimersByTime(20_000);
    markDiagnosticSessionProgress(session);
    markDiagnosticRunProgress({
      ...session,
      reason: "embedded_run:progress",
    });
    vi.advanceTimersByTime(10_000);

    vi.setSystemTime(35_000);
    vi.advanceTimersByTime(30_000);

    expectLoggerMessageContaining(warnSpy, "liveness heartbeat delayed");
    expect(recoverStuckSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);

    expectRecoveryCall(recoverStuckSession, { ...session, queueDepth: 0, allowActiveAbort: true });
  });

  it("does not let ordinary heartbeat jitter consume the remaining abort budget", () => {
    const recoverStuckSession = vi.fn();
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    vi.setSystemTime(0);
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({ ...session, state: "processing" });
    markDiagnosticEmbeddedRunStarted(session);

    vi.advanceTimersByTime(15_500);
    markDiagnosticSessionProgress(session);
    markDiagnosticRunProgress({
      ...session,
      reason: "embedded_run:progress",
    });
    vi.advanceTimersByTime(14_500);

    vi.setSystemTime(30_999);
    vi.advanceTimersByTime(30_000);

    expectNoLoggerMessageContaining(warnSpy, "liveness heartbeat delayed");
    expect(recoverStuckSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);

    expectRecoveryCall(recoverStuckSession, { ...session, queueDepth: 0, allowActiveAbort: true });
  });

  it("backs off repeated stuck warnings while a session remains unchanged", () => {
    const stuckEvents = () => events.filter((event) => event.type === "session.stuck");
    const recoverStuckSession = vi.fn();
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({ ...session, state: "processing" });
    vi.advanceTimersByTime(91_000);
    expect(stuckEvents()).toHaveLength(1);
    expect(recoverStuckSession).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(31_000);

    expect(stuckEvents().map((event) => event.ageMs)).toEqual([60_000, 120_000]);
    expect(recoverStuckSession).toHaveBeenCalledTimes(3);
    expect(
      events
        .filter((event) => event.type === "session.recovery.requested")
        .map((event) => event.ageMs),
    ).toEqual([60_000, 90_000, 120_000]);
  });

  it("aborts and drains embedded runs after an extended no-progress stall", () => {
    const recoverStuckSession = vi.fn();
    const stuckSessionWarnMs = resolveStuckSessionWarnMs() / 4;
    const stuckSessionAbortMs = resolveStuckSessionAbortMs(stuckSessionWarnMs);
    expect(stuckSessionWarnMs).toBe(30_000);
    expect(stuckSessionAbortMs).toBe(300_000);
    startEnabledDiagnosticHeartbeat({
      recoverStuckSession,
      testTimings: { stuckSessionWarnMs, stuckSessionAbortMs },
    });
    logSessionStateChange({ ...session, state: "processing" });
    markDiagnosticEmbeddedRunStarted(session);

    vi.advanceTimersByTime(stuckSessionAbortMs - 30_000);
    expect(recoverStuckSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);

    const stalledEvents = events.filter((event) => event.type === "session.stalled");
    expect(stalledEvents.length).toBeGreaterThan(0);
    expectRecordFields(requireRecord(stalledEvents.at(-1), "stalled event"), {
      classification: "stalled_agent_run",
      reason: "active_work_without_progress",
      activeWorkKind: "embedded_run",
    });
    expectRecoveryCall(recoverStuckSession, { ...session, queueDepth: 0, allowActiveAbort: true });
  });

  it("reports blocked tool calls on a lane whose inbound keeps refreshing the session clock", () => {
    const recoverStuckSession = vi.fn();
    startDiagnosticHeartbeat({ diagnostics: { enabled: true } }, { recoverStuckSession });
    logSessionStateChange({ ...session, state: "processing" });
    getDiagnosticSessionState(session).lastActivity = Date.now() - 120_000;
    markDiagnosticEmbeddedRunStarted(session);
    markDiagnosticToolStartedForTest({
      ...session,
      runId: "run-1",
      toolName: "bash",
      toolCallId: "cmd-1",
    });

    vi.advanceTimersByTime(60_000);
    expect(recoverStuckSession).not.toHaveBeenCalled();

    advanceLaneWithInbound({
      ...session,
      totalMs: 20 * 60_000,
      inboundEveryMs: 25_000,
    });

    const stalled = requireRecord(
      events.findLast((event) => event.type === "session.stalled"),
      "stalled event",
    );
    expectRecordFields(stalled, {
      classification: "blocked_tool_call",
      reason: "blocked_tool_call",
      activeWorkKind: "tool_call",
      activeToolName: "bash",
      activeToolCallId: "cmd-1",
    });
    expect(stalled.ageMs).toBeGreaterThanOrEqual(15 * 60_000);
    const recovery = requireFirstMockCallArg(recoverStuckSession, "recoverStuckSession");
    expectRecordFields(recovery, { ...session, allowActiveAbort: true });
    expect(recovery.ageMs).toBeGreaterThanOrEqual(15 * 60_000);
  });

  it("keeps a lane with fresh owned progress quiet while inbound keeps arriving", () => {
    const recoverStuckSession = vi.fn();
    startDiagnosticHeartbeat({ diagnostics: { enabled: true } }, { recoverStuckSession });
    logSessionStateChange({ ...session, state: "processing" });
    markDiagnosticEmbeddedRunStarted(session);
    markDiagnosticToolStartedForTest({
      ...session,
      runId: "run-1",
      toolName: "bash",
      toolCallId: "cmd-1",
    });

    advanceLaneWithInbound({
      ...session,
      totalMs: 20 * 60_000,
      inboundEveryMs: 25_000,
      onInbound: () => {
        markDiagnosticRunProgress({
          ...session,
          runId: "run-1",
          reason: "cli_live:stream_progress",
        });
      },
    });

    expect(events.some((event) => event.type === "session.stalled")).toBe(false);
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("leaves a busy lane with no owned work on the session clock", () => {
    const recoverStuckSession = vi.fn();
    startDiagnosticHeartbeat({ diagnostics: { enabled: true } }, { recoverStuckSession });
    logSessionStateChange({ ...session, state: "processing" });
    markDiagnosticEmbeddedRunStarted(session);
    markDiagnosticToolStartedForTest({
      ...session,
      runId: "run-1",
      toolName: "bash",
      toolCallId: "cmd-1",
    });
    // Terminal-but-unreleased state: the owner is gone, the activity row is not.
    // Recording that fact belongs to the run lifecycle, not to this gate.
    markDiagnosticEmbeddedRunEnded(session);
    expect(getDiagnosticSessionActivitySnapshot(session).activeWorkKind).toBeUndefined();

    advanceLaneWithInbound({
      ...session,
      totalMs: 20 * 60_000,
      inboundEveryMs: 25_000,
    });

    expect(events.some((event) => event.type === "session.stalled")).toBe(false);
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it.each(["model_call", "tool_call"] as const)(
    "recovers repeated request attempts during %s despite fresh mechanical activity",
    async (activeWorkKind) => {
      const recoverStuckSession = vi.fn(() => new Promise<never>(() => {}));
      const stuckSessionWarnMs = 30_000;
      const stuckSessionAbortMs = activeWorkKind === "tool_call" ? 900_000 : 90_000;
      startEnabledDiagnosticHeartbeat({
        recoverStuckSession,
        testTimings: { stuckSessionWarnMs, stuckSessionAbortMs },
      });
      logSessionStateChange({ ...session, state: "processing" });
      markDiagnosticEmbeddedRunStarted({ ...session, runId: "run-1" });
      markDiagnosticModelStartedForTest({
        ...session,
        runId: "run-1",
        provider: "mock",
        model: "retrying-model",
        observationUnit: "request",
      });
      if (activeWorkKind === "tool_call") {
        // An open tool must not hide mature repeated-request evidence.
        markDiagnosticToolStartedForTest({
          ...session,
          runId: "run-1",
          toolName: "read",
          toolCallId: "read-during-retries",
        });
      }

      for (let attempt = 2; attempt <= 6; attempt += 1) {
        vi.advanceTimersByTime(stuckSessionAbortMs / 3);
        logSessionStateChange({
          ...session,
          state: "processing",
          reason: "run_started",
        });
        markDiagnosticModelStartedForTest({
          ...session,
          runId: "run-1",
          provider: "mock",
          model: "retrying-model",
          observationUnit: "request",
        });
      }

      const stalled = events.find(
        (event) =>
          event.type === "session.stalled" &&
          event.reason === "repeated_model_requests_without_progress",
      );
      expectRecordFields(requireRecord(stalled, "stalled event"), {
        classification: "stalled_agent_run",
        reason: "repeated_model_requests_without_progress",
        repeatedRequestNoProgressAgeMs: stuckSessionAbortMs,
        activeWorkKind,
        activeToolAgeMs: activeWorkKind === "tool_call" ? stuckSessionAbortMs : undefined,
      });
      expect(recoverStuckSession).toHaveBeenCalledTimes(1);
      expectRecoveryCall(recoverStuckSession, {
        ...session,
        queueDepth: 0,
        allowActiveAbort: true,
      });
    },
  );

  it("does not recover repeated requests after semantic output resets the clock", async () => {
    const recoverStuckSession = vi.fn();
    const stuckSessionAbortMs = 90_000;
    startEnabledDiagnosticHeartbeat({
      recoverStuckSession,
      testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs },
    });
    const ref = { ...session, runId: "run-1" };
    logSessionStateChange({ ...ref, state: "processing" });
    markDiagnosticEmbeddedRunStarted(ref);
    markDiagnosticModelStartedForTest({
      ...ref,
      provider: "mock",
      model: "retrying-model",
      observationUnit: "request",
    });
    vi.advanceTimersByTime(30_000);
    markDiagnosticModelStartedForTest({
      ...ref,
      provider: "mock",
      model: "retrying-model",
      observationUnit: "request",
    });
    emitCoreSemanticRunProgressDiagnosticEvent({
      ...ref,
      reason: "assistant:progress",
    });
    await vi.advanceTimersByTimeAsync(0);

    for (let elapsedMs = 0; elapsedMs < stuckSessionAbortMs; elapsedMs += 30_000) {
      vi.advanceTimersByTime(30_000);
      markDiagnosticRunProgress({
        ...ref,
        reason: "model_call:stream_progress",
      });
    }

    expect(
      events.some(
        (event) =>
          event.type === "session.stalled" &&
          event.reason === "repeated_model_requests_without_progress",
      ),
    ).toBe(false);
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("recovers silent model calls only after the abort threshold", async () => {
    const recoverStuckSession = vi.fn();
    const stuckSessionWarnMs = 30_000;
    const stuckSessionAbortMs = 90_000;
    startEnabledDiagnosticHeartbeat({
      recoverStuckSession,
      testTimings: { stuckSessionWarnMs, stuckSessionAbortMs },
    });
    logSessionStateChange({ ...session, state: "processing" });
    markDiagnosticEmbeddedRunStarted(session);
    markDiagnosticModelStartedForTest({
      ...session,
      runId: "run-1",
      provider: "openai",
      model: "gpt-5",
    });

    vi.advanceTimersByTime(60_000);

    expect(events.some((event) => event.type === "session.stalled")).toBe(false);
    expect(events.findLast((event) => event.type === "session.long_running")).toMatchObject({
      classification: "long_running",
      reason: "active_model_call_without_progress",
      activeWorkKind: "model_call",
      lastProgressReason: "model_call:started",
    });
    expect(recoverStuckSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);
    expect(events.findLast((event) => event.type === "session.stalled")).toMatchObject({
      classification: "stalled_agent_run",
      reason: "active_work_without_progress",
      activeWorkKind: "model_call",
      lastProgressReason: "model_call:started",
    });
    expectRecoveryCall(recoverStuckSession, { ...session, queueDepth: 0, allowActiveAbort: true });
  });

  it("preserves a fresh model request allowance after semantic progress", async () => {
    const recoverStuckSession = vi.fn(() => new Promise<never>(() => {}));
    const ref = { sessionId: "allowance-session", sessionKey: "agent:main:allowance" };
    const runId = "allowance-run";
    const requestTimeoutMs = 150_000;
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    startEnabledDiagnosticHeartbeat({
      recoverStuckSession,
      testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 60_000 },
    });
    logSessionStateChange({ ...ref, state: "processing" });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner });
    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...ref,
        runId,
        callId: "call-1",
        provider: "mock",
        model: "slow-model",
      },
      owner.generation,
      requestTimeoutMs,
    );
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(120_000);
    emitCoreSemanticRunProgressDiagnosticEvent({ ...ref, runId, reason: "assistant:progress" });
    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...ref,
        runId,
        callId: "call-2",
        provider: "mock",
        model: "slow-model",
      },
      owner.generation,
      requestTimeoutMs,
    );
    await vi.advanceTimersByTimeAsync(0);

    // Semantic progress gives the next request its full provider allowance.
    vi.advanceTimersByTime(30_000);
    expect(recoverStuckSession).not.toHaveBeenCalled();
    vi.advanceTimersByTime(120_000);

    expectRecoveryCall(recoverStuckSession, { ...ref, queueDepth: 0, allowActiveAbort: true });
  });

  it("honors the local no-gap allowance and recovers after its finite ceiling", async () => {
    // Local no-gap requests retain a finite recovery ceiling (#125147, #125388).
    const recoverStuckSession = vi.fn();
    const ref = { sessionId: "local-no-gap-session", sessionKey: "agent:jin:subagent:local" };
    const runId = "local-no-gap-run";
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    startDiagnosticHeartbeat(
      { diagnostics: { enabled: true } },
      {
        recoverStuckSession,
        testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 60_000 },
      },
    );
    logSessionStateChange({ ...ref, state: "processing" });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner });
    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...ref,
        runId,
        callId: "call-1",
        provider: "ollama",
        model: "qwen3.5:9b-q8_0",
      },
      owner.generation,
      DEFAULT_UNDICI_STREAM_TIMEOUT_MS,
    );
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(15 * 60_000);

    expect(recoverStuckSession).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DEFAULT_UNDICI_STREAM_TIMEOUT_MS - 15 * 60_000 + 60_000);
    expect(recoverStuckSession).toHaveBeenCalled();
  });

  it("defers a quiet backend until its owned silence deadline expires", () => {
    const recoverStuckSession = vi.fn();
    const ref = { sessionId: "backend-deadline", sessionKey: "agent:main:backend-deadline" };
    const runId = "backend-deadline-run";
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({ ...ref, state: "processing" });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner });
    const backend = beginDiagnosticBackendActivity({
      owner,
      noOutputTimeoutMs: 180_000,
      assertCurrent: () => {},
    });
    try {
      // No output has arrived: initial silence still belongs to the backend's deadline.
      vi.advanceTimersByTime(120_000);
      expect(recoverStuckSession).not.toHaveBeenCalled();

      vi.advanceTimersByTime(60_000);
      expectRecoveryCall(recoverStuckSession, { ...ref, queueDepth: 0, allowActiveAbort: true });
    } finally {
      backend.close();
      closeDiagnosticEmbeddedRunOwner(owner);
    }
  });

  it("recovers idle queued work when embedded ownership is surfaced as a model call", async () => {
    const recoverStuckSession = vi.fn().mockResolvedValue({
      status: "aborted",
      action: "abort_embedded_run",
      ...session,
      activeSessionId: "s1",
      activeWorkKind: "embedded_run",
      aborted: true,
      drained: true,
      forceCleared: false,
      released: 0,
    });
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({ ...session, state: "processing" });
    markDiagnosticEmbeddedRunStarted(session);
    markDiagnosticModelStartedForTest({
      ...session,
      runId: "run-1",
      provider: "openai",
      model: "gpt-5",
    });
    logSessionStateChange({ ...session, state: "idle" });

    vi.advanceTimersByTime(59_000);
    logMessageQueued({ ...session, source: "test-followup" });
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();

    expectRecoveryCall(recoverStuckSession, {
      ...session,
      queueDepth: 1,
      allowActiveAbort: true,
      expectedState: "idle",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.recovery.completed",
        state: "idle",
        status: "aborted",
        action: "abort_embedded_run",
      }),
    );
    expect(getDiagnosticSessionState(session).queueDepth).toBe(0);
  });

  it("recovers idle queued work blocked by stale model activity without active ownership", async () => {
    const recoverStuckSession = vi.fn().mockResolvedValue({
      status: "released",
      action: "release_lane",
      reason: "no_active_work",
      ...session,
      released: 0,
    });
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({ ...session, state: "processing" });
    markDiagnosticModelStartedForTest({
      ...session,
      runId: "run-1",
      provider: "openai",
      model: "gpt-5",
    });
    logSessionStateChange({ ...session, state: "idle" });

    vi.advanceTimersByTime(59_000);
    logMessageQueued({ ...session, source: "test-followup" });
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();

    expect(events.findLast((event) => event.type === "session.stuck")).toMatchObject({
      type: "session.stuck",
      state: "idle",
      classification: "stale_session_state",
      reason: "queued_work_without_active_run",
      queueDepth: 1,
      lastProgressReason: "model_call:started",
    });
    expectRecoveryCall(recoverStuckSession, {
      ...session,
      queueDepth: 1,
      expectedState: "idle",
    });
    const recoveryParams = requireFirstMockCallArg(recoverStuckSession, "recoverStuckSession");
    expect(recoveryParams.allowActiveAbort).toBeUndefined();
    expect(getDiagnosticSessionState(session)).toMatchObject({ state: "idle", queueDepth: 0 });
  });

  it.each([
    {
      status: "aborted",
      action: "abort_embedded_run",
      aborted: true,
      drained: false,
      forceCleared: true,
    },
    { status: "released", action: "release_lane", reason: "stale_lane_task" },
  ] as const)(
    "preserves queued idle work when $status recovery releases active lane work",
    async (outcome) => {
      const recoverStuckSession = vi.fn().mockResolvedValue({
        ...session,
        activeSessionId: "s1",
        activeWorkKind: "embedded_run",
        released: 1,
        queuedCount: 1,
        ...outcome,
      });
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logSessionStateChange({ ...session, state: "processing" });
      markDiagnosticEmbeddedRunStarted(session);
      logSessionStateChange({ ...session, state: "idle" });

      vi.advanceTimersByTime(59_000);
      logMessageQueued({ ...session, source: "test-followup" });
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();

      requireMatchingRecord(
        events,
        {
          type: "session.state",
          state: "idle",
          reason: `stuck_recovery:${outcome.status}`,
          queueDepth: 1,
        },
        `idle ${outcome.status} preserves queued work`,
      );
      expect(getDiagnosticSessionState(session).queueDepth).toBe(1);
    },
  );

  it("deduplicates recovery while pending across unchanged and bumped generations", async () => {
    const { promise, resolve } = createDeferredCore<StuckSessionRecoveryOutcome>();
    const recoverStuckSession = vi.fn(() => promise);
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({ ...session, state: "processing" });
    markDiagnosticEmbeddedRunStarted(session);
    logSessionStateChange({ ...session, state: "idle" });
    try {
      vi.advanceTimersByTime(59_000);
      logMessageQueued({ ...session, source: "test" });
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      expect(recoverStuckSession).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(30_000);
      expect(recoverStuckSession).toHaveBeenCalledTimes(1);
      requireMatchingRecord(
        events,
        {
          type: "session.recovery.completed",
          status: "skipped",
          outcomeReason: "already_in_flight",
        },
        "skipped recovery event",
      );

      logMessageQueued({ ...session, source: "followup" });
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
      expect(recoverStuckSession).toHaveBeenCalledTimes(1);
      expect(events.filter((event) => event.type === "session.recovery.requested")).toHaveLength(1);
    } finally {
      resolve({
        status: "skipped",
        action: "observe_only",
        reason: "already_in_flight",
        ...session,
      });
      await Promise.resolve();
    }
  });

  it("throttles repeated long-running active-work warnings", async () => {
    const recoverStuckSession = vi.fn();
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({ ...session, state: "processing" });
    vi.advanceTimersByTime(45_000);
    markDiagnosticEmbeddedRunStarted(session);
    vi.advanceTimersByTime(16_000);

    expect(events.filter((event) => event.type === "session.long_running")).toHaveLength(1);

    vi.advanceTimersByTime(28_000);
    emitDiagnosticEvent({
      type: "run.progress",
      ...session,
      reason: "stream",
    });
    vi.advanceTimersByTime(2_000);

    expect(events.filter((event) => event.type === "session.long_running")).toHaveLength(1);

    const longRunningEvents = events.filter((event) => event.type === "session.long_running");
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

  it("recovers queued sessions behind terminal embedded progress after the abort threshold", () => {
    const recoverStuckSession = vi.fn();
    const stuckSessionWarnMs = 30_000;
    const stuckSessionAbortMs = 60_000;
    const terminalReason = "codex_app_server:notification:rawResponseItem/completed";
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logMessageQueued({ ...session, source: "test" });
    logSessionStateChange({ ...session, state: "processing" });
    markDiagnosticEmbeddedRunStarted(session);
    markDiagnosticRunProgress({
      ...session,
      reason: terminalReason,
    });
    vi.advanceTimersByTime(stuckSessionAbortMs - stuckSessionWarnMs - 1);
    logMessageQueued({ ...session, source: "test" });
    vi.advanceTimersByTime(stuckSessionWarnMs + 1);

    const attentionEvents = events.filter(
      (event) =>
        event.type === "session.long_running" ||
        event.type === "session.stalled" ||
        event.type === "session.stuck",
    );
    expectRecordFields(requireRecord(attentionEvents.at(-1), "final attention event"), {
      type: "session.stalled",
      classification: "stalled_agent_run",
      reason: "queued_behind_terminal_active_work",
      activeWorkKind: "embedded_run",
      queueDepth: 1,
      terminalProgressStale: true,
      lastProgressReason: terminalReason,
    });
    expectRecoveryCall(recoverStuckSession, { ...session, queueDepth: 1, allowActiveAbort: true });
  });

  it("starts and stops the stability recorder with the heartbeat lifecycle", () => {
    startEnabledDiagnosticHeartbeat();
    logSessionStateChange({ ...session, state: "processing" });

    requireMatchingRecord(
      getDiagnosticStabilitySnapshot({ limit: 10 }).events,
      { type: "session.state", outcome: "processing" },
      "session state stability event",
    );
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

  it("checks memory pressure every tick without recording idle samples", () => {
    const emitMemorySample = createEmitMemorySampleMock();

    startEnabledDiagnosticHeartbeat({ emitMemorySample, sampleLiveness: () => null });

    vi.advanceTimersByTime(30_000);
    expect(emitMemorySample).toHaveBeenLastCalledWith({ emitSample: false });

    logSessionStateChange({ ...session, state: "processing" });
    vi.advanceTimersByTime(30_000);

    expect(emitMemorySample).toHaveBeenLastCalledWith({ emitSample: true });
  });

  it("records idle liveness samples without warning in the gateway log", () => {
    const emitMemorySample = createEmitMemorySampleMock();
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    startEnabledDiagnosticHeartbeat({
      emitMemorySample,
      sampleLiveness: () => ({
        reasons: ["cpu"],
        intervalMs: 30_000,
        eventLoopDelayP99Ms: 12,
        eventLoopDelayMaxMs: 22,
        eventLoopUtilization: 0.99,
        cpuUserMs: 29_000,
        cpuSystemMs: 1_000,
        cpuTotalMs: 30_000,
        cpuCoreRatio: 1,
      }),
    });

    vi.advanceTimersByTime(30_000);

    expect(events.map((event) => event.type)).toContain("diagnostic.liveness.warning");
    expectNoLoggerMessageContaining(warnSpy, "liveness warning:");
    expect(emitMemorySample).toHaveBeenLastCalledWith({ emitSample: true });
    requireMatchingRecord(
      getDiagnosticStabilitySnapshot({ limit: 10 }).events,
      {
        type: "diagnostic.liveness.warning",
        level: "info",
        reason: "cpu",
        durationMs: 30_000,
        count: 1,
        eventLoopDelayP99Ms: 12,
        eventLoopDelayMaxMs: 22,
        eventLoopUtilization: 0.99,
        cpuCoreRatio: 1,
        active: 0,
        waiting: 0,
        queued: 0,
      },
      "idle liveness stability event",
    );

    logMessageQueued({ ...session, source: "test" });
    vi.advanceTimersByTime(30_000);
    expectLoggerMessageContaining(warnSpy, "liveness warning:");
  });

  it("warns and records the full duration for persistent idle event-loop degradation", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    startEnabledDiagnosticHeartbeat({
      emitMemorySample: createEmitMemorySampleMock(),
      sampleLiveness: () => ({
        reasons: ["event_loop_delay"],
        intervalMs: 30_000,
        degradedSinceMs: 60_000,
        eventLoopDelayP99Ms: 1_200,
        eventLoopDelayMaxMs: 1_500,
      }),
    });

    vi.advanceTimersByTime(30_000);

    expectLoggerMessageContaining(warnSpy, "degradedFor=60s");
    expect(events.findLast((event) => event.type === "diagnostic.liveness.warning")).toMatchObject({
      degradedSinceMs: 60_000,
    });
    requireMatchingRecord(
      getDiagnosticStabilitySnapshot({ limit: 10 }).events,
      {
        type: "diagnostic.liveness.warning",
        level: "warning",
        durationMs: 60_000,
      },
      "persistent liveness stability event",
    );

    vi.advanceTimersByTime(90_000);
    expect(events.filter((event) => event.type === "diagnostic.liveness.warning")).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(events.filter((event) => event.type === "diagnostic.liveness.warning")).toHaveLength(2);
  });

  it("suppresses liveness warnings during startupGraceMs while still sampling", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    const recoverStuckSession = vi.fn();
    const sampleLiveness = vi.fn(() => ({
      reasons: ["event_loop_delay" as const],
      intervalMs: 30_000,
      eventLoopDelayP99Ms: 1_500,
      eventLoopDelayMaxMs: 2_000,
    }));

    vi.setSystemTime(0);
    startEnabledDiagnosticHeartbeat({
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
    vi.advanceTimersByTime(30_000);

    expect(sampleLiveness).toHaveBeenCalledTimes(1);
    expectNoLoggerMessageContaining(warnSpy, "liveness heartbeat delayed");
    expectNoLoggerMessageContaining(warnSpy, "liveness warning:");
    expect(events.map((event) => event.type)).not.toContain("diagnostic.liveness.warning");
    expect(recoverStuckSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);

    expect(sampleLiveness).toHaveBeenCalledTimes(2);
    expectLoggerMessageContaining(warnSpy, "liveness warning:");
    expect(events.map((event) => event.type)).toContain("diagnostic.liveness.warning");
    expectRecoveryCall(recoverStuckSession, { ...session, queueDepth: 0, allowActiveAbort: true });
  });

  it("adds phase and work labels to liveness warnings", async () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    await withDiagnosticPhase("stale.phase", () => undefined);
    vi.advanceTimersByTime(60_000);
    await withDiagnosticPhase("recent.phase", () => undefined);
    const { promise, resolve: completePhase } = createDeferredCore();
    const phase = withDiagnosticPhase("startup.plugins.load", () => promise);

    try {
      startEnabledDiagnosticHeartbeat({
        emitMemorySample: createEmitMemorySampleMock(),
        sampleLiveness: () => ({
          reasons: ["event_loop_delay"],
          intervalMs: 30_000,
          eventLoopDelayP99Ms: 1_500,
          eventLoopDelayMaxMs: 2_000,
        }),
      });

      logMessageQueued({ ...session, source: "telegram" });
      vi.advanceTimersByTime(30_000);
    } finally {
      completePhase();
      await phase;
    }

    expectLoggerMessageContaining(warnSpy, "phase=startup.plugins.load");
    expectLoggerMessageContaining(warnSpy, "work=[queued=main(");
    const warning = requireRecord(
      events.findLast((event) => event.type === "diagnostic.liveness.warning"),
      "liveness warning event",
    );
    expectLoggerMessageContaining(warnSpy, "recentPhases=recent.phase:");
    expectNoLoggerMessageContaining(warnSpy, "stale.phase");
    expect(warning.recentPhases).toEqual([expect.objectContaining({ name: "recent.phase" })]);
    expect(warning.phase).toBe("startup.plugins.load");
    const queuedWorkLabels = warning.queuedWorkLabels;
    expect(Array.isArray(queuedWorkLabels)).toBe(true);
    if (!Array.isArray(queuedWorkLabels)) {
      throw new Error("liveness warning queuedWorkLabels was not an array");
    }
    expect(
      queuedWorkLabels.some((label) => typeof label === "string" && label.includes("main(")),
    ).toBe(true);
  });

  it("counts only messages waiting behind the active processing turn as liveness backlog", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    startEnabledDiagnosticHeartbeat({
      emitMemorySample: createEmitMemorySampleMock(),
      sampleLiveness: () => ({
        reasons: ["event_loop_delay"],
        intervalMs: 30_000,
        eventLoopDelayP99Ms: 53.6,
        eventLoopDelayMaxMs: 2_761.9,
        eventLoopUtilization: 0.785,
        cpuCoreRatio: 0.378,
      }),
    });

    logMessageQueued({ ...session, source: "discord" });
    logSessionStateChange({ ...session, state: "processing" });
    vi.advanceTimersByTime(30_000);

    expectNoLoggerMessageContaining(warnSpy, "liveness warning:");
    requireMatchingRecord(
      getDiagnosticStabilitySnapshot({ limit: 10 }).events,
      {
        type: "diagnostic.liveness.warning",
        level: "info",
        active: 1,
        waiting: 0,
        queued: 0,
      },
      "active processing liveness stability event",
    );

    logMessageQueued({ ...session, source: "discord" });
    vi.advanceTimersByTime(120_000);
    expectLoggerMessageContaining(warnSpy, "liveness warning:");
    requireMatchingRecord(
      getDiagnosticStabilitySnapshot({ limit: 20 }).events,
      {
        type: "diagnostic.liveness.warning",
        level: "warning",
        active: 1,
        waiting: 0,
        queued: 1,
      },
      "queued backlog liveness stability event",
    );
  });

  it("does not start the heartbeat when diagnostics are disabled by config", () => {
    const emitMemorySample = createEmitMemorySampleMock();

    startDiagnosticHeartbeat(
      {
        diagnostics: {
          enabled: false,
        },
      },
      { emitMemorySample },
    );
    vi.advanceTimersByTime(30_000);

    expect(emitMemorySample).not.toHaveBeenCalled();
  });
});

describe("diagnostic stability snapshots", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticStabilityRecorderForTest();
  });

  afterEach(() => {
    stopDiagnosticStabilityRecorder();
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
  });

  it("records bounded outbound delivery diagnostics without session identifiers", async () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "message.delivery.error",
      channel: "matrix",
      deliveryKind: "text",
      durationMs: 12,
      errorCategory: "TypeError",
      sessionKey: "session-secret",
    });
    await flushDiagnosticEvents();

    requireMatchingRecord(
      getDiagnosticStabilitySnapshot({ limit: 10 }).events,
      {
        type: "message.delivery.error",
        channel: "matrix",
        deliveryKind: "text",
        durationMs: 12,
        outcome: "error",
        reason: "TypeError",
      },
      "bounded outbound delivery stability event",
    );
    const [event] = getDiagnosticStabilitySnapshot({ limit: 10 }).events;
    expect(event).not.toHaveProperty("sessionKey");
    expect(event).not.toHaveProperty("sessionId");
  });
});

describe("stuck session recovery activity reconciliation", () => {
  const ref = { sessionKey: "agent:main:whatsapp:direct:demo", sessionId: "wa-run-1" };
  const stalledClassification: SessionAttentionClassification = {
    eventType: "session.stalled",
    reason: "active_work_without_progress",
    classification: "stalled_agent_run",
    activeWorkKind: "embedded_run",
    recoveryEligible: false,
  };

  function abortedOutcome(): StuckSessionRecoveryOutcome {
    return {
      ...ref,
      status: "aborted",
      action: "abort_embedded_run",
      activeSessionId: ref.sessionId,
      activeWorkKind: "embedded_run",
      aborted: true,
      drained: false,
      forceCleared: false,
      released: 0,
    };
  }

  function startSession(workKey?: string) {
    logSessionStateChange({ ...ref, state: "processing", reason: "run_started" });
    markDiagnosticEmbeddedRunStarted({ ...ref, workKey });
    const state = getDiagnosticSessionState(ref);
    state.queueDepth = 2;
    return state;
  }

  function markStaleActivity(sessionId = ref.sessionId) {
    markDiagnosticToolStartedForTest({
      ...ref,
      sessionId,
      toolName: "Bash",
      toolCallId: "old-tool",
    });
    markDiagnosticModelStartedForTest({
      ...ref,
      sessionId,
      runId: sessionId,
      provider: "openai",
      model: "gpt-5.5",
    });
  }

  async function recoverStalledSession(
    stateGeneration: number | undefined,
    recover = () => Promise.resolve(abortedOutcome()),
  ) {
    requestStuckSessionRecovery({
      recover,
      classification: stalledClassification,
      request: {
        ...ref,
        ageMs: 139_014,
        queueDepth: 2,
        allowActiveAbort: true,
        expectedState: "processing",
        stateGeneration,
      },
    });
    await flushDiagnosticEvents();
    await flushDiagnosticEvents();
  }

  beforeEach(() => {
    setDiagnosticsEnabledForProcess(true);
    resetDiagnosticSessionStateForTest();
    resetDiagnosticRunActivityForTest();
    startDiagnosticRunActivityTracking();
    resetDiagnosticSessionRecoveryCoordinatorForTest();
  });

  afterEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticRunActivityForTest();
    resetDiagnosticSessionRecoveryCoordinatorForTest();
  });

  it("clears old same-key owners and their tool/model markers after recovering custom reply work", async () => {
    markDiagnosticEmbeddedRunStarted({ ...ref, sessionId: "older-run-1" });
    const state = startSession(`reply:${ref.sessionKey}`);
    markStaleActivity();

    await recoverStalledSession(state.generation);

    expect(peekDiagnosticSessionState(ref)?.state).toBe("idle");
    const activity = getDiagnosticSessionActivitySnapshot(ref);
    expect(activity.activeWorkKind).toBeUndefined();
    expect(activity.hasActiveEmbeddedRun).toBeUndefined();
    expect(activity.activeToolName).toBeUndefined();
  });

  it.each([false, true])(
    "fences stale asynchronous starts after recovery (empty activity: %s)",
    async (empty) => {
      const state = startSession();
      if (empty) {
        markDiagnosticEmbeddedRunEnded(ref);
      }
      emitDiagnosticEvent({
        type: "tool.execution.started",
        ...ref,
        runId: ref.sessionId,
        toolName: "Bash",
        toolCallId: "late-tool",
      });
      emitDiagnosticEvent({
        type: "model.call.started",
        ...ref,
        runId: ref.sessionId,
        callId: "late-model",
        provider: "openai",
        model: "gpt-5.5",
      });

      await recoverStalledSession(state.generation);

      expect(peekDiagnosticSessionState(ref)?.state).toBe("idle");
      const activity = getDiagnosticSessionActivitySnapshot(ref);
      expect(activity.activeWorkKind).toBeUndefined();
      expect(activity.hasActiveEmbeddedRun).toBeUndefined();
      expect(activity.activeToolName).toBeUndefined();
    },
  );

  it("preserves a newer processing generation when recovery completes late", async () => {
    const state = startSession();
    await recoverStalledSession(state.generation, () => {
      const next = { ...ref, sessionId: "wa-run-2" };
      logSessionStateChange({ ...next, state: "processing", reason: "run_started" });
      markDiagnosticEmbeddedRunStarted(next);
      return Promise.resolve(abortedOutcome());
    });

    expect(peekDiagnosticSessionState(ref)?.state).toBe("processing");
    expect(getDiagnosticSessionActivitySnapshot(ref).activeWorkKind).toBe("embedded_run");
  });

  it("preserves fresh same-session tool activity rearmed after recovery starts", async () => {
    const state = startSession();
    await recoverStalledSession(state.generation, () => {
      markDiagnosticEmbeddedRunStarted(ref);
      emitDiagnosticEvent({
        type: "tool.execution.started",
        ...ref,
        runId: ref.sessionId,
        toolName: "FreshTool",
        toolCallId: "fresh-tool",
      });
      return Promise.resolve(abortedOutcome());
    });

    expect(peekDiagnosticSessionState(ref)?.state).toBe("processing");
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: "tool_call",
      hasActiveEmbeddedRun: true,
      activeToolName: "FreshTool",
    });
  });

  it("prunes stale same-key activity while preserving a different owner's fresh tool", async () => {
    markDiagnosticEmbeddedRunStarted({ ...ref, sessionId: "older-run-1" });
    markStaleActivity("older-run-1");
    const state = startSession();
    markStaleActivity();
    const reply = { ...ref, sessionId: "reply-run-1" };
    const replyTool = { ...reply, toolName: "ReplyTool", toolCallId: "fresh-tool" };

    await recoverStalledSession(state.generation, () => {
      markDiagnosticEmbeddedRunStarted(reply);
      emitDiagnosticEvent({
        type: "tool.execution.started",
        ...replyTool,
      });
      return Promise.resolve(abortedOutcome());
    });

    expect(peekDiagnosticSessionState(ref)?.state).toBe("processing");
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: "tool_call",
      hasActiveEmbeddedRun: true,
      activeToolName: "ReplyTool",
    });

    // Complete only the fresh tool so stale markers remain observable.
    emitDiagnosticEvent({ type: "tool.execution.completed", ...replyTool, durationMs: 0 });
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: "embedded_run",
      hasActiveEmbeddedRun: true,
      activeToolName: undefined,
    });

    markDiagnosticEmbeddedRunEnded({ ...reply, clearRunActivity: false });
    const activity = getDiagnosticSessionActivitySnapshot(ref);
    expect(activity.activeWorkKind).toBeUndefined();
    expect(activity.activeToolName).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
