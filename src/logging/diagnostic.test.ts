import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  emitDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { emitCoreModelRequestStartedDiagnosticEvent } from "../infra/diagnostic-model-request.js";
import { emitCoreSemanticRunProgressDiagnosticEvent } from "../infra/diagnostic-semantic-run-progress.js";
import { DEFAULT_UNDICI_STREAM_TIMEOUT_MS } from "../infra/net/undici-global-dispatcher.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { DiagnosticLivenessSample } from "./diagnostic-liveness.js";
import { withDiagnosticPhase } from "./diagnostic-phase.js";
import {
  beginDiagnosticBackendActivity,
  closeDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot as activity,
  createDiagnosticEmbeddedRunOwner,
  markDiagnosticEmbeddedRunEnded,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
} from "./diagnostic-run-activity.js";
import {
  markDiagnosticModelStartedForTest,
  markDiagnosticToolStartedForTest,
} from "./diagnostic-run-activity.test-support.js";
import {
  diagnosticSessionStates,
  getDiagnosticSessionState as sessionState,
  resetDiagnosticSessionStateForTest,
} from "./diagnostic-session-state.js";
import { getDiagnosticStabilitySnapshot as stability } from "./diagnostic-stability.js";
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
  startEnabledDiagnosticHeartbeatForTest as heartbeat,
} from "./diagnostic.test-support.js";

const session = { sessionId: "s1", sessionKey: "main" };
const processing = (ref: RunRef = session) =>
  logSessionStateChange({ ...ref, state: "processing" });
type RunRef = Parameters<typeof markDiagnosticEmbeddedRunStarted>[0];
function startHeartbeat(
  options: Omit<NonNullable<Parameters<typeof heartbeat>[0]>, "recoverStuckSession"> = {},
) {
  const recover = vi.fn();
  heartbeat({ ...options, recoverStuckSession: recover });
  return recover;
}
function beginRun(abortMs = 60_000, ref: RunRef = session) {
  const recover = startHeartbeat({
    testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: abortMs },
  });
  processing(ref);
  markDiagnosticEmbeddedRunStarted(ref);
  return recover;
}
function ownedRun(
  ref: RunRef,
  recover: NonNullable<Parameters<typeof heartbeat>[0]>["recoverStuckSession"],
) {
  const owner = createDiagnosticEmbeddedRunOwner(ref);
  heartbeat({ recoverStuckSession: recover });
  processing(ref);
  markDiagnosticEmbeddedRunStarted({ ...ref, owner });
  return owner;
}
function startModel(params: Partial<Parameters<typeof markDiagnosticModelStartedForTest>[0]> = {}) {
  markDiagnosticModelStartedForTest({
    ...session,
    runId: "run-1",
    provider: "openai",
    model: "gpt-5",
    ...params,
  });
}
function startTool() {
  markDiagnosticToolStartedForTest({
    ...session,
    runId: "run-1",
    toolName: "bash",
    toolCallId: "cmd-1",
  });
}
function startOwnedRequest(
  owner: ReturnType<typeof createDiagnosticEmbeddedRunOwner>,
  callId: string,
  timeoutMs: number,
  provider = "mock",
  model = "slow-model",
) {
  const { sessionId, sessionKey, runId } = owner;
  emitCoreModelRequestStartedDiagnosticEvent(
    { sessionId, sessionKey, runId, callId, provider, model },
    owner.generation,
    timeoutMs,
  );
}
function liveness(overrides: Partial<DiagnosticLivenessSample> = {}) {
  return {
    reasons: ["event_loop_delay"],
    intervalMs: 30_000,
    eventLoopDelayP99Ms: 1_500,
    eventLoopDelayMaxMs: 2_000,
    ...overrides,
  } satisfies DiagnosticLivenessSample;
}
function startLiveness(sample: DiagnosticLivenessSample) {
  heartbeat({ emitMemorySample: createEmitMemorySampleMock(), sampleLiveness: () => sample });
}
function createEmitMemorySampleMock() {
  return vi.fn(() => ({
    rssBytes: 100,
    heapTotalBytes: 80,
    heapUsedBytes: 40,
    externalBytes: 10,
    arrayBuffersBytes: 5,
  }));
}

/** Keep inbound traffic fresh for longer than the blocked-tool floor. */
function advanceLaneWithInbound(onInbound?: () => void) {
  for (let elapsed = 0; elapsed < 20 * 60_000; elapsed += 25_000) {
    vi.advanceTimersByTime(25_000);
    logMessageQueued({ ...session, source: "dispatch" });
    onInbound?.();
  }
}

const requireRecord = createRequireRecord("object", "label-not-object");

function expectStability(fields: Record<string, unknown>, limit = 10) {
  expect(stability({ limit }).events).toContainEqual(expect.objectContaining(fields));
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

function expectRecoveryCall(recover: DiagnosticMock, fields: Record<string, unknown>) {
  const params = requireFirstMockCallArg(recover, "recover");
  expect(params).toMatchObject(fields);
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
    sessionState({ sessionId: "stale-1" });
    expect(diagnosticSessionStates.size).toBe(1);

    vi.advanceTimersByTime(31 * 60 * 1000);
    sessionState({ sessionId: "fresh-1" });

    expect(diagnosticSessionStates.size).toBe(1);
  });

  it("caps tracked session states even when the oldest key is empty", () => {
    const oldestKey = "";
    const now = Date.now();
    for (let i = 0; i < 2001; i += 1) {
      vi.setSystemTime(now + i);
      sessionState({
        sessionKey: i === 0 ? oldestKey : `session-${i}`,
      }).queueDepth = 1;
    }

    expect(diagnosticSessionStates.size).toBe(2000);
    expect(diagnosticSessionStates.has(oldestKey)).toBe(false);
  });

  it("canonicalizes sessionId-only state when the sessionKey becomes known", () => {
    const sessionKey = "agent:main:demo-channel:channel:c1";
    const pending = sessionState({ sessionId: "s1" });
    pending.queueDepth = 1;

    const keyed = sessionState({ sessionId: "s1", sessionKey });

    expect(keyed).toBe(pending);
    expect(keyed.queueDepth).toBe(1);
    expect(diagnosticSessionStates.has("s1")).toBe(false);
    expect(diagnosticSessionStates.get(sessionKey)).toBe(keyed);
    expect(sessionState({ sessionKey })).toBe(keyed);
    expect(sessionState({ sessionId: "s1" })).toBe(keyed);
    expect(diagnosticSessionStates.size).toBe(1);
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

  it("merges split sessionId and sessionKey state without leaving stale queued work", () => {
    const sessionKey = "agent:main:demo-channel:channel:c1";
    const keyed = sessionState({ sessionKey });
    keyed.queueDepth = 1;
    keyed.lastActivity = 1;
    const bySessionId = sessionState({ sessionId: "s1" });
    bySessionId.queueDepth = 1;
    bySessionId.state = "processing";
    bySessionId.lastActivity = 2;

    const merged = sessionState({ sessionId: "s1", sessionKey });

    expect(merged).toBe(keyed);
    expect(merged.queueDepth).toBe(2);
    expect(merged.state).toBe("processing");
    expect(diagnosticSessionStates.has("s1")).toBe(false);
    expect(diagnosticSessionStates.size).toBe(1);

    logSessionStateChange({ sessionId: "s1", sessionKey, state: "idle", reason: "run_completed" });
    logSessionStateChange({ sessionKey, state: "idle", reason: "message_completed" });

    expect(sessionState({ sessionKey }).queueDepth).toBe(0);
    expect(diagnosticSessionStates.size).toBe(1);
  });
});

describe("stuck session diagnostics threshold", () => {
  let events: DiagnosticEventPayload[];
  const matchingEvents = <T extends DiagnosticEventPayload["type"]>(type: T) =>
    events.filter(
      (event): event is Extract<DiagnosticEventPayload, { type: T }> => event.type === type,
    );
  const lastEvent = <T extends DiagnosticEventPayload["type"]>(type: T) =>
    matchingEvents(type).at(-1);
  const repeatedRequestStall = () =>
    matchingEvents("session.stalled").find(
      (event) => event.reason === "repeated_model_requests_without_progress",
    );

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
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
    const recover = startHeartbeat();
    const sessionFile = "/tmp/openclaw-heartbeat-session.jsonl";
    logMessageQueued({ ...session, source: "test" });
    logSessionStateChange({ ...session, sessionFile, state: "processing" });
    vi.advanceTimersByTime(61_000);

    expect(events.some((event) => event.type === "session.long_running")).toBe(false);
    const stuckEvents = matchingEvents("session.stuck");
    expect(stuckEvents).toHaveLength(1);
    expect(stuckEvents[0]).toMatchObject({
      classification: "stale_session_state",
      reason: "stale_session_state",
      queueDepth: 0,
    });
    expectRecoveryCall(recover, { ...session, sessionFile, queueDepth: 0 });
  });

  it.each([
    { name: "material stall", progressAt: 20_000, tickAt: 35_000, warns: true },
    { name: "ordinary jitter", progressAt: 15_500, tickAt: 30_999, warns: false },
  ])("preserves the remaining abort budget after $name", ({ progressAt, tickAt, warns }) => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    vi.setSystemTime(0);
    const recover = beginRun();

    vi.advanceTimersByTime(progressAt);
    markDiagnosticSessionProgress(session);
    markDiagnosticRunProgress({ ...session, reason: "embedded_run:progress" });
    vi.advanceTimersByTime(30_000 - progressAt);

    vi.setSystemTime(tickAt);
    vi.advanceTimersByTime(30_000);

    if (warns) {
      expectLoggerMessageContaining(warnSpy, "liveness heartbeat delayed");
    } else {
      expectNoLoggerMessageContaining(warnSpy, "liveness heartbeat delayed");
    }
    expect(recover).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);

    expectRecoveryCall(recover, { ...session, queueDepth: 0, allowActiveAbort: true });
  });

  it("backs off repeated stuck warnings while a session remains unchanged", () => {
    const stuckEvents = () => matchingEvents("session.stuck");
    const recover = startHeartbeat();
    processing();
    vi.advanceTimersByTime(91_000);
    expect(stuckEvents()).toHaveLength(1);
    expect(recover).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(31_000);

    expect(stuckEvents().map((event) => event.ageMs)).toEqual([60_000, 120_000]);
    expect(recover).toHaveBeenCalledTimes(3);
    expect(matchingEvents("session.recovery.requested").map((event) => event.ageMs)).toEqual([
      60_000, 90_000, 120_000,
    ]);
  });

  it("aborts and drains embedded runs after the default no-progress stall", () => {
    const recover = vi.fn();
    const stuckSessionAbortMs = 360_000;
    startGatewayDiagnosticHeartbeat(
      createTestGatewayScheduler("fake-timers"),
      { diagnostics: { enabled: true } },
      { recoverStuckSession: recover },
    );
    processing();
    markDiagnosticEmbeddedRunStarted(session);

    vi.advanceTimersByTime(stuckSessionAbortMs - 30_000);
    expect(recover).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);

    const stalledEvents = matchingEvents("session.stalled");
    expect(stalledEvents.length).toBeGreaterThan(0);
    expect(stalledEvents.at(-1)).toMatchObject({
      classification: "stalled_agent_run",
      reason: "active_work_without_progress",
      activeWorkKind: "embedded_run",
    });
    expectRecoveryCall(recover, { ...session, queueDepth: 0, allowActiveAbort: true });
  });

  it.each(["blocked", "progressing", "released"] as const)(
    "keeps the owned progress clock authoritative while inbound arrives: %s",
    (mode) => {
      const recover = startHeartbeat();
      processing();
      if (mode === "blocked") {
        sessionState(session).lastActivity = Date.now() - 120_000;
      }
      markDiagnosticEmbeddedRunStarted(session);
      startTool();
      if (mode === "released") {
        // The activity row remains, but the lifecycle owner has ended.
        markDiagnosticEmbeddedRunEnded(session);
        expect(activity(session).activeWorkKind).toBeUndefined();
      }
      if (mode === "blocked") {
        vi.advanceTimersByTime(60_000);
        expect(recover).not.toHaveBeenCalled();
      }
      advanceLaneWithInbound(
        mode === "progressing"
          ? () =>
              markDiagnosticRunProgress({
                ...session,
                runId: "run-1",
                reason: "cli_live:stream_progress",
              })
          : undefined,
      );
      if (mode !== "blocked") {
        expect(events.some((event) => event.type === "session.stalled")).toBe(false);
        expect(recover).not.toHaveBeenCalled();
        return;
      }
      const stalled = requireRecord(lastEvent("session.stalled"), "stalled event");
      expect(stalled).toMatchObject({
        classification: "blocked_tool_call",
        reason: "blocked_tool_call",
        activeWorkKind: "tool_call",
        activeToolName: "bash",
        activeToolCallId: "cmd-1",
      });
      expect(stalled.ageMs).toBeGreaterThanOrEqual(15 * 60_000);
      const recovery = requireFirstMockCallArg(recover, "recover");
      expect(recovery).toMatchObject({ ...session, allowActiveAbort: true });
      expect(recovery.ageMs).toBeGreaterThanOrEqual(15 * 60_000);
    },
  );

  it.each(["model_call", "tool_call"] as const)(
    "reports repeated requests during %s without granting recovery authority",
    async (activeWorkKind) => {
      const recover = vi.fn(recoverStuckDiagnosticSession);
      const stuckSessionWarnMs = 30_000;
      const stuckSessionAbortMs = activeWorkKind === "tool_call" ? 900_000 : 90_000;
      heartbeat({
        recoverStuckSession: recover,
        testTimings: { stuckSessionWarnMs, stuckSessionAbortMs },
      });
      processing();
      markDiagnosticEmbeddedRunStarted({ ...session, runId: "run-1" });
      startModel({ provider: "mock", model: "retrying-model", observationUnit: "request" });
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
        logSessionStateChange({ ...session, state: "processing", reason: "run_started" });
        startModel({ provider: "mock", model: "retrying-model", observationUnit: "request" });
      }

      const stalled = repeatedRequestStall();
      expect(stalled).toMatchObject({
        classification: "stalled_agent_run",
        reason: "repeated_model_requests_without_progress",
        repeatedRequestNoProgressAgeMs: stuckSessionAbortMs,
        activeWorkKind,
        activeToolAgeMs: activeWorkKind === "tool_call" ? (stuckSessionAbortMs * 4) / 3 : undefined,
      });
      expect(recover).toHaveBeenCalled();
      for (const { value } of recover.mock.results) {
        await expect(value).resolves.toMatchObject({
          status: "skipped",
          action: "observe_only",
          reason: "missing_session_ref",
        });
      }
      expectRecoveryCall(recover, { ...session, queueDepth: 0, allowActiveAbort: true });
    },
  );

  it("does not recover repeated requests after semantic output resets the clock", async () => {
    const stuckSessionAbortMs = 90_000;
    const ref = { ...session, runId: "run-1" };
    const recover = beginRun(stuckSessionAbortMs, ref);
    startModel({ ...ref, provider: "mock", model: "retrying-model", observationUnit: "request" });
    vi.advanceTimersByTime(30_000);
    startModel({ ...ref, provider: "mock", model: "retrying-model", observationUnit: "request" });
    emitCoreSemanticRunProgressDiagnosticEvent({ ...ref, reason: "assistant:progress" });
    await vi.advanceTimersByTimeAsync(0);

    for (let elapsedMs = 0; elapsedMs < stuckSessionAbortMs; elapsedMs += 30_000) {
      vi.advanceTimersByTime(30_000);
      markDiagnosticRunProgress({ ...ref, reason: "model_call:stream_progress" });
    }

    expect(repeatedRequestStall()).toBeUndefined();
    expect(recover).not.toHaveBeenCalled();
  });

  it("recovers silent model calls only after the abort threshold", async () => {
    const recover = beginRun(90_000);
    startModel();

    vi.advanceTimersByTime(60_000);

    expect(events.some((event) => event.type === "session.stalled")).toBe(false);
    expect(lastEvent("session.long_running")).toMatchObject({
      classification: "long_running",
      reason: "active_model_call_without_progress",
      activeWorkKind: "model_call",
      lastProgressReason: "model_call:started",
    });
    expect(recover).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);
    expect(lastEvent("session.stalled")).toMatchObject({
      classification: "stalled_agent_run",
      reason: "active_work_without_progress",
      activeWorkKind: "model_call",
      lastProgressReason: "model_call:started",
    });
    expectRecoveryCall(recover, { ...session, queueDepth: 0, allowActiveAbort: true });
  });

  it("preserves a fresh model request allowance after semantic progress", async () => {
    const recover = vi.fn(() => new Promise<never>(() => {}));
    const ref = { sessionId: "allowance-session", sessionKey: "agent:main:allowance" };
    const runId = "allowance-run";
    const requestTimeoutMs = 150_000;
    const owner = ownedRun({ ...ref, runId }, recover);
    startOwnedRequest(owner, "call-1", requestTimeoutMs);
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(120_000);
    emitCoreSemanticRunProgressDiagnosticEvent({ ...ref, runId, reason: "assistant:progress" });
    startOwnedRequest(owner, "call-2", requestTimeoutMs);
    await vi.advanceTimersByTimeAsync(0);

    // Semantic progress grants the full allowance; recovery waits for the next heartbeat.
    vi.advanceTimersByTime(requestTimeoutMs - 30_000);
    expect(recover).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);

    expectRecoveryCall(recover, { ...ref, queueDepth: 0, allowActiveAbort: true });
  });

  it("honors the local no-gap allowance and recovers after its finite ceiling", async () => {
    // Local no-gap requests retain a finite recovery ceiling (#125147, #125388).
    const recover = vi.fn();
    const ref = { sessionId: "local-no-gap-session", sessionKey: "agent:jin:subagent:local" };
    const runId = "local-no-gap-run";
    const owner = ownedRun({ ...ref, runId }, recover);
    startOwnedRequest(
      owner,
      "call-1",
      DEFAULT_UNDICI_STREAM_TIMEOUT_MS,
      "ollama",
      "qwen3.5:9b-q8_0",
    );
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(15 * 60_000);

    expect(recover).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DEFAULT_UNDICI_STREAM_TIMEOUT_MS - 15 * 60_000 + 60_000);
    expect(recover).toHaveBeenCalled();
  });

  it("defers a quiet backend until its owned silence deadline expires", () => {
    const recover = vi.fn();
    const ref = { sessionId: "backend-deadline", sessionKey: "agent:main:backend-deadline" };
    const runId = "backend-deadline-run";
    const owner = ownedRun({ ...ref, runId }, recover);
    const backend = beginDiagnosticBackendActivity({
      owner,
      noOutputTimeoutMs: 180_000,
      assertCurrent: () => {},
    });
    try {
      // No output has arrived: initial silence still belongs to the backend's deadline.
      vi.advanceTimersByTime(120_000);
      expect(recover).not.toHaveBeenCalled();

      vi.advanceTimersByTime(60_000);
      expectRecoveryCall(recover, { ...ref, queueDepth: 0, allowActiveAbort: true });
    } finally {
      backend.close();
      closeDiagnosticEmbeddedRunOwner(owner);
    }
  });

  it.each([
    { kind: "owned model", status: "aborted", action: "abort_embedded_run", released: 0 },
    { kind: "orphaned model", status: "released", action: "release_lane", released: 0 },
    { kind: "embedded abort", status: "aborted", action: "abort_embedded_run", released: 1 },
    { kind: "embedded release", status: "released", action: "release_lane", released: 1 },
  ] as const)(
    "preserves idle queued work after $kind recovery",
    async ({ kind, status, action, released }) => {
      const orphaned = kind === "orphaned model";
      const recover = vi.fn().mockResolvedValue({
        ...session,
        status,
        action,
        released,
        ...(orphaned
          ? { reason: "no_active_work" }
          : {
              activeSessionId: "s1",
              activeWorkKind: "embedded_run",
              ...(released ? { queuedCount: 1 } : {}),
              ...(status === "aborted"
                ? { aborted: true, drained: !released, forceCleared: Boolean(released) }
                : { reason: "stale_lane_task" }),
            }),
      });
      heartbeat({ recoverStuckSession: recover });
      processing();
      if (!orphaned) {
        markDiagnosticEmbeddedRunStarted(session);
      }
      if (!released) {
        startModel();
      }
      logSessionStateChange({ ...session, state: "idle" });
      vi.advanceTimersByTime(59_000);
      logMessageQueued({ ...session, source: "test-followup" });
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      if (!released) {
        expectRecoveryCall(recover, {
          ...session,
          queueDepth: 1,
          expectedState: "idle",
          ...(orphaned ? {} : { allowActiveAbort: true }),
        });
      }
      if (orphaned) {
        expect(lastEvent("session.stuck")).toMatchObject({
          type: "session.stuck",
          state: "idle",
          classification: "stale_session_state",
          reason: "queued_work_without_active_run",
          queueDepth: 1,
          lastProgressReason: "model_call:started",
        });
        expect(requireFirstMockCallArg(recover, "recover").allowActiveAbort).toBeUndefined();
        expect(sessionState(session)).toMatchObject({ state: "idle", queueDepth: 1 });
      } else {
        expect(events, kind).toContainEqual(
          expect.objectContaining({
            type: "session.recovery.completed",
            state: "idle",
            status,
            ...(released ? { queueDepth: 1 } : { action }),
          }),
        );
        expect(sessionState(session).queueDepth).toBe(1);
      }
    },
  );

  it("throttles repeated long-running active-work warnings", async () => {
    const recover = startHeartbeat();
    processing();
    vi.advanceTimersByTime(45_000);
    markDiagnosticEmbeddedRunStarted(session);
    vi.advanceTimersByTime(16_000);

    expect(matchingEvents("session.long_running")).toHaveLength(1);

    vi.advanceTimersByTime(28_000);
    emitDiagnosticEvent({ type: "run.progress", ...session, reason: "stream" });
    vi.advanceTimersByTime(2_000);

    const longRunningEvents = matchingEvents("session.long_running");
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
    expect(recover).not.toHaveBeenCalled();
  });

  it("recovers queued sessions behind terminal embedded progress after the abort threshold", () => {
    const recover = vi.fn();
    const stuckSessionWarnMs = 30_000;
    const stuckSessionAbortMs = 60_000;
    const terminalReason = "codex_app_server:notification:rawResponseItem/completed";
    heartbeat({ recoverStuckSession: recover });
    logMessageQueued({ ...session, source: "test" });
    processing();
    markDiagnosticEmbeddedRunStarted(session);
    markDiagnosticRunProgress({ ...session, reason: terminalReason });
    vi.advanceTimersByTime(stuckSessionAbortMs - stuckSessionWarnMs - 1);
    logMessageQueued({ ...session, source: "test" });
    vi.advanceTimersByTime(stuckSessionWarnMs + 1);

    const attentionEvents = events.filter(
      (event) =>
        event.type === "session.long_running" ||
        event.type === "session.stalled" ||
        event.type === "session.stuck",
    );
    expect(attentionEvents.at(-1)).toMatchObject({
      type: "session.stalled",
      classification: "stalled_agent_run",
      reason: "queued_behind_terminal_active_work",
      activeWorkKind: "embedded_run",
      queueDepth: 1,
      terminalProgressStale: true,
      lastProgressReason: terminalReason,
    });
    expectRecoveryCall(recover, { ...session, queueDepth: 1, allowActiveAbort: true });
  });

  it("starts and stops the stability recorder with the heartbeat lifecycle", () => {
    heartbeat();
    processing();

    expectStability({ type: "session.state", outcome: "processing" });
    const [event] = stability({ limit: 10 }).events;
    expect(event).not.toHaveProperty("sessionId");
    expect(event).not.toHaveProperty("sessionKey");

    resetDiagnosticStateForTest();
    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });

    expect(stability({ limit: 10 }).events).toStrictEqual([]);
  });

  it("does not track session state when diagnostics are disabled", () => {
    setDiagnosticsEnabledForProcess(false);
    processing();

    expect(events).toStrictEqual([]);
    expect(diagnosticSessionStates.size).toBe(0);
  });

  it.each([false, true])("counts queued liveness backlog with an active turn: %s", (active) => {
    const sample = active
      ? liveness({
          eventLoopDelayP99Ms: 53.6,
          eventLoopDelayMaxMs: 2_761.9,
          eventLoopUtilization: 0.785,
          cpuCoreRatio: 0.378,
        })
      : liveness({
          reasons: ["cpu"],
          eventLoopDelayP99Ms: 12,
          eventLoopDelayMaxMs: 22,
          eventLoopUtilization: 0.99,
          cpuUserMs: 29_000,
          cpuSystemMs: 1_000,
          cpuTotalMs: 30_000,
          cpuCoreRatio: 1,
        });
    const emitMemorySample = createEmitMemorySampleMock();
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    heartbeat({ emitMemorySample, sampleLiveness: () => sample });
    if (active) {
      logMessageQueued({ ...session, source: "discord" });
      processing();
    }
    vi.advanceTimersByTime(30_000);
    expectNoLoggerMessageContaining(warnSpy, "liveness warning:");
    expectStability({
      type: "diagnostic.liveness.warning",
      level: "info",
      active: active ? 1 : 0,
      waiting: 0,
      queued: 0,
      ...(!active
        ? {
            reason: "cpu",
            durationMs: 30_000,
            count: 1,
            eventLoopDelayP99Ms: 12,
            eventLoopDelayMaxMs: 22,
            eventLoopUtilization: 0.99,
            cpuCoreRatio: 1,
          }
        : {}),
    });
    if (!active) {
      expect(events.map((event) => event.type)).toContain("diagnostic.liveness.warning");
      expect(emitMemorySample).toHaveBeenLastCalledWith({ emitSample: true });
    }
    logMessageQueued({ ...session, source: active ? "discord" : "test" });
    vi.advanceTimersByTime(active ? 120_000 : 30_000);
    expectLoggerMessageContaining(warnSpy, "liveness warning:");
    if (active) {
      expectStability(
        { type: "diagnostic.liveness.warning", level: "warning", active: 1, waiting: 0, queued: 1 },
        20,
      );
    }
  });

  it("warns and records the full duration for persistent idle event-loop degradation", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    startLiveness(
      liveness({ degradedSinceMs: 60_000, eventLoopDelayP99Ms: 1_200, eventLoopDelayMaxMs: 1_500 }),
    );

    vi.advanceTimersByTime(30_000);

    expectLoggerMessageContaining(warnSpy, "degradedFor=60s");
    expect(lastEvent("diagnostic.liveness.warning")).toMatchObject({ degradedSinceMs: 60_000 });
    expectStability({ type: "diagnostic.liveness.warning", level: "warning", durationMs: 60_000 });

    vi.advanceTimersByTime(90_000);
    expect(matchingEvents("diagnostic.liveness.warning")).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(matchingEvents("diagnostic.liveness.warning")).toHaveLength(2);
  });

  it("suppresses liveness warnings during startupGraceMs while still sampling", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    const recover = vi.fn();
    const sampleLiveness = vi.fn(() => liveness());

    vi.setSystemTime(0);
    heartbeat({
      emitMemorySample: createEmitMemorySampleMock(),
      recoverStuckSession: recover,
      sampleLiveness,
      startupGraceMs: 60_000,
      testTimings: { stuckSessionWarnMs: 1_000, stuckSessionAbortMs: 1_000 },
    });

    logMessageQueued({ ...session, source: "test" });
    processing();
    markDiagnosticEmbeddedRunStarted(session);
    vi.setSystemTime(1_001);
    vi.advanceTimersByTime(30_000);

    expect(sampleLiveness).toHaveBeenCalledTimes(1);
    expectNoLoggerMessageContaining(warnSpy, "liveness heartbeat delayed");
    expectNoLoggerMessageContaining(warnSpy, "liveness warning:");
    expect(events.map((event) => event.type)).not.toContain("diagnostic.liveness.warning");
    expect(recover).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);

    expect(sampleLiveness).toHaveBeenCalledTimes(2);
    expectLoggerMessageContaining(warnSpy, "liveness warning:");
    expect(events.map((event) => event.type)).toContain("diagnostic.liveness.warning");
    expectRecoveryCall(recover, { ...session, queueDepth: 0, allowActiveAbort: true });
  });

  it("adds phase and work labels to liveness warnings", async () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    await withDiagnosticPhase("stale.phase", () => undefined);
    vi.advanceTimersByTime(60_000);
    await withDiagnosticPhase("recent.phase", () => undefined);
    const { promise, resolve: completePhase } = createDeferredCore();
    const phase = withDiagnosticPhase("startup.plugins.load", () => promise);

    try {
      startLiveness(liveness());

      logMessageQueued({ ...session, source: "telegram" });
      vi.advanceTimersByTime(30_000);
    } finally {
      completePhase();
      await phase;
    }

    expectLoggerMessageContaining(warnSpy, "phase=startup.plugins.load");
    expectLoggerMessageContaining(warnSpy, "work=[queued=main(");
    const warning = requireRecord(
      lastEvent("diagnostic.liveness.warning"),
      "liveness warning event",
    );
    expectLoggerMessageContaining(warnSpy, "recentPhases=recent.phase:");
    expectNoLoggerMessageContaining(warnSpy, "stale.phase");
    expect(warning.recentPhases).toEqual([expect.objectContaining({ name: "recent.phase" })]);
    expect(warning.phase).toBe("startup.plugins.load");
    expect(warning.queuedWorkLabels).toEqual(
      expect.arrayContaining([expect.stringContaining("main(")]),
    );
  });
});
