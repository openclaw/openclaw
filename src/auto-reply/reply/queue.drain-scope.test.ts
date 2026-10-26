// Drains outlive their enqueue request. Inheriting its closed AsyncWorkScope
// would reject tracked work and silently retry the queued turn forever.
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

it.each([
  ["S1", true, "S2"],
  ["unrelated", true, undefined],
  ["unrelated", false, undefined],
] as const)(
  "drains session %s with source registration %s and admission session %s",
  async (sessionId, registered, admissionSessionId) => {
    const key = `source-runner-rebind-${sessionId}`;
    const outcome = createDeferredCore<{ runner: string; run: FollowupRun }>();
    const source = createRun({ prompt: "queued source" });
    const settings = { mode: "followup", debounceMs: 0, cap: 10 } as const;
    const record = (runner: string) => async (run: FollowupRun) => outcome.resolve({ runner, run });
    const callback = registered ? record("source") : undefined;
    source.run.sessionId = sessionId;
    try {
      enqueueFollowupRun(key, source, settings, "none", callback, false);
      scheduleFollowupDrain(key, record("wake"), undefined, { from: "S1", to: "S2" });
      const executed = await outcome.promise;
      expect(executed.runner).toBe(registered ? "source" : "wake");
      expect(executed.run.admissionSessionId).toBe(admissionSessionId);
      expect(source.admissionSessionId).toBeUndefined();
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
          // Model the runner's ambient tracker after the enqueue scope closes.
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
