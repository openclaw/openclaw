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
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import {
  getCurrentSessionControllerOwner,
  withSessionControllerOwner,
} from "../../sessions/session-controller.context.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { AsyncWorkScope, captureAsyncWorkTracker } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { clearFollowupQueue } from "./queue/state.js";

installQueueRuntimeErrorSilencer();

it.each(["S1", "unrelated"])(
  "preserves the source runner and applies the post-clear rebind only to session %s",
  async (sessionId) => {
    const key = `source-runner-rebind-${sessionId}`;
    const outcome = createDeferredCore<{ runner: string; run: FollowupRun }>();
    const source = createRun({ prompt: "queued source" });
    source.run.sessionId = sessionId;
    try {
      enqueueFollowupRun(
        key,
        source,
        { mode: "followup", debounceMs: 0, cap: 10 },
        "none",
        async (run) => outcome.resolve({ runner: "source", run }),
        false,
      );
      scheduleFollowupDrain(
        key,
        async (run) => outcome.resolve({ runner: "wake", run }),
        undefined,
        { from: "S1", to: "S2" },
      );
      const executed = await outcome.promise;
      expect(executed.runner).toBe("source");
      expect(executed.run.admissionSessionId).toBe(sessionId === "S1" ? "S2" : undefined);
      expect(source.admissionSessionId).toBeUndefined();
      await source.controllerInput?.claim?.settlement.promise;
    } finally {
      clearFollowupQueue(key);
    }
  },
);

it.each([true, false])(
  "uses the source runner when registered=%s, otherwise the waking runner",
  async (registered) => {
    const key = `source-runner-${registered}`;
    const outcome = createDeferredCore<string>();
    const source = createRun({ prompt: "queued source" });
    try {
      enqueueFollowupRun(
        key,
        source,
        { mode: "followup", debounceMs: 0, cap: 10 },
        "none",
        registered ? async () => outcome.resolve("source") : undefined,
        false,
      );
      scheduleFollowupDrain(key, async () => outcome.resolve("wake"));
      await expect(outcome.promise).resolves.toBe(registered ? "source" : "wake");
      await source.controllerInput?.claim?.settlement.promise;
    } finally {
      clearFollowupQueue(key);
    }
  },
);

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
          trackedOutcome = result.promise;
          void trackOwner(async () => {
            result.resolve(await work.track(async () => "turn-complete"));
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

    await expect(trackedOutcome!).resolves.toBe("turn-complete");
  } finally {
    scopeClosed.resolve();
    requestRoot.release();
    clearFollowupQueue(key);
    resetGatewayWorkAdmission();
  }
});

it("admits a queued successor without borrowing the retiring turn that wakes its mailbox", async () => {
  const key = "agent:main:retiring-drain-owner";
  const sessionId = "retiring-drain-owner-session";
  const previous = createReplyOperation({ sessionKey: key, sessionId, resetTriggered: false });
  const outcome = createDeferredCore<string>();
  const queued = createRun({ prompt: "successor" });
  queued.run.sessionId = sessionId;
  queued.run.sessionKey = key;
  try {
    withSessionControllerOwner(previous, () => {
      enqueueFollowupRun(key, queued, { mode: "followup", debounceMs: 0, cap: 10 });
      scheduleFollowupDrain(key, async () => {
        // Backend admission must acquire new custody, not stale ambient ownership.
        try {
          expect(getCurrentSessionControllerOwner()).toBeUndefined();
          const successor = createReplyOperation({
            sessionKey: key,
            sessionId,
            resetTriggered: false,
            mailboxClaim: queued.controllerInput!.claim!,
          });
          try {
            outcome.resolve(
              await withSessionControllerOwner(successor, () =>
                withSessionTurn({ sessionKey: key, sessionId }, async (operation) => {
                  expect(operation).toBe(successor);
                  return "successor completed";
                }),
              ),
            );
          } finally {
            successor.complete();
          }
        } catch (error) {
          outcome.reject(error);
        }
      });
      previous.complete();
    });
    await expect(outcome.promise).resolves.toBe("successor completed");
  } finally {
    previous.complete();
    clearFollowupQueue(key);
  }
});
