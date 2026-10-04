// Diagnostic queue/admission boundary; the controlled release is not a real worker failure.
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { clearFollowupDrainCallback, scheduleFollowupDrain } from "./queue/drain.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import { FollowupRunDeferredError } from "./queue/types.js";
import * as registry from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

const key = "diagnostic-followup-after-compaction";
const originalId = "before-compaction";
const compactedId = "after-compaction";

afterEach(() => {
  clearFollowupQueue(key);
  clearFollowupDrainCallback(key);
  testing.resetReplyRunRegistry();
  resetDiagnosticRunActivityForTest();
  resetCommandQueueStateForTest();
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["completed", "failed"] as const)(
  "retains queued input behind a %s rotated predecessor and executes it once after release",
  async (outcome) => {
    vi.useFakeTimers();
    resetGatewayWorkAdmission();
    const predecessor = await admitReplyTurn({
      sessionKey: key,
      sessionId: originalId,
      kind: "visible",
      resetTriggered: false,
    });
    if (predecessor.status !== "owned") {
      throw new Error("expected a real admitted predecessor");
    }
    const release = createDeferred();
    const enteredWait = createDeferred();
    const finished = createDeferred();
    const abort = new AbortController();
    const observed: string[] = [];
    let attempts = 0;
    const waitForSuccessor = registry.waitForReplyRunSuccessorAdmission;
    vi.spyOn(registry, "waitForReplyRunSuccessorAdmission").mockImplementation((...args) => {
      const result = waitForSuccessor(...args);
      enteredWait.resolve();
      return result;
    });
    registry.registerReplyOperationSuccessorBarrier({
      operation: predecessor.operation,
      sessionId: originalId,
      sessionKeys: [key],
      deferUntilClear: true,
      start: () => release.promise,
    });
    const queued = createQueueTestRun({ prompt: "message received during compaction" });
    queued.run.sessionKey = key;
    queued.run.sessionId = originalId;
    queued.abortSignal = abort.signal;
    enqueueFollowupRun(key, queued, { mode: "followup", debounceMs: 0, cap: 10 });
    predecessor.operation.setPhase("preflight_compacting");
    predecessor.operation.updateSessionId(compactedId);
    if (outcome === "failed") {
      // Tests failure after generation adoption, not the compaction algorithm.
      predecessor.operation.retainFailureUntilComplete();
      predecessor.operation.fail("run_failed", new Error("synthetic post-rotation failure"));
    }
    predecessor.operation.complete();
    scheduleFollowupDrain(key, async (run) => {
      attempts += 1;
      const admission = await admitReplyTurn({
        sessionKey: key,
        sessionId: run.run.sessionId,
        expectedSessionId: originalId,
        kind: "queued_followup",
        resetTriggered: false,
        upstreamAbortSignal: abort.signal,
      });
      if (admission.status !== "owned") {
        if (admission.reason === "active-run") {
          throw new FollowupRunDeferredError("predecessor is still releasing");
        }
        throw new Error("unexpected admission result: " + admission.reason);
      }
      observed.push(admission.operation.sessionId);
      admission.operation.complete();
      finished.resolve();
    });
    try {
      await enteredWait.promise;
      expect(observed).toEqual([]);
      expect(getExistingFollowupQueue(key)?.items).toContain(queued);
      expect(getExistingFollowupQueue(key)?.inFlight.has(queued)).toBe(true);
      release.resolve();
      await finished.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(observed).toEqual([compactedId]);
      expect(attempts).toBe(1);
      expect(getExistingFollowupQueue(key)).toBeUndefined();
      expect(registry.replyRunRegistry.get(key)).toBeUndefined();
    } finally {
      release.resolve();
      abort.abort();
      predecessor.operation.complete();
      clearFollowupQueue(key);
      await vi.advanceTimersByTimeAsync(0);
    }
  },
);
