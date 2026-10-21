import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueFollowupRun,
  type FollowupRun,
  type QueueSettings,
} from "../auto-reply/reply/queue.js";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import { clearSessionQueues } from "../auto-reply/reply/queue/cleanup.js";
import {
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import {
  emitCoreModelRequestEndedDiagnosticEvent,
  emitCoreModelRequestStartedDiagnosticEvent,
} from "../infra/diagnostic-model-request.js";
import { emitCoreSemanticRunProgressDiagnosticEvent } from "../infra/diagnostic-semantic-run-progress.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { getSessionControllerOperation } from "../sessions/session-controller.state.js";
import { testing } from "../sessions/session-controller.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  beginDiagnosticBackendActivity,
  beginDiagnosticRetryWait,
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticArgumentChurnObservation,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticOwnedToolActivity,
} from "./diagnostic-run-activity.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";
import { resetDiagnosticStateForTest } from "./diagnostic.test-support.js";

const ref = {
  sessionKey: "agent:main:watchdog-integration",
  sessionId: "watchdog-session",
  runId: "watchdog-run",
};
const abortMs = 6 * 60_000;
function begin() {
  const operation = createReplyOperation({ ...ref, resetTriggered: false });
  operation.setPhase("running");
  const cancel = vi.fn(() => operation.complete());
  operation.attachBackend({ kind: "embedded", runId: ref.runId, cancel });
  const watchdogAttempt = operation.watchdog.attachAttempt({ assertCurrent() {} });
  const owner = createDiagnosticEmbeddedRunOwner({ ...ref, watchdogAttempt });
  markDiagnosticEmbeddedRunStarted({ ...ref, owner });
  return { operation, cancel, owner, watchdogAttempt };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  setDiagnosticsEnabledForProcess(false);
});
afterEach(() => {
  testing.resetSessionControllerForTest();
  clearSessionQueues(["agent:main:watchdog-followup"]);
  resetDiagnosticStateForTest();
  resetDiagnosticEventsForTest();
  vi.useRealTimers();
});

describe("controller recovery through actual progress producers", () => {
  it("reclaims repeated request/byte activity exactly once without replaying queued work", async () => {
    const { operation, cancel, owner } = begin();
    const backend = beginDiagnosticBackendActivity({
      owner,
      noOutputTimeoutMs: 150_000,
      assertCurrent() {},
    });
    const delivered = vi.fn();
    const queued = withSessionTurn(ref, async () => {
      delivered();
    });
    for (let index = 0; index < 8; index++) {
      vi.setSystemTime(index * 50_000);
      if (index > 0) {
        emitCoreModelRequestEndedDiagnosticEvent(
          {
            ...ref,
            type: "model.call.error",
            callId: "request-" + (index - 1),
            provider: "mock",
            model: "retrying",
            durationMs: 50_000,
            errorCategory: "retry",
          },
          owner.generation,
        );
      }
      emitCoreModelRequestStartedDiagnosticEvent(
        { ...ref, callId: "request-" + index, provider: "mock", model: "retrying" },
        owner.generation,
        150_000,
      );
      backend.observeOutput(false);
    }
    expect(delivered).not.toHaveBeenCalled();
    vi.setSystemTime(abortMs);
    await recoverStuckDiagnosticSession({ ...ref, operation, ageMs: abortMs });
    expect(cancel).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
    vi.setSystemTime(500_000);
    await recoverStuckDiagnosticSession({ ...ref, operation, ageMs: Date.now() });
    await queued;
    expect(cancel).toHaveBeenCalledOnce();
    expect(delivered).toHaveBeenCalledOnce();
    expect(operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
    backend.close();
  });

  it("rechecks semantic results published while recovery dispatch was deferred", async () => {
    const { operation, cancel, owner } = begin();
    const request = { ...ref, operation, ageMs: abortMs };
    vi.setSystemTime(abortMs);
    emitCoreSemanticRunProgressDiagnosticEvent({ ...ref, reason: "assistant:result" }, owner);
    await recoverStuckDiagnosticSession(request);
    expect(cancel).not.toHaveBeenCalled();
    expect(getDiagnosticSessionActivitySnapshot(ref).lastProgressAgeMs).toBe(0);
    const retry = beginDiagnosticRetryWait({
      owner,
      deadlineAtMs: Date.now() + abortMs * 2,
      signal: operation.abortSignal,
      assertCurrent() {},
    });
    vi.setSystemTime(abortMs * 2 + 1);
    await recoverStuckDiagnosticSession(request);
    expect(cancel).not.toHaveBeenCalled();
    retry();
    await recoverStuckDiagnosticSession(request);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["quiet", "explicit", "overlapping", "mixed"] as const)(
    "protects %s owned tools even when diagnostics are disabled",
    async (kind) => {
      const { operation, cancel, owner } = begin();
      markDiagnosticOwnedToolActivity(owner, {
        phase: "start",
        toolName: "exec",
        toolCallId: "old",
        ...(kind === "explicit" || kind === "mixed" ? { deadlineAtMs: 1_200_000 } : {}),
      });
      if (kind === "overlapping" || kind === "mixed") {
        vi.setSystemTime(14 * 60_000);
        markDiagnosticOwnedToolActivity(owner, {
          phase: "start",
          toolName: "exec",
          toolCallId: "new",
        });
      }
      vi.setSystemTime(kind === "overlapping" || kind === "mixed" ? 16 * 60_000 : abortMs);
      await recoverStuckDiagnosticSession({ ...ref, operation, ageMs: Date.now() });
      expect(cancel).not.toHaveBeenCalled();
      const deadline = Math.max(
        ...operation.watchdog.snapshot().tools.map((tool) => tool.deadlineAtMs),
      );
      vi.setSystemTime(deadline);
      await recoverStuckDiagnosticSession({ ...ref, operation, ageMs: Date.now() });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("keeps compaction/preflight on its actual deadline and allows immediate supersession", async () => {
    const { operation, cancel, watchdogAttempt } = begin();
    operation.setPhase("preflight_compacting");
    const safetyDeadline = 12 * 60_000;
    watchdogAttempt.beginWait({
      kind: "runtime_owned",
      deadlineAtMs: safetyDeadline,
      isCurrent: () => true,
    });
    watchdogAttempt.setExecutionDeadline(safetyDeadline);
    vi.setSystemTime(safetyDeadline - 1);
    await recoverStuckDiagnosticSession({ ...ref, operation, ageMs: Date.now() });
    expect(cancel).not.toHaveBeenCalled();
    expect(operation.supersede()).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(operation.result).toMatchObject({ kind: "aborted", code: "aborted_for_supersession" });
  });

  it("continuous argument churn cannot be renewed by mechanical model/tool handoffs", async () => {
    const { operation, cancel, watchdogAttempt } = begin();
    for (let step = 0; step <= 12; step++) {
      vi.setSystemTime(step * 30_000);
      watchdogAttempt.progress("semantic", "model:repeated_tool_request");
      markDiagnosticArgumentChurnObservation({ ...ref, watchdogAttempt, active: true });
    }
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      lastProgressAgeMs: abortMs,
      lastProgressReason: "tool_loop:argument_churn",
    });
    await recoverStuckDiagnosticSession({ ...ref, operation, ageMs: abortMs });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("controller watchdog and actual followup delivery custody", () => {
  const key = "agent:main:watchdog-followup";
  const sessionId = "watchdog-followup-session";
  function source(prompt: string) {
    const run = createQueueTestRun({ prompt });
    run.run.sessionKey = key;
    return run;
  }
  function beginFollowup() {
    const operation = createReplyOperation({ sessionKey: key, sessionId, resetTriggered: false });
    operation.setPhase("running");
    return operation;
  }
  function trackedSource(prompt: string) {
    const settled = createDeferredCore();
    const onSettled = vi.fn(() => settled.resolve());
    const run = source(prompt);
    run.turnAdoptionLifecycle = { onAdopted: () => {}, onSettled };
    return { run, onSettled, settled: settled.promise };
  }

  it.each(["followup", "collect"] as const)(
    "keeps pending %s sources behind write-capable cleanup, then dispatches once",
    async (mode) => {
      const operation = beginFollowup();
      const cancelled = createDeferredCore();
      const cancel = vi.fn(() => cancelled.resolve());
      operation.attachBackend({ kind: "embedded", cancel });
      const settings: QueueSettings = { mode, debounceMs: 0, cap: 50 };
      const delivered = createDeferredCore();
      const dispatch = vi.fn(async (_run: FollowupRun) => {
        delivered.resolve();
      });
      const { run, onSettled, settled } = trackedSource("pending");
      enqueueFollowupRun(key, run, settings, "none", dispatch);
      vi.setSystemTime(6 * 60_000);
      const recovery = recoverStuckDiagnosticSession({
        operation,
        sessionKey: key,
        sessionId,
        ageMs: Date.now(),
      });
      // Cold placement recovery must reach Stop before advancing its cleanup clock.
      await cancelled.promise;
      await vi.advanceTimersByTimeAsync(60_000 - 1);
      expect(cancel).toHaveBeenCalledOnce();
      expect(operation.watchdog.decide().action).toBe("blocked");
      expect(dispatch).not.toHaveBeenCalled();
      expect(onSettled).not.toHaveBeenCalled();
      expect(getSessionControllerOperation(key)).toBe(operation);
      operation.complete();
      await delivered.promise;
      await settled;
      await recovery;
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch.mock.calls[0]?.[0].prompt).toContain("pending");
      expect(onSettled).toHaveBeenCalledOnce();
    },
  );

  it("does not retire a fresh source that became active before an old recovery resumes", async () => {
    const operation = beginFollowup();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const { run, onSettled, settled } = trackedSource("fresh");
    const dispatch = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    enqueueFollowupRun(key, run, { mode: "followup", debounceMs: 0 }, "none", dispatch);
    const request = { operation, sessionKey: key, sessionId, ageMs: 1_000_000 };
    operation.complete();
    await entered.promise;
    await recoverStuckDiagnosticSession(request);
    expect(onSettled).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledOnce();
    release.resolve();
    await settled;
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("cannot free a selected source merely because no native backend is registered", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const { run: first, settled } = trackedSource("selected");
    const calls: string[] = [];
    const secondEntered = createDeferredCore();
    const dispatch = async (run: FollowupRun) => {
      calls.push(run.prompt);
      if (calls.length === 1) {
        entered.resolve();
        await release.promise;
      } else {
        secondEntered.resolve();
      }
    };
    enqueueFollowupRun(key, first, { mode: "followup", debounceMs: 0 }, "none", dispatch);
    await entered.promise;
    enqueueFollowupRun(
      key,
      source("pending"),
      { mode: "followup", debounceMs: 0 },
      "none",
      dispatch,
    );
    await expect(
      recoverStuckDiagnosticSession({ sessionKey: key, sessionId, ageMs: 1_000_000 }),
    ).resolves.toMatchObject({ status: "skipped", reason: "missing_session_ref" });
    expect(calls).toEqual(["selected"]);
    release.resolve();
    await settled;
    await secondEntered.promise;
    expect(calls).toEqual(["selected", "pending"]);
  });
});
