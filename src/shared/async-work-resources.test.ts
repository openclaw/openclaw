import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { execNodeEvalSync } from "../test-utils/node-process.js";
import { runWithAsyncWorkResources } from "./async-work-resources.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "./async-work-scope.js";
import { createDeferredCore } from "./deferred.js";

describe("async work resources", () => {
  it("releases settled results and producer data while accepted work remains", () => {
    // This proves V8 retention even when the test runner uses Bun.
    const output = execNodeEvalSync(
      `import assert from "node:assert/strict";
       import { setImmediate as nextTurn } from "node:timers/promises";
       import { queryObjects } from "node:v8";
       import { runWithAsyncWorkResources } from ${JSON.stringify(new URL("./async-work-resources.ts", import.meta.url).href)};
       import { AsyncWorkScope, runWithTrackedCancellation, trackAsyncWork } from ${JSON.stringify(new URL("./async-work-scope.ts", import.meta.url).href)};

       function createForegroundProducer(pendingWork) {
         const input = { text: "synthetic transcript text" };
         return {
           input: new WeakRef(input),
           run: () => {
             void trackAsyncWork(pendingWork);
             return { messagesSnapshot: [{ text: input.text }] };
           },
         };
       }

       async function completeForeground(mode, owner, signal, pendingWork, release) {
         const producer = createForegroundProducer(pendingWork);
         const output = await owner.run(() =>
           mode === "resources"
             ? runWithAsyncWorkResources(async (onAcquired) => {
                 onAcquired({ release, releaseBeforeResultWhenIdle: true });
                 return producer.run();
               })
             : runWithTrackedCancellation(signal, producer.run),
         );
         return { input: producer.input, output: new WeakRef(output) };
       }

       for (const mode of ["resources", "cancellation"]) {
         const owner = new AsyncWorkScope();
         const requester = new AbortController();
         const finishWork = Promise.withResolvers();
         let releases = 0;
         try {
           const references = await completeForeground(
             mode, owner, requester.signal, () => finishWork.promise, () => releases++,
           );
           const control = new WeakRef({});
           await nextTurn();
           queryObjects(WeakRef);
           assert.equal(control.deref(), undefined, mode + " GC control");
           assert.equal(references.input.deref(), undefined, mode + " producer data");
           assert.equal(references.output.deref(), undefined, mode + " settled result");
           assert.equal(owner.hasPendingWork, true, mode + " accepted work remains");
           assert.equal(releases, 0, mode + " cleanup waits for accepted work");
         } finally {
           finishWork.resolve();
           await owner.drain();
         }
         assert.equal(releases, mode === "resources" ? 1 : 0, mode + " cleanup count");
       }
       console.log("foreground data released");`,
      {
        imports: ["./scripts/tsx.mjs"],
        timeout: 10_000,
      },
    );
    expect(output.trim()).toBe("foreground data released");
  });

  it.each([
    { eager: true, fails: false },
    { eager: true, fails: true },
    { eager: false, fails: true },
  ])("releases idle resources once (eager=$eager, fails=$fails)", async ({ eager, fails }) => {
    const owner = new AsyncWorkScope();
    const cleanupStarted = createDeferredCore();
    const finishCleanup = createDeferredCore();
    const failure = new Error("resource cleanup failed");
    const release = vi.fn(async () => {
      cleanupStarted.resolve();
      await finishCleanup.promise;
      if (fails) {
        throw failure;
      }
    });
    let returned = false;
    const result = owner
      .run(() =>
        runWithAsyncWorkResources(async (onAcquired) => {
          onAcquired({ release, releaseBeforeResultWhenIdle: eager ? true : undefined });
          return "completed";
        }),
      )
      .then((value) => {
        returned = true;
        return value;
      });
    const outcome =
      eager && fails
        ? expect(result).rejects.toBe(failure)
        : expect(result).resolves.toBe("completed");
    try {
      await cleanupStarted.promise;
      await nextTurn();
      expect(returned).toBe(!eager);
      if (!eager) {
        expect(await result).toBe("completed");
        expect(owner.hasPendingWork).toBe(true);
      }
      expect(release).toHaveBeenCalledOnce();
    } finally {
      finishCleanup.resolve();
      await owner.drain();
    }
    await outcome;
    if (!eager) {
      expect(await result).toBe("completed");
    }
    expect(release).toHaveBeenCalledOnce();
  });

  it("propagates cancellation immediately while accepted work retains cleanup", async () => {
    const owner = new AsyncWorkScope();
    const finishAdmission = createDeferredCore();
    const release = vi.fn();
    let operationSignal: AbortSignal | undefined;
    const result = owner.run(() =>
      runWithAsyncWorkResources(async (onAcquired) => {
        onAcquired({ release, releaseBeforeResultWhenIdle: true });
        operationSignal = getAsyncWorkSignal();
        void trackAsyncWork(() => finishAdmission.promise);
        return "enqueued";
      }),
    );
    try {
      expect(await result).toBe("enqueued");
      expect(owner.hasPendingWork).toBe(true);
      expect(release).not.toHaveBeenCalled();
      expect(operationSignal?.aborted).toBe(false);
      const reason = new Error("requester cancelled");
      owner.beginClose(reason);
      expect(operationSignal?.aborted).toBe(true);
      expect(operationSignal?.reason).toBe(reason);
      expect(release).not.toHaveBeenCalled();
      expect(owner.hasPendingWork).toBe(true);
    } finally {
      finishAdmission.resolve();
      await owner.drain();
    }
    expect(release).toHaveBeenCalledOnce();
  });
});
