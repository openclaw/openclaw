// Resolver ownership ends before delivery-only after-clear work.
import { AsyncResource } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { createEnteredGate as createGate } from "../../agents/entered-gate.test-support.js";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import { resolveReplyCompletion } from "../../agents/reply-completion.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import {
  interruptSessionControllerEffects,
  isSessionControllerWorkActive,
  runSessionMutation,
  captureSessionTarget,
  captureSessionControllerSettlement,
} from "../../sessions/session-controller.lifecycle.js";
import {
  claimSessionControllerTask,
  reserveSessionControllerSource,
  releaseSessionControllerClaim,
} from "../../sessions/session-controller.mailbox.js";
import {
  getSessionControllerEntryForOperation,
  producerCompletionByOperation,
} from "../../sessions/session-controller.state.js";
import { SESSION_WATCHDOG_CLEANUP_MS } from "../../sessions/session-controller.watchdog-state.js";
import { settleReplyDispatcher } from "../dispatch-dispatcher.js";
import type { RuntimeMsgContext as MsgContext } from "../templating.js";
import {
  createDispatcher,
  createHookCtx,
  emptyConfig,
  hookMocks,
  mockSessionStorePath,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  createReplyOperation,
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  requireBlockReplyHandler,
  resetDeliverySettlementFixture,
  setNoAbort,
  getSessionControllerOperation,
} from "./dispatch-from-config.test-support.js";
import type { DispatchFromConfigParams } from "./dispatch-from-config.types.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { bindReplySourceInput } from "./reply-source-binding.js";
import { buildTestCtx } from "./test-ctx.js";

let listActiveReplyRunSessionKeys: typeof import("../../sessions/session-controller.queries.js").listActiveReplyRunSessionKeys;
let runAfterReplyOperationClear: typeof import("../../sessions/session-controller.js").runAfterReplyOperationClear;
let resetSessionControllerForTest: typeof import("../../sessions/session-controller.test-support.js").testing.resetSessionControllerForTest;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
type Operation = ReturnType<typeof createReplyOperation>;

function dispatchOwned({
  sessionKey,
  context,
  cfg = emptyConfig,
  ...params
}: Omit<DispatchFromConfigParams, "ctx" | "cfg"> & {
  sessionKey?: string;
  context?: Partial<MsgContext>;
  cfg?: DispatchFromConfigParams["cfg"];
}) {
  return dispatchReplyFromConfig({
    cfg,
    ...params,
    ctx: sessionKey
      ? buildTestCtx({
          Provider: "discord",
          Surface: "discord",
          SessionKey: sessionKey,
          ...context,
        })
      : createHookCtx(),
  });
}

function blockCompletion(options: InternalGetReplyOptions | undefined) {
  const runState = resolveReplyOperationRunState(options);
  if (!runState) {
    throw new Error("expected reply operation run state");
  }
  runState.replyCompletion = resolveReplyCompletion(
    runState.replyCompletion?.expectation ?? "required",
    "blocked",
  );
}

beforeAll(async () => {
  await globalBeforeAll0();
  ({ listActiveReplyRunSessionKeys } =
    await import("../../sessions/session-controller.queries.js"));
  ({ runAfterReplyOperationClear } = await import("../../sessions/session-controller.js"));
  ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  const { testing } = await import("../../sessions/session-controller.test-support.js");
  resetSessionControllerForTest = () => testing.resetSessionControllerForTest();
});

describe("dispatchReplyFromConfig owner settlement", () => {
  beforeEach(() => {
    describe0BeforeEach0();
    setNoAbort();
  });

  afterEach(() => {
    resetSessionControllerForTest();
    resetInboundDedupe();
    clearAgentHarnesses();
  });

  it("allows final delivery to await a visible successor after producer handoff", async ({
    signal,
  }) => {
    const sessionKey = "agent:main:delivery-successor";
    const deliveryEntered = createDeferred();
    const initialDelivery = createDeferred();
    const successorDispatcher = createDispatcher();
    const successorEntered = createDeferred();
    const finishDelivery = createDeferred();
    const cleanup = createGate();
    const ownerSettled = vi.fn();
    const successorAbort = new AbortController();
    const events: string[] = [];
    let operation: Operation | undefined;
    let successorDispatch: Promise<unknown> | undefined;
    let dispatcherSettlement: Promise<unknown> | undefined;
    const source = reserveSessionControllerSource(sessionKey, {
      target: captureSessionTarget({ storeScope: mockSessionStorePath, sessionKey }),
      policy: { mode: "followup" },
      adapter: { signal, onSettled: cleanup.wait },
    });
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        if (payload.text === "visible progress") {
          initialDelivery.resolve();
          return;
        }
        deliveryEntered.resolve();
        successorDispatch = dispatchOwned({
          sessionKey,
          context: { MessageSid: "successor" },
          dispatcher: successorDispatcher,
          replyOptions: { abortSignal: AbortSignal.any([signal, successorAbort.signal]) },
          replyResolver: async () => {
            events.push("successor");
            successorEntered.resolve();
            return { text: "successor answer" };
          },
        });
        await successorDispatch;
        await finishDelivery.promise;
        events.push("delivered");
      },
    });
    const dispatch = dispatchOwned({
      sessionKey,
      context: { MessageSid: "predecessor" },
      dispatcher,
      replyOptions: bindReplySourceInput({ abortSignal: signal }, source),
      replyResolver: async (_ctx, options) => {
        operation = options?.replyOperation;
        void operation?.ownerSettlement.then(ownerSettled);
        await options?.onBlockReply?.({ text: "visible progress" });
        await initialDelivery.promise;
        await dispatcher.waitForIdle();
        return { text: "predecessor answer" };
      },
    });
    try {
      await withinTest(deliveryEntered.promise, signal);
      await withinTest(dispatch, signal);
      dispatcherSettlement = settleReplyDispatcher({ dispatcher });
      expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
      await withinTest(cleanup.entered, signal);
      expect(() =>
        createReplyOperation({
          sessionKey,
          sessionId: "too-early",
          target: source.target,
          resetTriggered: false,
        }),
      ).toThrow();
      expect(events).toEqual([]);
      cleanup.release();
      await withinTest(successorEntered.promise, signal);
      expect(ownerSettled).not.toHaveBeenCalled();
      expect(events).toEqual(["successor"]);
      finishDelivery.resolve();
      await dispatcherSettlement;
      await operation?.ownerSettlement;
      expect(events).toEqual(["successor", "delivered"]);
      expect(ownerSettled).toHaveBeenCalledOnce();
    } finally {
      successorAbort.abort();
      finishDelivery.resolve();
      cleanup.release();
      dispatcher.markComplete();
      successorDispatcher.markComplete();
      await Promise.allSettled([dispatch, successorDispatch]);
      await successorDispatcher.waitForIdle();
      await (dispatcherSettlement ?? settleReplyDispatcher({ dispatcher }));
      operation?.complete();
      await operation?.ownerSettlement;
    }
  });

  it("releases a source claim after terminal fencing settles its owner", async ({ signal }) => {
    const sessionKey = "agent:main:fenced-source-claim";
    const sourceSettled = vi.fn();
    const source = reserveSessionControllerSource(sessionKey, {
      target: captureSessionTarget({ storeScope: mockSessionStorePath, sessionKey }),
      policy: { mode: "followup" },
      adapter: { onSettled: sourceSettled },
    });
    const dispatcher = createDispatcher();
    let operation: Operation | undefined;
    let releaseExecution: (() => void) | undefined;
    const producerCompleted = vi.fn();
    try {
      await dispatchOwned({
        sessionKey,
        dispatcher,
        replyOptions: bindReplySourceInput({}, source),
        replyResolver: async (_ctx, options) => {
          operation = options?.replyOperation;
          releaseExecution = operation?.retainExecution();
          operation?.registerTerminalProducerFence(async () => true);
          return { text: "finished answer" };
        },
      });
      dispatcher.markComplete();
      await settleReplyDispatcher({ dispatcher });
      if (!operation) {
        throw new Error("missing fenced owner");
      }
      void producerCompletionByOperation.get(operation)?.then(producerCompleted);
      operation.fail("run_failed", new Error("terminal producer failed"));
      await withinTest(
        operation.watchdog.tick(Date.now() + SESSION_WATCHDOG_CLEANUP_MS + 1),
        signal,
      );
      await withinTest(operation.ownerSettlement, signal);
      await vi.waitFor(() => expect(sourceSettled).toHaveBeenCalledOnce());
      await source.settlement.promise;
      expect(producerCompleted).not.toHaveBeenCalled();
      const successor = createReplyOperation({
        sessionKey,
        sessionId: "after-fencing",
        target: source.target,
        resetTriggered: false,
      });
      successor.complete();
      await successor.ownerSettlement;
    } finally {
      releaseExecution?.();
      operation?.complete();
      dispatcher.markComplete();
      await settleReplyDispatcher({ dispatcher });
      await operation?.ownerSettlement;
      await source.settlement.promise;
    }
  });

  it.each([
    ["block", "delivered", "reply:block_delivered"],
    ["block", "cancelled", "reply:block_delivered"],
    ["final", "delivered", "reply:final_delivered"],
    ["final", "failed", "reply:final_delivered"],
  ])("renews %s finalization only for its %s receipt", async (kind, outcome, event) => {
    let observed: MockInstance<Operation["watchdog"]["progress"]>;
    const dispatcher = createReplyDispatcher({
      beforeDeliver: async (payload) => (outcome === "cancelled" ? null : payload),
      deliver: async () => {
        if (outcome === "failed") {
          throw new PlatformMessageNotDispatchedError("synthetic receipt failure", {
            cause: new Error("offline"),
          });
        }
      },
      onError: () => {},
    });
    try {
      await dispatchOwned({
        sessionKey: "agent:main:receipt-progress",
        dispatcher,
        replyResolver: async (_ctx, options) => {
          const watchdog = options?.replyOperation?.watchdog;
          if (!watchdog) {
            throw new Error("missing receipt owner");
          }
          observed = vi.spyOn(watchdog, "progress");
          if (kind === "block") {
            await requireBlockReplyHandler(options?.onBlockReply)({ text: "receipt answer" });
            return undefined;
          }
          return { text: "receipt answer" };
        },
      });
      await dispatcher.waitForIdle();
      expect(
        observed!.mock.calls.some(([phase, name]) => phase === "finalization" && name === event),
      ).toBe(outcome === "delivered");
    } finally {
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
    }
  });

  it("renews finalization only for delivered content, not transport callbacks", async () => {
    const forwarded = vi.fn(async () => true);
    await dispatchOwned({
      sessionKey: "agent:main:finalization-progress",
      dispatcher: createDispatcher(),
      replyOptions: { onPartialReply: forwarded, onAssistantMessageStart: async () => {} },
      replyResolver: async (_ctx, options) => {
        expect(options?.replyOperation).toBeDefined();
        const progress = vi.spyOn(options!.replyOperation!.watchdog, "progress");
        options!.replyOperation!.freezeAbort();
        await options?.onAssistantMessageStart?.();
        expect(progress).not.toHaveBeenCalledWith("finalization", expect.anything());
        await options?.onPartialReply?.({ text: "delivered answer" });
        expect(progress).toHaveBeenCalledWith("finalization", "reply:partial_delivered");
        return undefined;
      },
    });
    expect(forwarded).toHaveBeenCalledOnce();
  });

  it.each(["owned", "queued deletion", "queued cancellation"] as const)(
    "holds %s resolver work until it settles",
    async (mode) => {
      const queued = mode !== "owned";
      const sessionKey = "agent:main:discord:channel:resolver-race";
      const sessionId = "resolver-session";
      const scope = { scope: mockSessionStorePath, identities: [sessionKey, sessionId] };
      sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
      const predecessor = queued
        ? createReplyOperation({ sessionKey, sessionId, resetTriggered: false })
        : undefined;
      const resolver = createGate();
      const mutationPrepared = createDeferred();
      const dispatcher = createDispatcher();
      const upstreamAbort = new AbortController();
      const external = new AsyncResource("external-resolver-lifecycle");
      const sourceSettled = vi.fn();
      let sourceSettlement: ReturnType<typeof captureSessionControllerSettlement>;
      let operation: InternalGetReplyOptions["replyOperation"];
      let resumedOwner: typeof operation;
      let resolverSignal: AbortSignal | undefined;
      let resolverFinished = false,
        mutationRan = false,
        mutationObservedSettledResolver = false;
      let mutation: Promise<void> | undefined;
      const dispatch = dispatchOwned({
        sessionKey,
        context: {
          To: "discord:channel:resolver-race",
          AccountId: "default",
          Body: "hold this resolver",
          ...(queued ? { InternalTurnSource: "event" } : {}),
        },
        dispatcher,
        ...(queued
          ? {
              replyOptions: {
                abortSignal: upstreamAbort.signal,
                queueModeOverride: "followup",
                turnAdoptionLifecycle: { admission: "exclusive", onAdopted() {} },
                internalEventExecution: { onStarted() {}, onTerminal() {} },
              },
            }
          : {}),
        replyResolver: async (_ctx, opts) => {
          operation = opts?.replyOperation;
          resolverSignal = opts?.abortSignal;
          await resolver.wait();
          resolverFinished = true;
          if (!queued) {
            resumedOwner = getSessionControllerOperation(sessionKey);
            await requireBlockReplyHandler(opts?.onBlockReply)({ text: "stale late block" });
          }
          return { text: "stale late reply" };
        },
      });
      try {
        await resolver.entered;
        predecessor?.complete();
        if (queued) {
          // Queued preparation owns cleanup without projecting as an executing turn.
          sourceSettlement = captureSessionControllerSettlement(scope);
          expect(sourceSettlement).toBeDefined();
          void sourceSettlement?.then(sourceSettled, sourceSettled);
          await Promise.resolve();
          expect(sourceSettled).not.toHaveBeenCalled();
          if (mode === "queued cancellation") {
            upstreamAbort.abort();
            expect(resolverSignal?.aborted).toBe(true);
          }
        }
        mutation = external.runInAsyncScope(() => {
          const work = {
            ...scope,
            prepare: async () => {
              if (queued) {
                mutationPrepared.resolve();
              } else {
                await interruptSessionControllerEffects(scope);
              }
            },
            run: async () => {
              mutationRan = true;
              mutationObservedSettledResolver = resolverFinished;
            },
          };
          return queued
            ? runSessionMutation({
                ...work,
                kind: "delete",
                policy: "preempt",
                preempt: { activeRun: "abort", waitingInputs: "cancel" },
              })
            : runSessionMutation(work);
        });
        if (queued) {
          await mutationPrepared.promise;
          await vi.waitFor(() => expect(resolverSignal?.aborted).toBe(true));
          expect(sourceSettled).not.toHaveBeenCalled();
        } else {
          expect(operation).toBeDefined();
          expect((await dispatch).queuedFinal).toBe(false);
          expect(getSessionControllerOperation(sessionKey)).toBe(operation);
          expect(operation?.abortSignal.aborted).toBe(true);
          expect(isSessionControllerWorkActive(scope.scope, scope.identities)).toBe(true);
        }
        expect(mutationRan).toBe(false);
        resolver.release();
        await mutation;
        if (queued) {
          expect((await dispatch).queuedFinal).toBe(false);
          await sourceSettlement;
          expect(sourceSettled).toHaveBeenCalledOnce();
          expect(mutationObservedSettledResolver).toBe(true);
          expect(isSessionControllerWorkActive(scope.scope, scope.identities)).toBe(false);
        } else {
          expect(resumedOwner).toBe(operation);
          expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
          expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
        }
        expect(mutationRan).toBe(true);
        expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      } finally {
        predecessor?.complete();
        resolver.release();
        await Promise.allSettled([dispatch, mutation]);
        external.emitDestroy();
      }
    },
  );

  describe("delivery settlement", () => {
    beforeEach(resetDeliverySettlementFixture);

    it.each([
      "transport failure",
      "subsequent block",
      "aborted progress",
      "cancelled block and tool-only reply",
    ] as const)(
      "dispatchReplyFromConfig settles queued presentation after %s through retained callbacks",
      async (phase) => {
        let retained: InternalGetReplyOptions | undefined;
        const delivery = createGate(),
          secondDelivery = createGate();
        const resolverEntered = createDeferred();
        const returnResolver = createDeferred();
        const cancelled = phase === "cancelled block and tool-only reply";
        const failure = new Error("queued transport failed");
        const onQueuedFollowupSettled = vi.fn();
        const abortController = new AbortController();
        let progress: Promise<unknown> | undefined;
        const dispatcher = createReplyDispatcher({
          humanDelay: { mode: "custom", minMs: 1, maxMs: 1 },
          beforeDeliver: async (payload) => {
            if (cancelled && payload.text === "initial reply") {
              return null;
            }
            return payload;
          },
          deliver: async (payload) => {
            if (payload.text === "second queued reply") {
              await secondDelivery.wait();
            }
            if (payload.text === "queued reply") {
              await delivery.wait();
              if (phase === "transport failure") {
                throw failure;
              }
            }
          },
          onError: () => {},
        });
        const dispatch = dispatchOwned({
          dispatcher,
          replyOptions: { onQueuedFollowupSettled, abortSignal: abortController.signal },
          replyResolver: async (_ctx, opts) => {
            retained = opts;
            await opts?.onBlockReply?.({ text: "initial reply" });
            if (cancelled) {
              blockCompletion(opts);
            }
            resolverEntered.resolve();
            if (phase === "aborted progress") {
              await returnResolver.promise;
            }
            return undefined;
          },
        });
        try {
          if (phase === "aborted progress") {
            await resolverEntered.promise;
          } else {
            await dispatch;
          }
          dispatcher.markComplete();
          await dispatcher.waitForIdle();
          if (cancelled) {
            dispatcher.sendToolResult({ text: "queued reply" });
          } else {
            await retained?.onBlockReply?.({ text: "queued reply" });
          }
          await delivery.entered;
          if (phase === "subsequent block" || phase === "aborted progress") {
            progress = Promise.resolve(retained?.onPlanUpdate?.({ phase: "update", steps: [] }));
            if (phase === "aborted progress") {
              abortController.abort();
              await progress;
            }
          }
          if (phase === "subsequent block") {
            await retained?.onBlockReply?.({ text: "second queued reply" });
          }
          const cleanup = retained?.onQueuedFollowupSettled?.();
          await nextTurn();
          const cleanedUpBeforeDelivery = onQueuedFollowupSettled.mock.calls.length;
          delivery.release();
          returnResolver.resolve();
          if (phase === "subsequent block") {
            await secondDelivery.entered;
            expect(onQueuedFollowupSettled).not.toHaveBeenCalled();
          }
          secondDelivery.release();
          await cleanup;
          await progress;
          await dispatch;
          const receipt = await settleReplyDispatcher({ dispatcher });
          expect(cleanedUpBeforeDelivery).toBe(cancelled ? 1 : 0);
          expect(onQueuedFollowupSettled).toHaveBeenCalledOnce();
          expect(receipt?.counts.block).toMatchObject({
            delivered: cancelled
              ? 0
              : phase === "transport failure"
                ? 1
                : phase === "subsequent block"
                  ? 3
                  : 2,
            failedAfterSend: phase === "transport failure" ? 1 : 0,
          });
        } finally {
          delivery.release();
          secondDelivery.release();
          returnResolver.resolve();
          dispatcher.markComplete();
          await dispatcher.waitForIdle();
          await progress;
          await dispatch;
          await settleReplyDispatcher({ dispatcher });
        }
      },
    );

    it.each([
      { phase: "rejected delivery and cleanup", deliveryFails: true },
      { phase: "rejected cleanup", deliveryFails: false },
    ])(
      "runs queued cleanup after $phase and preserves the first failure",
      async ({ deliveryFails }) => {
        let retained: InternalGetReplyOptions | undefined;
        const transport = createGate();
        const deliveryFailure = new PlatformMessageNotDispatchedError("offline before dispatch", {
          cause: new Error("offline"),
        });
        const cleanupFailure = new Error("queued cleanup failed");
        const onQueuedFollowupSettled = vi.fn(async () => {
          throw cleanupFailure;
        });
        const dispatcher = createReplyDispatcher({
          propagateRetryableNoSendFailure: true,
          deliver: async () => {
            await transport.wait();
            if (deliveryFails) {
              throw deliveryFailure;
            }
          },
          onError: () => {},
        });
        try {
          await dispatchOwned({
            dispatcher,
            replyOptions: { onQueuedFollowupSettled },
            replyResolver: async (_ctx, opts) => {
              retained = opts;
              blockCompletion(opts);
              return undefined;
            },
          });
          dispatcher.markComplete();
          await dispatcher.waitForIdle();
          await retained?.onBlockReply?.({ text: "queued reply" });
          await transport.entered;
          const cleanup = Promise.resolve(retained?.onQueuedFollowupSettled?.()).catch(
            (error: unknown) => error,
          );
          await nextTurn();
          expect(onQueuedFollowupSettled).not.toHaveBeenCalled();
          transport.release();

          expect(await cleanup).toBe(deliveryFails ? deliveryFailure : cleanupFailure);
          expect(onQueuedFollowupSettled).toHaveBeenCalledOnce();
          if (deliveryFails) {
            await expect(dispatcher.waitForIdle()).rejects.toBe(deliveryFailure);
          } else {
            expect((await dispatcher.waitForIdle())?.counts.block.delivered).toBe(1);
          }
        } finally {
          transport.release();
          dispatcher.markComplete();
          await settleReplyDispatcher({ dispatcher }).catch(() => undefined);
        }
      },
    );

    it.each(["final delivery", "block receipt callback"] as const)(
      "clears the reply lane but defers follow-up admission until %s settles",
      async (phase) => {
        const holdReceiptCallback = phase === "block receipt callback";
        const heldOrder = holdReceiptCallback
          ? ["block-delivered", "callback-start"]
          : ["final-start"];
        const completedOrder = holdReceiptCallback
          ? ["block-delivered", "callback-start", "callback-end", "followup"]
          : ["final-start", "final-end", "followup"];
        const deliveryOrder: string[] = [];
        const delivery = createGate();
        const followupEntered = createDeferred();
        let receiptCallbackWork: Promise<void> | undefined;
        const dispatcher = createReplyDispatcher({
          deliver: async (_payload, info) => {
            if (holdReceiptCallback) {
              deliveryOrder.push(`${info.kind}-delivered`);
              return;
            }
            deliveryOrder.push("final-start");
            await delivery.wait();
            deliveryOrder.push("final-end");
          },
        });
        let operation: Operation | undefined;
        let queuedOperation: Operation | undefined;
        let successorClaim: Awaited<ReturnType<typeof claimSessionControllerTask>> | undefined;
        let successorAdmission: Promise<void> | undefined;
        const abortController = new AbortController();
        hookMocks.runner.runReplyDispatch.mockImplementation(async (_event, contextValue) => {
          operation = getSessionControllerOperation("agent:test:session");
          if (!operation) {
            throw new Error("expected dispatch reply operation");
          }
          runAfterReplyOperationClear(operation, () => {
            const source = reserveSessionControllerSource("agent:test:session", {
              policy: { mode: "followup" },
              target: getSessionControllerEntryForOperation(operation!).target,
            });
            successorAdmission = claimSessionControllerTask(source, (claim) => {
              followupEntered.resolve();
              deliveryOrder.push("followup");
              successorClaim = claim;
              queuedOperation = createReplyOperation({
                mailboxClaim: claim,
                sessionKey: "agent:test:session",
                sessionId: "queued-session",
                resetTriggered: false,
              });
            }).then(() => {});
          });
          if (holdReceiptCallback) {
            return undefined;
          }
          const context = contextValue as { dispatcher: typeof dispatcher };
          return {
            handled: true,
            queuedFinal: context.dispatcher.sendFinalReply({ text: "first reply" }),
            counts: context.dispatcher.getQueuedCounts(),
          };
        });
        const dispatchPromise = dispatchOwned({
          dispatcher,
          replyOptions: {
            abortSignal: abortController.signal,
            onBlockReplyQueued: holdReceiptCallback
              ? () => {
                  deliveryOrder.push("callback-start");
                  receiptCallbackWork = delivery.wait().then(() => {
                    deliveryOrder.push("callback-end");
                  });
                  return receiptCallbackWork;
                }
              : undefined,
          },
          replyResolver: async (_ctx, opts) => {
            await opts?.onBlockReply?.({ text: "first reply" });
            return undefined;
          },
        });

        try {
          await delivery.entered;
          const result = await dispatchPromise;

          expect(result.queuedFinal).toBe(!holdReceiptCallback);
          expect(getSessionControllerOperation("agent:test:session")).toBeUndefined();
          if (holdReceiptCallback) {
            const receipt = await dispatcher.waitForIdle();
            expect(receipt?.counts.block.delivered).toBe(1);
          }
          expect(deliveryOrder).toEqual(heldOrder);
          expect(queuedOperation).toBeUndefined();

          abortController.abort();
          await Promise.resolve();
          expect(queuedOperation).toBeUndefined();

          delivery.release();
          await settleReplyDispatcher({ dispatcher });
          await followupEntered.promise;

          expect(deliveryOrder).toEqual(completedOrder);
          expect(getSessionControllerOperation("agent:test:session")).toBe(queuedOperation);
        } finally {
          delivery.release();
          dispatcher.markComplete();
          await Promise.allSettled([dispatchPromise, receiptCallbackWork]);
          await settleReplyDispatcher({ dispatcher });
          operation?.complete();
          if (operation) {
            await followupEntered.promise;
            expect(queuedOperation).toBeDefined();
          }
          await successorAdmission;
          queuedOperation?.complete();
          if (successorClaim) {
            releaseSessionControllerClaim(successorClaim);
            await successorClaim.settlement.promise;
          }
          expect(listActiveReplyRunSessionKeys()).toEqual([]);
        }
      },
    );
  });
});
