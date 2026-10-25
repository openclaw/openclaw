import {
  emitDiagnosticEvent as emitPluginDiagnosticEvent,
  emitTrustedDiagnosticEvent as emitPluginTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData as emitPluginTrustedDiagnosticEventWithPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  emitCoreModelRequestEndedDiagnosticEvent,
  emitCoreModelRequestStartedDiagnosticEvent,
} from "../infra/diagnostic-model-request.js";
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
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "./diagnostic-run-activity.js";
import { resetDiagnosticSessionStateForTest } from "./diagnostic-session-state.js";
import {
  logSessionStateChange,
  startGatewayDiagnosticHeartbeat,
  stopGatewayDiagnosticHeartbeat,
} from "./diagnostic.js";

const session = { sessionId: "owner-session", sessionKey: "agent:main:owner" };

afterEach(() => {
  testing.resetSessionControllerForTest();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticEventsForTest();
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
    closeDiagnosticEmbeddedRunOwner(owner);
  });

  it.each([false, true])(
    "releases drained run fences without losing idle progress (merged: %s)",
    async (merge) => {
      const target = { sessionId: "merged-session", sessionKey: session.sessionKey };
      startDiagnosticRunActivityTracking();
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
    const earlierOwner = createDiagnosticEmbeddedRunOwner(earlier);
    const laterOwner = createDiagnosticEmbeddedRunOwner(later);
    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...earlier, owner: earlierOwner });
    markDiagnosticEmbeddedRunStarted({ ...later, owner: laterOwner });
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
    closeDiagnosticEmbeddedRunOwner(laterOwner);
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
    const oldRunId = "long-prior-request";
    const currentRunId = "current-request";
    const oldOwner = createDiagnosticEmbeddedRunOwner({
      ...session,
      runId: oldRunId,
      workKey: "prior-owner",
    });
    const currentOwner = createDiagnosticEmbeddedRunOwner({
      ...session,
      runId: currentRunId,
      workKey: "current-owner",
    });
    startDiagnosticRunActivityTracking();
    try {
      markDiagnosticEmbeddedRunStarted({ ...oldOwner, owner: oldOwner });
      startRequest(oldOwner, "prior-long-call", 600_000, "slow-prior-model");
      await waitForDiagnosticEventsDrained();

      vi.setSystemTime(startedAt + 100);
      markDiagnosticEmbeddedRunStarted({ ...currentOwner, owner: currentOwner });
      startRequest(currentOwner, "current-short-call", 100_000, "current-model");
      await waitForDiagnosticEventsDrained();

      const requestTimeoutMs =
        getDiagnosticSessionActivitySnapshot(session).activeModelCallRequestTimeoutMs;
      expect(requestTimeoutMs).toBe(100_000);
    } finally {
      closeDiagnosticEmbeddedRunOwner(oldOwner);
      closeDiagnosticEmbeddedRunOwner(currentOwner);
    }
  });
});

function startOwnedRun(ref: Parameters<typeof createDiagnosticEmbeddedRunOwner>[0]) {
  const owner = startOwner(ref);
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
    try {
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
    } finally {
      backend.close();
      closeDiagnosticEmbeddedRunOwner(owner);
      stopGatewayDiagnosticHeartbeat();
      await scheduler.stop();
      resetDiagnosticSessionStateForTest();
    }
  });
});
