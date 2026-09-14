// The followup drain outlives its enqueue request across debounce and retries, but
// its continuation must not inherit the triggering request's AsyncWorkScope. A
// drained queued turn runs an agent run whose embedded-agent-runner entry bridges
// through the ambient scope tracker (run-orchestrator.ts trackOwner pattern), so
// if the drain inherits the request scope, tracked work in the drained turn
// rejects with "Async work scope is closed" once the request settles. The drain
// error is neither deferred nor a restart signal, so the drain loop logs and
// reschedules against the same closed scope forever, silently dropping the queued
// follow-up. A detached continuation owns a fresh async work scope instead.
import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it } from "vitest";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { AsyncWorkScope, captureAsyncWorkTracker } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { QueueSettings } from "./queue.js";
import { clearSessionQueues, enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";

installQueueRuntimeErrorSilencer();

it("drained followup turn keeps tracked work accepted after the triggering scope closes", async () => {
  resetGatewayWorkAdmission();
  const key = `test-drain-scope-close-${Date.now()}`;
  const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
  const requestScope = new AsyncWorkScope();
  const requestRoot = tryBeginGatewayRootWorkAdmission("test:request");
  if (!requestRoot) {
    throw new Error("expected request root work admission");
  }
  const scopeClosed = createDeferredCore();
  const runFollowupSettled = createDeferredCore();
  let trackedOutcome: Promise<string> | undefined;
  let trackedError: unknown;

  try {
    await requestScope.run(() =>
      requestRoot.run(async () => {
        enqueueFollowupRun(key, createRun({ prompt: "queued while request admitted" }), settings);
        scheduleFollowupDrain(key, async () => {
          // The drain outlives the enqueue request across debounce and retries; by
          // the time the queued turn runs, the triggering request has settled and its
          // async work scope has closed. Model the embedded-agent-runner entry: it
          // captures the ambient tracker and bridges the whole run through it.
          await scopeClosed.promise;
          const trackOwner = captureAsyncWorkTracker();
          const work = new AsyncWorkScope();
          const context = work.run(() => AsyncLocalStorage.snapshot());
          const result = createDeferredCore<string>();
          trackedOutcome = result.promise.catch((error: unknown) => {
            trackedError = error;
            throw error;
          });
          void trackOwner(async () => {
            result.resolve(
              await work.track(async () => {
                await new Promise<void>((resolve) => {
                  setTimeout(resolve, 10);
                });
                return "turn-complete";
              }),
            );
          }).catch((error: unknown) => result.reject(error));
          try {
            await result.promise;
          } finally {
            await AsyncWorkScope.runWhenAllIdle(
              () => [work],
              () => context(() => work.drain()),
            );
            runFollowupSettled.resolve();
          }
        });
      }),
    );

    // The enqueue request returns and its owner closes the request scope while the
    // detached drain is still pending behind its debounce.
    requestRoot.release();
    await requestScope.drain();
    scopeClosed.resolve();
    await runFollowupSettled.promise;

    expect(trackedError).toBeUndefined();
    await expect(trackedOutcome!).resolves.toBe("turn-complete");
  } finally {
    scopeClosed.resolve();
    requestRoot.release();
    clearSessionQueues([key]);
    resetGatewayWorkAdmission();
  }
});
