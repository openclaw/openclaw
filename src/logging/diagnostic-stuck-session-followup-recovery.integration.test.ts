import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueFollowupRun,
  type FollowupRun,
  type QueueSettings,
} from "../auto-reply/reply/queue.js";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import { clearSessionQueues } from "../auto-reply/reply/queue/cleanup.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { getSessionControllerOperation } from "../sessions/session-controller.state.js";
import { testing } from "../sessions/session-controller.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resetDiagnosticRecoveryState } from "./diagnostic-recovery.test-support.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";

const key = "agent:main:watchdog-followup";
const sessionId = "watchdog-followup-session";
function source(prompt: string) {
  const run = createQueueTestRun({ prompt });
  run.run.sessionKey = key;
  return run;
}
function begin() {
  const operation = createReplyOperation({ sessionKey: key, sessionId, resetTriggered: false });
  operation.setPhase("running");
  return operation;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  testing.resetSessionControllerForTest();
  clearSessionQueues([key]);
  resetDiagnosticRecoveryState();
  vi.useRealTimers();
});

describe("controller watchdog and actual followup delivery custody", () => {
  it.each(["followup", "collect"] as const)(
    "keeps pending %s sources behind write-capable cleanup, then dispatches once",
    async (mode) => {
      const operation = begin();
      const cancelled = createDeferredCore();
      const cancel = vi.fn(() => cancelled.resolve());
      operation.attachBackend({ kind: "embedded", cancel });
      const settings: QueueSettings = { mode, debounceMs: 0, cap: 50 };
      const delivered = createDeferredCore();
      const settled = createDeferredCore();
      const dispatch = vi.fn(async (_run: FollowupRun) => {
        delivered.resolve();
      });
      const run = source("pending");
      const onSettled = vi.fn(() => {
        settled.resolve();
      });
      run.turnAdoptionLifecycle = { onAdopted: () => {}, onSettled };
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
      await settled.promise;
      await recovery;
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch.mock.calls[0]?.[0].prompt).toContain("pending");
      expect(onSettled).toHaveBeenCalledOnce();
    },
  );

  it("does not retire a fresh source that became active before an old recovery resumes", async () => {
    const operation = begin();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const settled = createDeferredCore();
    const onSettled = vi.fn(() => {
      settled.resolve();
    });
    const run = source("fresh");
    run.turnAdoptionLifecycle = { onAdopted: () => {}, onSettled };
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
    await settled.promise;
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("cannot free a selected source merely because no native backend is registered", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const settled = createDeferredCore();
    const first = source("selected");
    first.turnAdoptionLifecycle = { onAdopted: () => {}, onSettled: () => settled.resolve() };
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
    await settled.promise;
    await secondEntered.promise;
    expect(calls).toEqual(["selected", "pending"]);
  });
});
