import { channel } from "node:diagnostics_channel";
import { totalmem } from "node:os";
import {
  emitDiagnosticEvent as emitPluginDiagnosticEvent,
  emitTrustedDiagnosticEvent as emitPluginTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData as emitPluginTrustedDiagnosticEventWithPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { recordCommandPoll } from "../agents/command-poll-backoff.js";
import { detectToolCallLoop, recordToolCall } from "../agents/tool-loop-detection.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import {
  emitCoreModelRequestEndedDiagnosticEvent,
  emitCoreModelRequestStartedDiagnosticEvent,
} from "../infra/diagnostic-model-request.js";
import * as spawnDiagnostics from "../process/spawn-diagnostics.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { testing } from "../sessions/session-controller.test-support.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { resolveRunStaleThresholdMs } from "./diagnostic-run-activity-snapshot.js";
import { activityByRunId, resolveSessionActivity } from "./diagnostic-run-activity-state.js";
import {
  BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
  beginDiagnosticBackendActivity,
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticArgumentChurnObservation,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
  markDiagnosticOwnedToolActivity,
  startDiagnosticRunActivityTracking,
} from "./diagnostic-run-activity.js";
import {
  getDiagnosticSessionState,
  isDiagnosticSessionStateCurrent,
} from "./diagnostic-session-state.js";
import {
  diagnosticLogger,
  logMessageQueued,
  logWebhookReceived,
  logSessionStateChange,
  startGatewayDiagnosticHeartbeat,
  stopGatewayDiagnosticHeartbeat,
} from "./diagnostic.js";
import { resetDiagnosticStateForTest } from "./diagnostic.test-support.js";
import { createDiagnosticMessageLifecycle } from "./message-lifecycle.js";

const session = { sessionId: "owner-session", sessionKey: "agent:main:owner" };

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  clearRuntimeConfigSnapshot();
  testing.resetSessionControllerForTest();
  resetDiagnosticStateForTest();
  resetDiagnosticEventsForTest();
  setDiagnosticsEnabledForProcess(true);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function startOwner(run: Parameters<typeof createDiagnosticEmbeddedRunOwner>[0]) {
  const owner = createDiagnosticEmbeddedRunOwner(run);
  startDiagnosticRunActivityTracking();
  markDiagnosticEmbeddedRunStarted({ ...run, owner });
  return owner;
}

function setClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = Date.parse("2026-10-04T00:00:00Z");
  vi.setSystemTime(now);
  return now;
}

function completedRequest(
  { sessionId, sessionKey, runId }: ReturnType<typeof createDiagnosticEmbeddedRunOwner>,
  callId: string,
) {
  return {
    type: "model.call.completed" as const,
    sessionId,
    sessionKey,
    runId,
    callId,
    provider: "core",
    model: "slow-model",
    durationMs: 1,
  };
}

function startRequest(
  owner: ReturnType<typeof createDiagnosticEmbeddedRunOwner>,
  callId: string,
  timeout?: number,
  model = "request-model",
) {
  const { sessionId, sessionKey, runId } = owner;
  emitCoreModelRequestStartedDiagnosticEvent(
    { sessionId, sessionKey, runId, callId, provider: "core", model },
    owner.generation,
    timeout,
  );
}

function startTool(
  run: Parameters<typeof createDiagnosticEmbeddedRunOwner>[0],
  toolCallId: string,
  toolName = "stale-tool",
) {
  const { sessionId, sessionKey, runId } = run;
  emitDiagnosticEvent({
    type: "tool.execution.started",
    sessionId,
    sessionKey,
    runId,
    toolCallId,
    toolName,
  });
}

describe("core model owner generations", () => {
  it("keeps sliding quiet protection after the start-relative recovery allowance", async () => {
    const startedAt = setClock();
    const run = { ...session, runId: "quiet-run" };
    const owner = startOwner(run);
    startRequest(owner, "quiet-call", 900_000);
    await waitForDiagnosticEventsDrained();
    vi.setSystemTime(startedAt + 800_000);
    markDiagnosticRunProgress({ ...run, reason: "model_call:stream_progress" });
    vi.setSystemTime(startedAt + 1_160_000);
    const activity = getDiagnosticSessionActivitySnapshot(session);
    expect(activity).toMatchObject({
      lastProgressAgeMs: 360_000,
      repeatedRequestNoProgressAgeMs: undefined,
      activeModelCallRequestTimeoutMs: 900_000,
    });
    expect(resolveRunStaleThresholdMs(activity, 360_000, 360_000)).toBe(900_000);
  });

  it.each([false, true])(
    "releases drained run fences without losing idle progress (merged: %s)",
    async (merge) => {
      const target = { sessionId: "merged-session", sessionKey: session.sessionKey };
      if (merge) {
        markDiagnosticRunProgress({ sessionId: target.sessionId, reason: "prior-progress" });
      }
      for (let index = 0; index < 32; index++) {
        const runId = `completed-run-${index}`;
        const owner = startOwner({ ...session, runId });
        startTool({ ...session, runId }, runId);
        closeDiagnosticEmbeddedRunOwner(owner);
      }
      const observedRef = merge ? target : session;
      const observedAt = Date.now();
      const beforeDrain = getDiagnosticSessionActivitySnapshot(observedRef, observedAt);
      const cutoffs = resolveSessionActivity(observedRef)?.recoveredOwnerStartEventCutoffs;
      expect(cutoffs?.has("completed-run-0")).toBe(true);
      expect(beforeDrain).toMatchObject({
        activeWorkKind: undefined,
        lastProgressReason: "embedded_run:ended",
      });
      expect(activityByRunId.size).toBe(0);

      await waitForDiagnosticEventsDrained();

      expect(getDiagnosticSessionActivitySnapshot(observedRef, observedAt)).toEqual(beforeDrain);
      expect(cutoffs?.size).toBe(0);
      expect(activityByRunId.size).toBe(0);
    },
  );

  it("preserves a newer fence while an earlier diagnostic prefix drains", async () => {
    let newerFenceAtDelivery: boolean | undefined;
    onInternalDiagnosticEvent(
      (event) => {
        if (event.type !== "tool.execution.started") {
          return;
        }
        if (event.toolCallId === "first-start") {
          const owner = startOwner({ ...session, runId: "second-run" });
          startTool(owner, "second-start", "second-stale-tool");
          closeDiagnosticEmbeddedRunOwner(owner);
        } else if (event.toolCallId === "second-start") {
          newerFenceAtDelivery =
            resolveSessionActivity(session)?.recoveredOwnerStartEventCutoffs.has("second-run");
        }
      },
      { include: ["tool.execution.started"] },
    );
    const first = startOwner({ ...session, runId: "first-run" });
    startTool(first, "first-start", "first-stale-tool");
    closeDiagnosticEmbeddedRunOwner(first);

    await waitForDiagnosticEventsDrained();
    // The first batch enqueues the second owner's start behind its captured prefix.
    await waitForDiagnosticEventsDrained();

    expect(newerFenceAtDelivery).toBe(true);
    expect(getDiagnosticSessionActivitySnapshot(session)).toMatchObject({
      activeWorkKind: undefined,
      activeToolName: undefined,
      lastProgressReason: "embedded_run:ended",
    });
    expect(resolveSessionActivity(session)?.recoveredOwnerStartEventCutoffs.size).toBe(0);
    expect(activityByRunId.size).toBe(0);

    const replacement = startOwner({ ...session, runId: "replacement-run" });
    startTool(replacement, "replacement-start", "replacement-tool");
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot(session)).toMatchObject({
      activeWorkKind: "tool_call",
      activeToolName: "replacement-tool",
    });
    expect(activityByRunId.has("replacement-run")).toBe(true);
  });

  it("keeps the newest run's clocks when an earlier work key is rearmed", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-09-04T00:00:00Z");
    vi.setSystemTime(startedAt);
    const earlier = { ...session, runId: "earlier-run", workKey: "first" };
    const later = { ...session, runId: "later-run", workKey: "second" };
    const earlierOwner = startOwner(earlier);
    startOwner(later);
    markDiagnosticEmbeddedRunStarted({ ...earlier, owner: earlierOwner });
    markDiagnosticArgumentChurnObservation({ ...session, runId: earlier.runId, active: true });
    for (const callId of ["request-1", "request-2"]) {
      startRequest(earlierOwner, callId);
    }
    await vi.advanceTimersByTimeAsync(0);
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticSessionActivitySnapshot(session, startedAt + 30_000)).toMatchObject({
      activeWorkKind: "model_call",
      lastProgressReason: "tool_loop:argument_churn",
      lastProgressAgeMs: 30_000,
      repeatedRequestNoProgressAgeMs: 30_000,
    });

    closeDiagnosticEmbeddedRunOwner(earlierOwner);
    expect(getDiagnosticSessionActivitySnapshot(session, startedAt + 30_000)).toMatchObject({
      activeWorkKind: "embedded_run",
      hasActiveEmbeddedRun: true,
      lastProgressReason: "embedded_run:ended",
      repeatedRequestNoProgressAgeMs: undefined,
    });
  });

  it("keeps exact-call recovery policy intact across forged terminals and run completion", async () => {
    setClock();
    const runId = "core-owner-run";
    const owner = startOwner({ ...session, runId });
    startRequest(owner, "call-1", 300_000, "slow-model");
    await waitForDiagnosticEventsDrained();

    emitPluginTrustedDiagnosticEvent(completedRequest(owner, "call-1"));
    emitDiagnosticEvent({
      type: "run.completed",
      ...session,
      runId,
      durationMs: 1,
      outcome: "completed",
    });
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticSessionActivitySnapshot(session)).toMatchObject({
      activeWorkKind: "model_call",
      hasActiveEmbeddedRun: true,
      activeModelCallRequestTimeoutMs: 300_000,
      lastProgressReason: "model_call:started",
    });
  });

  it("fences queued old starts and delayed terminals without erasing a same-run replacement", async () => {
    const startedAt = setClock();
    const runId = "reused-run";
    const ownerA = startOwner({ ...session, runId });
    startRequest(ownerA, "old-call", 300_000, "slow-model");
    closeDiagnosticEmbeddedRunOwner(ownerA);

    const ownerB = startOwner({ ...session, runId });
    vi.setSystemTime(startedAt + 100);
    startRequest(ownerB, "new-call", 420_000, "replacement-model");
    markDiagnosticEmbeddedRunStarted({ ...session, runId, owner: ownerA });
    startRequest(ownerA, "resurrected-old-call", 600_000, "stale-model");
    await waitForDiagnosticEventsDrained();
    emitCoreModelRequestEndedDiagnosticEvent(
      completedRequest(ownerA, "old-call"),
      ownerA.generation,
    );
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticSessionActivitySnapshot(session)).toMatchObject({
      activeWorkKind: "model_call",
      hasActiveEmbeddedRun: true,
      activeModelCallRequestTimeoutMs: 420_000,
    });
  });

  it("projects only the current owner generation request timeout", async () => {
    const startedAt = setClock();
    for (const [runId, timeout] of [
      ["prior", 600_000],
      ["current", 100_000],
    ] as const) {
      const owner = startOwner({ ...session, runId, workKey: runId });
      startRequest(owner, "request", timeout);
      await waitForDiagnosticEventsDrained();
      vi.setSystemTime(startedAt + 100);
    }
    expect(getDiagnosticSessionActivitySnapshot(session).activeModelCallRequestTimeoutMs).toBe(
      100_000,
    );
  });
});

function startOwnedRun(ref: Parameters<typeof createDiagnosticEmbeddedRunOwner>[0]) {
  const owner = startOwner(ref);
  return {
    owner,
    snapshot: () => getDiagnosticSessionActivitySnapshot(ref),
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
    const ref = { ...session, runId: "forged-allowance-run" };
    const { snapshot } = startOwnedRun(ref);
    const forged = {
      type: "run.progress" as const,
      ...ref,
      reason: "model_call:stream_progress",
      backendLivenessTimeoutMs: 480_000,
      activeBackendLivenessDeadlineAtMs: Date.now() + 480_000,
    };

    emit(forged);
    await waitForDiagnosticEventsDrained();

    expect(snapshot()).toMatchObject({
      lastProgressReason: "embedded_run:started",
      activeBackendLivenessDeadlineAtMs: undefined,
    });
  });

  it.each(["owned tool", "same-id successor"] as const)(
    "does not apply queued nonsemantic progress to the %s",
    async (target) => {
      vi.useFakeTimers();
      const startedAt = Date.parse("2026-08-04T00:00:00Z");
      vi.setSystemTime(startedAt);
      const ref = { ...session, runId: "reused-progress-run" };
      const { owner, snapshot } = startOwnedRun(ref);
      emitTrustedDiagnosticEvent({
        type: "run.progress",
        ...ref,
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
        startOwner(ref);
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
    const { snapshot, begin } = startOwnedRun({ ...session, runId: "cli-run" });
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
      const { snapshot, begin } = startOwnedRun(ref);
      const backend = begin(noOutputTimeoutMs);
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
    },
  );

  it.each(["attempt close", "owner close", "authority expiry", "owner replacement"] as const)(
    "revokes the allowance and retained observations after %s",
    (closure) => {
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const ref = { ...session, runId: "reused-run" };
      const { owner, snapshot, begin } = startOwnedRun(ref);
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
        closure === "owner replacement" ? createDiagnosticEmbeddedRunOwner(ref) : owner;
      if (closure === "owner replacement") {
        markDiagnosticEmbeddedRunStarted({ ...ref, owner: replacementOwner });
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
    cleanups.push(() => scheduler.stop());
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
    const ref = { ...session, runId: "agent-run" };
    logSessionStateChange({ ...ref, state: "processing" });
    const operation = createReplyOperation({ ...ref, resetTriggered: false });
    operation.setPhase("running");
    const watchdogAttempt = operation.watchdog.attachAttempt({ assertCurrent() {} });
    const { owner, snapshot, begin } = startOwnedRun({ ...ref, watchdogAttempt });
    markDiagnosticOwnedToolActivity(owner, {
      phase: "start",
      toolName: "Agent",
      toolCallId: "toolu_parent",
    });
    const backend = begin(180_000);
    await advanceHeartbeats(14 * 60_000);
    expect(recoverStuckSession).not.toHaveBeenCalled();
    expect(backend.observeAttributedAgentProgress("toolu_bash")).toBe(false);
    expect(snapshot()).toMatchObject({
      activeToolName: "Agent",
      activeToolCallId: "toolu_parent",
      lastProgressReason: "reply_operation:queued",
      lastProgressAgeMs: 14 * 60_000,
    });

    expect(backend.observeAttributedAgentProgress("toolu_parent")).toBe(true);
    expect(snapshot()).toMatchObject({
      lastProgressReason: "tool:owned_progress",
      lastProgressAgeMs: 0,
      activeToolAgeMs: 14 * 60_000,
    });

    await advanceHeartbeats(14 * 60_000);
    expect(recoverStuckSession).not.toHaveBeenCalled();
    await advanceHeartbeats(60_000);
    expect(operation.watchdog.decide().action).toBe("stop");
    expect(recoverStuckSession).toHaveBeenCalledOnce();
    expect(recoverStuckSession).toHaveBeenCalledWith(
      expect.objectContaining({ operation, allowActiveAbort: true }),
    );
  });
});

function expectCalls(count: number, ...observers: MockInstance[]) {
  for (const observer of observers) {
    expect(observer).toHaveBeenCalledTimes(count);
  }
}

function heartbeatOptions() {
  return {
    emitMemorySample: vi.fn(),
    sampleLiveness: vi.fn(() => null),
    getConfig: vi.fn(() => ({})),
    recoverStuckSession: vi.fn(),
  };
}

const cleanups: Array<() => void | Promise<void>> = [];
function heartbeatFixture(internal = false, startedAt = Date.now()) {
  const clock = createGatewaySchedulerClock(startedAt);
  const scheduler = createTestGatewayScheduler(clock.clock);
  const events: DiagnosticEventPayload[] = [];
  cleanups.push(
    (internal ? onInternalDiagnosticEvent : onDiagnosticEvent)((event) => events.push(event)),
    () => scheduler.stop(),
  );
  return { clock, scheduler, events };
}

// Mirrors the private per-field budget in diagnostic-content.ts.
const MAX_DIAGNOSTIC_CONTENT_CHARS = 128 * 1024;

it("bounds captured content and preserves ingesting-agent attribution on dispatch", () => {
  setRuntimeConfigSnapshot({ diagnostics: { otel: { enabled: true, captureContent: true } } });
  const oversizedContent = `${"x".repeat(MAX_DIAGNOSTIC_CONTENT_CHARS - 1)}🚀tail`;
  const captured: Array<{ userPrompt?: string; finalResponse?: string }> = [];
  const agents: Array<string | undefined> = [];
  cleanups.push(
    onDiagnosticEvent((event) => {
      if (event.type === "message.processed") {
        agents.push(event.agentId);
      }
    }),
    onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type === "message.processed" && privateData.messageContent) {
        captured.push(privateData.messageContent);
      }
    }),
  );
  const lifecycle = createDiagnosticMessageLifecycle({
    enabled: true,
    channel: "test",
    source: "test",
    trackSessionState: false,
    sessionKey: "agent:main:lifecycle",
    agentId: "main",
    userPrompt: oversizedContent,
  });
  lifecycle.markProcessed("completed", { finalResponse: oversizedContent });

  expect(captured).toHaveLength(1);
  expect(agents).toEqual(["main"]);
  for (const value of [captured[0]?.userPrompt, captured[0]?.finalResponse]) {
    expect(value?.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CONTENT_CHARS);
    expect(value?.charCodeAt((value?.length ?? 0) - 1)).not.toBe(0xd83d);
  }
});

it("preserves independent tool-loop and poll-backoff policy when diagnostic observation stops", () => {
  const ref = { sessionKey: "diagnostic-tool-history" };
  const state = getDiagnosticSessionState(ref);
  const args = { path: "fixture.txt" };
  for (let index = 0; index < 10; index += 1) {
    recordToolCall(state, "read", args);
  }
  const before = detectToolCallLoop(state, "read", args);
  expect(before).toMatchObject({ stuck: true, detector: "generic_repeat", count: 10 });
  expect(recordCommandPoll(state, "fixture-command", false)).toBe(5_000);
  expect(recordCommandPoll(state, "fixture-command", false)).toBe(10_000);
  setDiagnosticsEnabledForProcess(false);
  stopGatewayDiagnosticHeartbeat();
  const current = getDiagnosticSessionState(ref);
  expect(detectToolCallLoop(current, "read", args)).toEqual(before);
  expect(recordCommandPoll(current, "fixture-command", false)).toBe(30_000);
});

it("keeps pressure sampling silent and reconciles diagnostic options on one cadence", async () => {
  const { clock, scheduler, events } = heartbeatFixture(true);
  const pressure = channel("openclaw.memory.critical");
  const critical = vi.fn();
  const childSamples = vi.spyOn(spawnDiagnostics, "emitChildProcessSpawnSample");
  const warn = vi.spyOn(diagnosticLogger, "warn");
  const readMemoryUsage = process.memoryUsage;
  const criticalRss = totalmem();
  Object.assign(
    vi.spyOn(process, "memoryUsage").mockImplementation(() => ({
      ...readMemoryUsage(),
      rss: criticalRss,
    })),
    { rss: () => criticalRss },
  );
  const first = heartbeatOptions();
  const latest = heartbeatOptions();
  pressure.subscribe(critical);
  cleanups.unshift(() => pressure.unsubscribe(critical));
  setDiagnosticsEnabledForProcess(false);
  startGatewayDiagnosticHeartbeat(scheduler, undefined, first);
  await clock.advanceBy(30_000);
  expect(critical).toHaveBeenCalledTimes(1);
  expect(events).toEqual([]);
  expectCalls(0, ...Object.values(first), childSamples, warn);

  setDiagnosticsEnabledForProcess(true);
  startGatewayDiagnosticHeartbeat(scheduler, undefined, first);
  await clock.advanceBy(30_000);
  expect(first.emitMemorySample).toHaveBeenCalledTimes(1);
  await clock.advanceBy(15_000);
  startGatewayDiagnosticHeartbeat(scheduler, undefined, latest);
  await clock.advanceBy(15_000);
  expectCalls(
    1,
    first.emitMemorySample,
    latest.emitMemorySample,
    latest.sampleLiveness,
    latest.getConfig,
  );
  expect(childSamples).toHaveBeenCalledTimes(2);

  setDiagnosticsEnabledForProcess(false);
  startGatewayDiagnosticHeartbeat(scheduler, undefined, latest);
  await waitForDiagnosticEventsDrained();
  const observed = events.length;
  await clock.advanceBy(5 * 60_000);
  await waitForDiagnosticEventsDrained();
  expect(critical).toHaveBeenCalledTimes(2);
  expect(events).toHaveLength(observed);
  expectCalls(0, latest.recoverStuckSession);
  expectCalls(1, latest.emitMemorySample, latest.sampleLiveness, latest.getConfig);
  expect(childSamples).toHaveBeenCalledTimes(2);

  setDiagnosticsEnabledForProcess(true);
  startGatewayDiagnosticHeartbeat(scheduler, undefined, latest);
  await clock.advanceBy(30_000);
  expect(latest.emitMemorySample).toHaveBeenCalledTimes(2);
  expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("heartbeat delayed"));
  // Explicit heartbeat config is also authoritative; recovery config is a separate lookup.
  startGatewayDiagnosticHeartbeat(scheduler, { diagnostics: { enabled: false } }, latest);
  await clock.advanceBy(30_000);
  expect(critical).toHaveBeenCalledTimes(3);
  expect(latest.emitMemorySample).toHaveBeenCalledTimes(2);
  expectCalls(0, warn);
  expect(childSamples).toHaveBeenCalledTimes(3);

  startGatewayDiagnosticHeartbeat(scheduler, {}, latest);
  stopGatewayDiagnosticHeartbeat();
  await clock.advanceBy(120_000);
  expect(critical).toHaveBeenCalledTimes(3);
  expect(latest.emitMemorySample).toHaveBeenCalledTimes(2);
  startGatewayDiagnosticHeartbeat(scheduler, undefined, latest);
  scheduler.beginClose();
  await scheduler.stop();
  startGatewayDiagnosticHeartbeat(scheduler, undefined, latest);
  await clock.advanceBy(30_000);
  expect(critical).toHaveBeenCalledTimes(3);
  expect(latest.emitMemorySample).toHaveBeenCalledTimes(2);
});

it("retires interrupted diagnostic observations before re-enable without reviving their authority", async () => {
  const { clock, scheduler, events } = heartbeatFixture();
  setDiagnosticsEnabledForProcess(true);
  const ref = { sessionKey: "diagnostic-lifecycle", sessionId: "diagnostic-lifecycle" };
  startGatewayDiagnosticHeartbeat(scheduler, {}, { sampleLiveness: () => null });
  logMessageQueued({ ...ref, source: "test" });
  logSessionStateChange({ ...ref, state: "processing" });
  const generation = getDiagnosticSessionState(ref).generation;
  expect(generation).toBeTypeOf("number");
  expect(isDiagnosticSessionStateCurrent({ ...ref, generation, state: "processing" })).toBe(true);
  setDiagnosticsEnabledForProcess(false);
  startGatewayDiagnosticHeartbeat(scheduler, {}, { sampleLiveness: () => null });
  logSessionStateChange({ ...ref, state: "idle" });
  setDiagnosticsEnabledForProcess(true);
  startGatewayDiagnosticHeartbeat(scheduler, {}, { sampleLiveness: () => null });
  logWebhookReceived({ channel: "test" });
  await clock.advanceBy(30_000);
  await waitForDiagnosticEventsDrained();
  expect(events.findLast((event) => event.type === "diagnostic.heartbeat")).toMatchObject({
    active: 0,
    queued: 0,
    waiting: 0,
  });
  logMessageQueued({ ...ref, source: "test" });
  logSessionStateChange({ ...ref, state: "processing" });
  expect(isDiagnosticSessionStateCurrent({ ...ref, generation, state: "processing" })).toBe(false);
});
