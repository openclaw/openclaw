import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { expectPendingUntilAbort } from "./test-helpers/start-account-lifecycle.js";

it.each(["startup", "assertion"] as const)(
  "joins account cleanup before reporting a failed %s check",
  async (failureStage) => {
    const abort = new AbortController();
    const aborted = createDeferred();
    const cleanup = createDeferred();
    const events: string[] = [];
    abort.signal.addEventListener("abort", () => {
      events.push("abort");
      aborted.resolve();
    });
    const task = aborted.promise.then(async () => {
      await cleanup.promise;
      events.push("cleanup");
    });
    const failure = new Error("synthetic lifecycle assertion failure");
    const assertAfterAbort = vi.fn();
    const outcome = expectPendingUntilAbort({
      abort,
      task,
      isSettled: () => false,
      waitForStarted: async () => {
        if (failureStage === "startup") {
          throw failure;
        }
      },
      assertBeforeAbort: () => {
        throw failure;
      },
      assertAfterAbort,
    }).catch((error: unknown) => {
      events.push("failure");
      return error;
    });

    try {
      // The broken helper reports failure before aborting. No clock or polling is needed.
      await Promise.race([aborted.promise, outcome]);
      expect(abort.signal.aborted).toBe(true);
      expect(events).toEqual(["abort"]);
      cleanup.resolve();
      expect(await outcome).toBe(failure);
      expect(events).toEqual(["abort", "cleanup", "failure"]);
      expect(assertAfterAbort).not.toHaveBeenCalled();
    } finally {
      // Contain the failing-before proof as well as a regression in the assertions above.
      abort.abort();
      cleanup.resolve();
      await task;
      await outcome;
    }
  },
);
