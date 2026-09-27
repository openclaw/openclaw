import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../agents/embedded-agent-runner/runs.test-support.js";
import {
  clearSessionQueues,
  enqueueFollowupRun,
  type FollowupRun,
  type QueueSettings,
} from "../auto-reply/reply/queue.js";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../auto-reply/reply/reply-run-registry.test-support.js";
import {
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  emitCoreModelRequestEndedDiagnosticEvent,
  emitCoreModelRequestStartedDiagnosticEvent,
} from "../infra/diagnostic-model-request.js";
import { emitCoreSemanticRunProgressDiagnosticEvent } from "../infra/diagnostic-semantic-run-progress.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import {
  beginDiagnosticBackendActivity,
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  markDiagnosticOwnedToolActivity,
  startDiagnosticRunActivityTracking,
} from "./diagnostic-run-activity.js";
import type { StuckSessionRecoveryOutcome } from "./diagnostic-session-recovery.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";
import { startDiagnosticHeartbeat, stopDiagnosticHeartbeat } from "./diagnostic.js";
import { resetDiagnosticStateForTest } from "./diagnostic.test-support.js";

describe("stuck session follow-up recovery", () => {
  const queueKeys = new Set<string>();

  afterEach(() => {
    clearSessionQueues([...queueKeys]);
    queueKeys.clear();
    embeddedRunTesting.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    resetCommandQueueStateForTest();
    resetDiagnosticStateForTest();
    resetDiagnosticEventsForTest();
  });

  it.each([
    { allowance: "model request", requestTimeoutMs: 150_000, progress: "none" },
    { allowance: "backend bytes", requestTimeoutMs: undefined, progress: "none" },
    { allowance: "semantic progress", requestTimeoutMs: undefined, progress: "semantic" },
    { allowance: "owned tool deadline", requestTimeoutMs: undefined, progress: "tool-deadline" },
    { allowance: "deadline-less tool", requestTimeoutMs: undefined, progress: "tool-no-deadline" },
    { allowance: "overlapping tools", requestTimeoutMs: undefined, progress: "overlapping-tools" },
    { allowance: "mixed tool deadlines", requestTimeoutMs: undefined, progress: "mixed-tools" },
  ])("rechecks repeated requests before releasing a lane with $allowance", async (testCase) => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    setDiagnosticsEnabledForProcess(true);
    startDiagnosticRunActivityTracking();
    const ref = {
      sessionId: "repeated-session",
      sessionKey: "agent:main:repeated",
      runId: "run-1",
    };
    const owner = createDiagnosticEmbeddedRunOwner(ref);
    const activeEntered = createDeferred();
    const releaseActive = createDeferred();
    const dispatchRecovery = createDeferred();
    const outcomes: StuckSessionRecoveryOutcome[] = [];
    const abort = vi.fn(() => {
      clearActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
      releaseActive.resolve();
    });
    const handle = {
      runId: ref.runId,
      diagnosticOwner: owner,
      closeDiagnostics: () => closeDiagnosticEmbeddedRunOwner(owner),
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort,
    };
    const lane = resolveEmbeddedSessionLane(ref.sessionKey);
    const active = enqueueCommandInLane(lane, async () => {
      setActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
      activeEntered.resolve();
      await releaseActive.promise;
    });
    await activeEntered.promise;
    const backend = beginDiagnosticBackendActivity({
      owner,
      noOutputTimeoutMs: 150_000,
      assertCurrent: () => {},
    });
    let queued: Promise<void> | undefined;
    try {
      for (let attempt = 0; attempt <= 8; attempt++) {
        const request = {
          ...ref,
          callId: `request-${attempt}`,
          provider: "mock",
          model: "retrying",
        };
        emitCoreModelRequestStartedDiagnosticEvent(
          request,
          owner.generation,
          testCase.requestTimeoutMs,
        );
        await waitForDiagnosticEventsDrained();
        backend.observeOutput(false);
        if (attempt < 8) {
          await vi.advanceTimersByTimeAsync(50_000);
          emitCoreModelRequestEndedDiagnosticEvent(
            { ...request, type: "model.call.error", durationMs: 50_000, errorCategory: "retry" },
            owner.generation,
          );
          await waitForDiagnosticEventsDrained();
        }
      }
      const ranQueued = vi.fn(async () => {});
      const waits: number[] = [];
      queued = enqueueCommandInLane(lane, ranQueued, {
        warnAfterMs: 0,
        onWait: (waitedMs) => waits.push(waitedMs),
      });
      const recover = vi.fn(
        async (request: Parameters<typeof recoverStuckDiagnosticSession>[0]) => {
          await dispatchRecovery.promise;
          const outcome = await recoverStuckDiagnosticSession(request);
          outcomes.push(outcome);
          return outcome;
        },
      );
      startDiagnosticHeartbeat(
        { diagnostics: { enabled: true } },
        { sampleLiveness: () => null, recoverStuckSession: recover },
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(recover).toHaveBeenCalledOnce();
      if (testCase.progress === "semantic") {
        emitCoreSemanticRunProgressDiagnosticEvent({ ...ref, reason: "assistant:progress" });
        await waitForDiagnosticEventsDrained();
      } else if (
        testCase.progress === "tool-deadline" ||
        testCase.progress === "tool-no-deadline"
      ) {
        markDiagnosticOwnedToolActivity(owner, {
          phase: "start",
          toolName: "exec",
          toolCallId: "owned-process",
          ...(testCase.progress === "tool-deadline" ? { deadlineAtMs: Date.now() + 150_000 } : {}),
        });
      } else if (testCase.progress === "overlapping-tools" || testCase.progress === "mixed-tools") {
        markDiagnosticOwnedToolActivity(owner, {
          phase: "start",
          toolName: "exec",
          toolCallId: "old-process",
          ...(testCase.progress === "mixed-tools" ? { deadlineAtMs: Date.now() + 900_000 } : {}),
        });
        vi.setSystemTime(Date.now() + 14 * 60_000);
        markDiagnosticOwnedToolActivity(owner, {
          phase: "start",
          toolName: "exec",
          toolCallId: "fresh-process",
        });
        vi.setSystemTime(Date.now() + 2 * 60_000);
      }
      dispatchRecovery.resolve();
      await vi.advanceTimersByTimeAsync(0);
      if (testCase.progress !== "none") {
        expect(outcomes).toMatchObject([{ status: "skipped" }]);
        expect(abort).not.toHaveBeenCalled();
        expect(ranQueued).not.toHaveBeenCalled();
      } else {
        expect(outcomes).toMatchObject([{ status: "aborted", action: "abort_embedded_run" }]);
        expect(abort).toHaveBeenCalledOnce();
        expect(ranQueued).toHaveBeenCalledOnce();
        expect(waits).toEqual([30_000]);
      }
    } finally {
      stopDiagnosticHeartbeat();
      dispatchRecovery.resolve();
      releaseActive.resolve();
      backend.close();
      clearActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
      await active;
      await queued;
      vi.useRealTimers();
    }
  });

  it.each(["followup", "collect"] as const)(
    "continues pending %s work after force-clearing a wedged drain",
    async (mode) => {
      vi.useFakeTimers();
      const sessionKey = `agent:main:wedged-${mode}-drain`;
      const sessionId = `wedged-${mode}-drain-session`;
      const settings: QueueSettings = { mode, debounceMs: 0, cap: 50 };
      const activeEntered = createDeferred();
      const releaseZombie = createDeferred();
      const activeSettled = vi.fn();
      const calls: string[] = [];
      queueKeys.add(sessionKey);

      const runFollowup = async (run: FollowupRun) => {
        calls.push(run.prompt);
        if (calls.length === 1) {
          activeEntered.resolve();
          await releaseZombie.promise;
        }
      };

      try {
        const active = createQueueTestRun({ prompt: "active" });
        active.turnAdoptionLifecycle = {
          onAdopted: async () => {},
          onSettled: activeSettled,
        };
        enqueueFollowupRun(sessionKey, active, settings, "none", runFollowup);
        await activeEntered.promise;
        enqueueFollowupRun(
          sessionKey,
          createQueueTestRun({ prompt: "pending" }),
          settings,
          "none",
          runFollowup,
        );

        const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
        operation.attachBackend({ kind: "embedded", cancel: () => {}, isStreaming: () => true });
        operation.setPhase("running");
        const recovery = recoverStuckDiagnosticSession({
          sessionId,
          sessionKey,
          ageMs: 720_000,
          queueDepth: 1,
          allowActiveAbort: true,
        });
        await vi.advanceTimersByTimeAsync(15_100);

        await expect(recovery).resolves.toMatchObject({
          status: "aborted",
          action: "abort_embedded_run",
          forceCleared: true,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(2);
        expect(calls[0]).toContain("active");
        expect(calls[1]).toContain("pending");
        expect(activeSettled).toHaveBeenCalledOnce();

        releaseZombie.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(2);
        expect(activeSettled).toHaveBeenCalledOnce();
      } finally {
        releaseZombie.resolve();
        await vi.runOnlyPendingTimersAsync();
        vi.useRealTimers();
      }
    },
  );

  it("does not retire a fresh source that became active while recovery was settling", async () => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:fresh-followup-owner";
    const sessionId = "fresh-followup-owner-session";
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const firstEntered = createDeferred();
    const secondEntered = createDeferred();
    const releaseFirst = createDeferred();
    const releaseSecond = createDeferred();
    const calls: string[] = [];
    queueKeys.add(sessionKey);

    const runFollowup = async (run: FollowupRun) => {
      calls.push(run.prompt);
      if (calls.length === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
      } else if (calls.length === 2) {
        secondEntered.resolve();
        await releaseSecond.promise;
      }
    };

    try {
      enqueueFollowupRun(
        sessionKey,
        createQueueTestRun({ prompt: "stale" }),
        settings,
        "none",
        runFollowup,
      );
      await firstEntered.promise;
      enqueueFollowupRun(
        sessionKey,
        createQueueTestRun({ prompt: "fresh" }),
        settings,
        "none",
        runFollowup,
      );

      const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
      operation.attachBackend({ kind: "embedded", cancel: () => {}, isStreaming: () => true });
      operation.setPhase("running");
      const recovery = recoverStuckDiagnosticSession({
        sessionId,
        sessionKey,
        ageMs: 720_000,
        queueDepth: 1,
        allowActiveAbort: true,
      });
      releaseFirst.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await secondEntered.promise;
      await vi.advanceTimersByTimeAsync(15_100);

      await expect(recovery).resolves.toMatchObject({ forceCleared: true });
      expect(calls).toEqual(["stale", "fresh"]);
      releaseSecond.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(["stale", "fresh"]);
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("continues pending work after releasing an ownerless stale lane task", async () => {
    const sessionKey = "agent:main:ownerless-lane-followup";
    const sessionId = "ownerless-lane-followup-session";
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const activeEntered = createDeferred();
    const releaseZombie = createDeferred();
    const laneEntered = createDeferred();
    const releaseLaneTask = createDeferred();
    const calls: string[] = [];
    queueKeys.add(sessionKey);

    const runFollowup = async (run: FollowupRun) => {
      calls.push(run.prompt);
      if (calls.length === 1) {
        activeEntered.resolve();
        await releaseZombie.promise;
      }
    };
    const laneTask = enqueueCommandInLane(resolveEmbeddedSessionLane(sessionKey), async () => {
      laneEntered.resolve();
      await releaseLaneTask.promise;
    });

    try {
      await laneEntered.promise;
      enqueueFollowupRun(
        sessionKey,
        createQueueTestRun({ prompt: "active" }),
        settings,
        "none",
        runFollowup,
      );
      await activeEntered.promise;
      enqueueFollowupRun(
        sessionKey,
        createQueueTestRun({ prompt: "pending" }),
        settings,
        "none",
        runFollowup,
      );

      await expect(
        recoverStuckDiagnosticSession({
          sessionId,
          sessionKey,
          ageMs: 300_000,
          queueDepth: 1,
        }),
      ).resolves.toMatchObject({
        status: "released",
        action: "release_lane",
        reason: "stale_lane_task",
      });
      await vi.waitFor(() => expect(calls).toEqual(["active", "pending"]));

      releaseZombie.resolve();
      await vi.waitFor(() => expect(calls).toEqual(["active", "pending"]));
    } finally {
      releaseZombie.resolve();
      releaseLaneTask.resolve();
      await laneTask;
    }
  });
});
