import { describe, expect, it, vi } from "vitest";
import { createQueueCase } from "./queue.case.test-support.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import { replyCallbackCustody } from "./reply-callback-custody.js";

installQueueRuntimeErrorSilencer();

describe("followup queue callback custody", () => {
  it.each([false, true])(
    "notifies every collected run observer before surfacing a callback failure (throws: %s)",
    async (throws) => {
      const q = createQueueCase();
      const error = new Error("first observer failed");
      const first = vi.fn(() => {
        if (throws) {
          throw error;
        }
      });
      const second = vi.fn();
      const onModelSelected = vi.fn();
      const releaseCallbacks = vi.fn();
      const retainCallbacks = vi.fn(() => releaseCallbacks);
      for (const [prompt, runObservers] of [
        ["first", { onAgentRunTerminalOutcome: first }],
        ["second", { onAgentRunTerminalOutcome: second }],
        ["last", { onModelSelected }],
      ] as const) {
        q.add({
          ...createRun({ prompt, originatingChannel: "a2a" }),
          runObservers,
          [replyCallbackCustody]: { retain: retainCallbacks },
        });
      }
      const settlements = getExistingFollowupQueue(q.key)!.entries.map(
        (entry) => entry.settlement.promise,
      );
      let releaseRetry: (() => void) | undefined;
      await q.drain(async (run) => {
        releaseRetry = run[replyCallbackCustody]?.retain();
        await q.runFollowup(run);
      });
      await Promise.allSettled(settlements);
      expect(q.calls).toHaveLength(1);
      const observers = q.calls[0]!.runObservers;
      expect(observers?.onModelSelected).toBe(onModelSelected);
      expect(retainCallbacks).toHaveBeenCalledTimes(6);
      expect(releaseCallbacks).toHaveBeenCalledTimes(3);
      const fail = () => observers?.onAgentRunTerminalOutcome?.("failed");
      if (throws) {
        expect(fail).toThrow(error);
      } else {
        fail();
      }
      expect(first).toHaveBeenCalledExactlyOnceWith("failed");
      expect(second).toHaveBeenCalledExactlyOnceWith("failed");
      releaseRetry?.();
      expect(releaseCallbacks).toHaveBeenCalledTimes(6);
    },
  );

  it("does not enqueue when the external lifecycle rejects the run identity", () => {
    const q = createQueueCase({ mode: "followup", debounceMs: 10_000, cap: 50 });
    const onEnqueued = vi.fn(() => false);
    const run = createRun({ prompt: "duplicate owner" });
    const releaseCallbacks = vi.fn();
    const retainCallbacks = vi.fn(() => releaseCallbacks);
    run[replyCallbackCustody] = { retain: retainCallbacks };
    run.turnAdoptionLifecycle = { onAdopted: async () => {}, onDeferred: onEnqueued };
    const enqueued = q.add(run);
    expect(enqueued).toBe(false);
    expect(onEnqueued).toHaveBeenCalledTimes(1);
    expect(retainCallbacks).toHaveBeenCalledTimes(1);
    expect(releaseCallbacks).toHaveBeenCalledTimes(1);
    expect(getExistingFollowupQueue(q.key)?.items ?? []).toEqual([]);
    clearFollowupQueue(q.key);
  });
});
