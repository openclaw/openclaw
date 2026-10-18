// Resolver ownership ends before delivery-only after-clear work.
import { AsyncResource } from "node:async_hooks";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
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
import type { RuntimeMsgContext as MsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import {
  createDispatcher,
  createHookCtx,
  emptyConfig,
  hookMocks,
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
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { bindReplySourceInput, readReplySourceInput } from "./reply-source-binding.js";
import { buildTestCtx } from "./test-ctx.js";

let listActiveReplyRunSessionKeys: typeof import("../../sessions/session-controller.js").listActiveReplyRunSessionKeys;
let runAfterReplyOperationClear: typeof import("../../sessions/session-controller.js").runAfterReplyOperationClear;
let resetSessionControllerForTest: typeof import("../../sessions/session-controller.test-support.js").testing.resetSessionControllerForTest;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;

beforeAll(async () => {
  await globalBeforeAll0();
  ({ listActiveReplyRunSessionKeys } = await import("../../sessions/session-controller.js"));
  ({ runAfterReplyOperationClear } = await import("../../sessions/session-controller.js"));
  ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  const { testing } = await import("../../sessions/session-controller.test-support.js");
  resetSessionControllerForTest = () => testing.resetSessionControllerForTest();
});

describe("dispatchReplyFromConfig owner settlement", () => {
  beforeEach(describe0BeforeEach0);

  afterEach(() => {
    resetSessionControllerForTest();
    resetInboundDedupe();
    vi.useRealTimers();
    clearAgentHarnesses();
  });

  it("keeps queued follow-ups behind actual resolver and delivery settlement", async () => {
    setNoAbort();
    const resolverEntered = createDeferred();
    const releaseResolver = createDeferred();
    const releaseDelivery = createDeferred();
    const deliveryEntered = createDeferred();
    const sessionKey = "agent:main:mailbox-source-boundary";
    const storePath = "/test/mailbox-source.sqlite";
    sessionStoreMocks.resolveSessionStorePathCore.mockReturnValue(storePath);
    let source: ReturnType<typeof readReplySourceInput>;
    const ownerSettled = vi.fn();
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        deliveryEntered.resolve();
        await releaseDelivery.promise;
      },
    });
    const dispatch = dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "discord", Surface: "discord", SessionKey: sessionKey }),
      cfg: { ...emptyConfig, session: { ...emptyConfig.session, store: storePath } },
      dispatcher,
      replyResolver: async (_ctx, options) => {
        source = readReplySourceInput(options);
        expect(source?.claim?.operation).toBe(options?.replyOperation);
        expect(source?.mailbox.owner.target?.storeScope).toBe(storePath);
        void options?.replyOperation?.ownerSettlement.then(ownerSettled);
        resolverEntered.resolve();
        await releaseResolver.promise;
        return { text: "settled answer" };
      },
    });
    await resolverEntered.promise;
    const successor = reserveSessionControllerSource(sessionKey, {
      target: captureSessionTarget({ storeScope: storePath, sessionKey }),
      policy: { mode: "followup" },
    });
    const selected = vi.fn();
    const next = claimSessionControllerTask(successor, selected, "queued_followup");
    expect(selected).not.toHaveBeenCalled();
    releaseResolver.resolve();
    await deliveryEntered.promise;
    expect(selected).not.toHaveBeenCalled();
    expect(ownerSettled).not.toHaveBeenCalled();
    releaseDelivery.resolve();
    await dispatch;
    const claim = await next;
    expect(selected).toHaveBeenCalledOnce();
    releaseSessionControllerClaim(claim);
  });

  it("allows final delivery to await a visible successor after producer handoff", async ({
    signal,
  }) => {
    setNoAbort();
    const sessionKey = "agent:main:delivery-successor";
    const deliveryEntered = createDeferred();
    const initialDelivery = createDeferred();
    const successorDispatcher = createDispatcher();
    const successorEntered = createDeferred();
    const finishDelivery = createDeferred();
    const cleanupEntered = createDeferred();
    const finishCleanup = createDeferred();
    const ownerSettled = vi.fn();
    const successorAbort = new AbortController();
    const events: string[] = [];
    let operation: ReturnType<typeof createReplyOperation> | undefined;
    let successorDispatch: Promise<unknown> | undefined;
    const source = reserveSessionControllerSource(sessionKey, {
      target: captureSessionTarget({
        storeScope: "/tmp/mock-sessions.json",
        sessionKey,
      }),
      policy: { mode: "followup" },
      adapter: {
        signal,
        onSettled: async () => {
          cleanupEntered.resolve();
          await finishCleanup.promise;
        },
      },
    });
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        if (payload.text === "visible progress") {
          initialDelivery.resolve();
          return;
        }
        deliveryEntered.resolve();
        successorDispatch = dispatchReplyFromConfig({
          ctx: buildTestCtx({
            Provider: "discord",
            Surface: "discord",
            SessionKey: sessionKey,
            MessageSid: "successor",
          }),
          cfg: emptyConfig,
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
    const dispatch = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: sessionKey,
        MessageSid: "predecessor",
      }),
      cfg: emptyConfig,
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
      dispatcher.markComplete();
      expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
      await withinTest(cleanupEntered.promise, signal);
      expect(() =>
        createReplyOperation({
          sessionKey,
          sessionId: "too-early",
          target: source.target,
          resetTriggered: false,
        }),
      ).toThrow();
      expect(events).toEqual([]);
      finishCleanup.resolve();
      await withinTest(successorEntered.promise, signal);
      expect(ownerSettled).not.toHaveBeenCalled();
      expect(events).toEqual(["successor"]);
      finishDelivery.resolve();
      await dispatcher.waitForIdle();
      await operation?.ownerSettlement;
      expect(events).toEqual(["successor", "delivered"]);
      expect(ownerSettled).toHaveBeenCalledOnce();
    } finally {
      successorAbort.abort();
      finishDelivery.resolve();
      finishCleanup.resolve();
      dispatcher.markComplete();
      successorDispatcher.markComplete();
      await Promise.allSettled([dispatch, successorDispatch]);
      await successorDispatcher.waitForIdle();
      await dispatcher.waitForIdle();
      operation?.complete();
      await operation?.ownerSettlement;
    }
  });

  it("releases a source claim after terminal fencing settles its owner", async ({ signal }) => {
    setNoAbort();
    const sessionKey = "agent:main:fenced-source-claim";
    const sourceSettled = vi.fn();
    const source = reserveSessionControllerSource(sessionKey, {
      target: captureSessionTarget({ storeScope: "/tmp/mock-sessions.json", sessionKey }),
      policy: { mode: "followup" },
      adapter: { onSettled: sourceSettled },
    });
    const dispatcher = createDispatcher();
    let operation: ReturnType<typeof createReplyOperation> | undefined;
    let releaseExecution: (() => void) | undefined;
    const producerCompleted = vi.fn();
    try {
      await dispatchReplyFromConfig({
        ctx: buildTestCtx({ Provider: "discord", Surface: "discord", SessionKey: sessionKey }),
        cfg: emptyConfig,
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
      await dispatcher.waitForIdle();
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
      await dispatcher.waitForIdle();
      await operation?.ownerSettlement;
      await source.settlement.promise;
    }
  });

  it("renews finalization only for delivered content, not transport callbacks", async () => {
    setNoAbort();
    const forwarded = vi.fn(async () => true);
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:main:finalization-progress",
      }),
      cfg: emptyConfig,
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

  it("waits for late resolver cleanup and real delivery after finalization expiry", async () => {
    setNoAbort();
    const ownerWork = createDeferred();
    const resolverEntered = createDeferred();
    const delivery = createDeferred();
    const deliveryStarted = createDeferred();
    const delivered = vi.fn();
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        deliveryStarted.resolve();
        await delivery.promise;
        delivered();
      },
    });
    const sessionKey = "agent:main:late-finalization";
    let operation: ReturnType<typeof createReplyOperation> | undefined;
    const dispatch = dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "discord", Surface: "discord", SessionKey: sessionKey }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async (_ctx, opts) => {
        operation = opts?.replyOperation;
        await opts?.onBlockReply?.({ text: "finished answer" });
        resolverEntered.resolve();
        await ownerWork.promise;
        return undefined;
      },
    });
    await resolverEntered.promise;
    await deliveryStarted.promise;
    expect(operation?.ownerSettlement).toBeDefined();
    const settled = vi.fn();
    void operation?.ownerSettlement?.then(settled);
    vi.useFakeTimers();
    try {
      operation?.freezeAbort();
      await vi.advanceTimersByTimeAsync(60_000);
      // Expiry requests cleanup; it cannot settle this unresolved resolver.
      expect(getSessionControllerOperation(sessionKey)).toBe(operation);
      expect(settled).not.toHaveBeenCalled();
      expect(delivered).not.toHaveBeenCalled();

      ownerWork.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).not.toHaveBeenCalled();
      expect(delivered).not.toHaveBeenCalled();

      delivery.resolve();
      await dispatch;
      await operation?.ownerSettlement;
      expect(delivered).toHaveBeenCalledOnce();
      expect(settled).toHaveBeenCalledOnce();
      expect(operation?.result).toMatchObject({ kind: "completed" });
    } finally {
      ownerWork.resolve();
      delivery.resolve();
      dispatcher.markComplete();
      await dispatch;
      await dispatcher.waitForIdle();
      await operation?.ownerSettlement;
      vi.useRealTimers();
    }
  });

  it("suppresses superseded output and awaits the successor delivery receipt", async () => {
    setNoAbort();
    const entered = createDeferred();
    const releaseOld = createDeferred();
    const deliveryStarted = createDeferred();
    const releaseDelivery = createDeferred();
    const successorFinished = createDeferred();
    const delivered: string[] = [];
    const oldDispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
    });
    const nextDispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        deliveryStarted.resolve();
        await releaseDelivery.promise;
        delivered.push(payload.text ?? "");
      },
    });
    const sessionKey = "agent:main:superseded-delivery";
    let predecessor: ReturnType<typeof createReplyOperation> | undefined;
    let successor: ReturnType<typeof createReplyOperation> | undefined;
    let nextDispatch: Promise<unknown> | undefined;
    const oldDispatch = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: sessionKey,
        MessageSid: "old-turn",
      }),
      cfg: emptyConfig,
      dispatcher: oldDispatcher,
      replyResolver: async (_ctx, opts) => {
        predecessor = opts?.replyOperation;
        entered.resolve();
        await releaseOld.promise;
        await opts?.onBlockReply?.({ text: "stale block" });
        return { text: "stale final" };
      },
    });
    try {
      await entered.promise;
      if (!predecessor) {
        throw new Error("missing predecessor owner");
      }
      runAfterReplyOperationClear(predecessor, () => {
        nextDispatch = dispatchReplyFromConfig({
          ctx: buildTestCtx({
            Provider: "discord",
            Surface: "discord",
            SessionKey: sessionKey,
            MessageSid: "next-turn",
          }),
          cfg: emptyConfig,
          dispatcher: nextDispatcher,
          replyResolver: async (_ctx, opts) => {
            successor = opts?.replyOperation;
            return { text: "successor answer" };
          },
        });
        void nextDispatch.then(() => successorFinished.resolve(), successorFinished.reject);
      });
      predecessor.supersede();
      releaseOld.resolve();
      await oldDispatch;
      await deliveryStarted.promise;
      expect(predecessor.result).toMatchObject({
        kind: "aborted",
        code: "aborted_for_supersession",
      });
      expect(delivered).toEqual([]);
      if (!successor) {
        throw new Error("missing successor owner");
      }
      const settled = vi.fn();
      void successor.ownerSettlement?.then(settled);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      releaseDelivery.resolve();
      await successorFinished.promise;
      nextDispatcher.markComplete();
      const receipt = await nextDispatcher.waitForIdle();
      await successor.ownerSettlement;
      expect(receipt?.counts.final.delivered).toBe(1);
      expect(delivered).toEqual(["successor answer"]);
      expect(settled).toHaveBeenCalledOnce();
      expect(listActiveReplyRunSessionKeys()).toEqual([]);
    } finally {
      releaseOld.resolve();
      releaseDelivery.resolve();
      oldDispatcher.markComplete();
      nextDispatcher.markComplete();
      await Promise.allSettled([oldDispatch, nextDispatch]);
      await oldDispatcher.waitForIdle();
      await nextDispatcher.waitForIdle();
      await predecessor?.ownerSettlement;
      await successor?.ownerSettlement;
    }
  });

  it("holds an owned lifecycle lease until abort-insensitive resolver work settles", async () => {
    setNoAbort();
    const sessionKey = "agent:main:discord:channel:owned-resolver-race";
    const sessionId = "owned-resolver-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const resolverGate = createDeferred();
    const resolverEntered = createDeferred();
    type ResolverOptions = import("./get-reply.types.js").InternalGetReplyOptions;
    let operation: ResolverOptions["replyOperation"];
    let resumedResolverOwner: ResolverOptions["replyOperation"];
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: ResolverOptions) => {
      operation = opts?.replyOperation;
      resolverEntered.resolve();
      await resolverGate.promise;
      resumedResolverOwner = getSessionControllerOperation(sessionKey);

      await requireBlockReplyHandler(opts?.onBlockReply)({ text: "stale late block" });
      return { text: "stale late final" } satisfies ReplyPayload;
    });
    const dispatch = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        To: "discord:channel:owned-resolver-race",
        AccountId: "default",
        SessionKey: sessionKey,
        Body: "hold this resolver",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    await resolverEntered.promise;

    const externalLifecycleRequest = new AsyncResource("external-owned-resolver-lifecycle");
    let mutationRan = false;
    const mutation = externalLifecycleRequest.runInAsyncScope(
      async () =>
        await runSessionMutation({
          scope: "/tmp/mock-sessions.json",
          identities: [sessionKey, sessionId],
          prepare: async () => {
            await interruptSessionControllerEffects({
              scope: "/tmp/mock-sessions.json",
              identities: [sessionKey, sessionId],
            });
          },
          run: async () => {
            mutationRan = true;
          },
        }),
    );

    try {
      expect(operation).toBeDefined();
      const result = await dispatch;
      expect(result.queuedFinal).toBe(false);
      expect(getSessionControllerOperation(sessionKey)).toBe(operation);
      expect(operation?.abortSignal.aborted).toBe(true);
      expect(mutationRan).toBe(false);
      expect(
        isSessionControllerWorkActive("/tmp/mock-sessions.json", [sessionKey, sessionId]),
      ).toBe(true);

      resolverGate.resolve();
      await mutation;

      expect(resumedResolverOwner).toBe(operation);
      expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
      expect(mutationRan).toBe(true);
      expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    } finally {
      resolverGate.resolve();
      await mutation;
      externalLifecycleRequest.emitDestroy();
    }
  });

  it.each(["deletion", "upstream cancellation"] as const)(
    "holds queued session-event resolver work through %s",
    async (stop) => {
      setNoAbort();
      const sessionKey = "agent:main:discord:channel:event-resolver-race";
      const sessionId = "event-resolver-session";
      const upstreamAbort = new AbortController();
      const storePath = "/tmp/mock-sessions.json";
      sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
      const predecessor = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
      const resolverEntered = createDeferred();
      const resolverGate = createDeferred();
      const mutationPrepared = createDeferred();
      const dispatcher = createDispatcher();
      const externalLifecycleRequest = new AsyncResource("external-event-resolver-lifecycle");
      let resolverFinished = false;
      let resolverSignal: AbortSignal | undefined;
      let mutationRan = false;
      let mutationObservedSettledResolver = false;
      let mutation: Promise<void> | undefined;
      const dispatch = dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "discord",
          Surface: "discord",
          To: "discord:channel:event-resolver-race",
          AccountId: "default",
          SessionKey: sessionKey,
          InternalTurnSource: "event",
          Body: "the background process completed",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyOptions: {
          abortSignal: upstreamAbort.signal,
          queueModeOverride: "followup",
          turnAdoptionLifecycle: { admission: "exclusive", onAdopted() {} },
          internalEventExecution: { onStarted() {}, onTerminal() {} },
        },
        replyResolver: async (_ctx, opts) => {
          resolverSignal = opts?.abortSignal;
          resolverEntered.resolve();
          await resolverGate.promise;
          resolverFinished = true;
          return { text: "stale late event reply" };
        },
      });
      try {
        await resolverEntered.promise;
        predecessor.complete();
        // Queued preparation owns cleanup without projecting as an executing turn.
        const sourceSettlement = captureSessionControllerSettlement({
          scope: storePath,
          identities: [sessionKey, sessionId],
        });
        expect(sourceSettlement).toBeDefined();
        const sourceSettled = vi.fn();
        void sourceSettlement?.then(sourceSettled, sourceSettled);
        await Promise.resolve();
        expect(sourceSettled).not.toHaveBeenCalled();
        if (stop === "upstream cancellation") {
          upstreamAbort.abort();
          expect(resolverSignal?.aborted).toBe(true);
        }
        mutation = externalLifecycleRequest.runInAsyncScope(() =>
          runSessionMutation({
            scope: storePath,
            identities: [sessionKey, sessionId],
            kind: "delete",
            policy: "preempt",
            preempt: { activeRun: "abort", waitingInputs: "cancel" },
            prepare: async () => {
              mutationPrepared.resolve();
            },
            run: async () => {
              mutationRan = true;
              mutationObservedSettledResolver = resolverFinished;
            },
          }),
        );
        await mutationPrepared.promise;
        await vi.waitFor(() => expect(resolverSignal?.aborted).toBe(true));
        expect(mutationRan).toBe(false);
        expect(sourceSettled).not.toHaveBeenCalled();
        resolverGate.resolve();
        await mutation;
        const result = await dispatch;
        await sourceSettlement;
        expect(sourceSettled).toHaveBeenCalledOnce();
        expect(mutationObservedSettledResolver).toBe(true);
        expect(result.queuedFinal).toBe(false);
        expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
        expect(isSessionControllerWorkActive(storePath, [sessionKey, sessionId])).toBe(false);
      } finally {
        predecessor.complete();
        resolverGate.resolve();
        await Promise.allSettled([dispatch, mutation]);
        externalLifecycleRequest.emitDestroy();
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
        type ResolverOptions = import("./get-reply.types.js").InternalGetReplyOptions;
        let retained: ResolverOptions | undefined;
        const release = createDeferred();
        const entered = createDeferred();
        const secondEntered = createDeferred();
        const releaseSecond = createDeferred();
        const resolverEntered = createDeferred();
        const returnResolver = createDeferred();
        const failure = new Error("queued transport failed");
        const onError = vi.fn();
        const onQueuedFollowupSettled = vi.fn();
        const abortController = new AbortController();
        let progress: Promise<unknown> | undefined;
        const dispatcher = createReplyDispatcher({
          humanDelay: { mode: "custom", minMs: 1, maxMs: 1 },
          beforeDeliver: async (payload) => {
            if (
              phase === "cancelled block and tool-only reply" &&
              payload.text === "initial reply"
            ) {
              return null;
            }
            return payload;
          },
          deliver: async (payload) => {
            if (payload.text === "second queued reply") {
              secondEntered.resolve();
              await releaseSecond.promise;
            }
            if (payload.text === "queued reply") {
              entered.resolve();
              await release.promise;
              if (phase === "transport failure") {
                throw failure;
              }
            }
          },
          onError,
        });
        const dispatch = dispatchReplyFromConfig({
          ctx: createHookCtx(),
          cfg: emptyConfig,
          dispatcher,
          replyOptions: { onQueuedFollowupSettled, abortSignal: abortController.signal },
          replyResolver: async (_ctx, opts) => {
            retained = opts;
            await opts?.onBlockReply?.({ text: "initial reply" });
            if (phase === "cancelled block and tool-only reply") {
              const runState = resolveReplyOperationRunState(opts);
              if (!runState) {
                throw new Error("expected reply operation run state");
              }
              runState.replyCompletion = resolveReplyCompletion(
                runState.replyCompletion?.expectation ?? "required",
                "blocked",
              );
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
          if (phase === "cancelled block and tool-only reply") {
            dispatcher.sendToolResult({ text: "queued reply" });
          } else {
            await retained?.onBlockReply?.({ text: "queued reply" });
          }
          await entered.promise;
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
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          const cleanedUpBeforeDelivery = onQueuedFollowupSettled.mock.calls.length;
          release.resolve();
          returnResolver.resolve();
          if (phase === "subsequent block") {
            await secondEntered.promise;
            expect(onQueuedFollowupSettled).not.toHaveBeenCalled();
          }
          releaseSecond.resolve();
          await cleanup;
          await progress;
          await dispatch;
          const receipt = await dispatcher.waitForIdle();
          const noPendingBlock = phase === "cancelled block and tool-only reply";
          expect(cleanedUpBeforeDelivery).toBe(noPendingBlock ? 1 : 0);
          expect(onQueuedFollowupSettled).toHaveBeenCalledOnce();
          expect(receipt?.counts.block.delivered).toBe(
            phase === "cancelled block and tool-only reply"
              ? 0
              : noPendingBlock || phase === "transport failure"
                ? 1
                : phase === "subsequent block"
                  ? 3
                  : 2,
          );
          expect(receipt?.counts.block.failedAfterSend).toBe(phase === "transport failure" ? 1 : 0);
          if (phase === "transport failure") {
            expect(onError).toHaveBeenCalledExactlyOnceWith(failure, { kind: "block" });
          } else {
            expect(onError).not.toHaveBeenCalled();
          }
        } finally {
          release.resolve();
          releaseSecond.resolve();
          returnResolver.resolve();
          dispatcher.markComplete();
          await dispatcher.waitForIdle();
          await progress;
          await dispatch;
        }
      },
    );

    it.each([
      { phase: "rejected delivery and cleanup", deliveryFails: true, cleanupFails: true },
      { phase: "rejected cleanup", deliveryFails: false, cleanupFails: true },
    ])(
      "runs queued cleanup after $phase and preserves the first failure",
      async ({ deliveryFails, cleanupFails }) => {
        type ResolverOptions = import("./get-reply.types.js").InternalGetReplyOptions;
        let retained: ResolverOptions | undefined;
        const entered = createDeferred();
        const release = createDeferred();
        const deliveryFailure = new PlatformMessageNotDispatchedError("offline before dispatch", {
          cause: new Error("offline"),
        });
        const cleanupFailure = new Error("queued cleanup failed");
        const onError = vi.fn();
        const onQueuedFollowupSettled = vi.fn(async () => {
          if (cleanupFails) {
            throw cleanupFailure;
          }
        });
        const dispatcher = createReplyDispatcher({
          propagateRetryableNoSendFailure: true,
          deliver: async () => {
            entered.resolve();
            await release.promise;
            if (deliveryFails) {
              throw deliveryFailure;
            }
          },
          onError,
        });
        try {
          await dispatchReplyFromConfig({
            ctx: createHookCtx(),
            cfg: emptyConfig,
            dispatcher,
            replyOptions: { onQueuedFollowupSettled },
            replyResolver: async (_ctx, opts) => {
              retained = opts;
              const runState = resolveReplyOperationRunState(opts);
              if (!runState) {
                throw new Error("expected reply operation run state");
              }
              runState.replyCompletion = resolveReplyCompletion(
                runState.replyCompletion?.expectation ?? "required",
                "blocked",
              );
              return undefined;
            },
          });
          dispatcher.markComplete();
          await dispatcher.waitForIdle();
          await retained?.onBlockReply?.({ text: "queued reply" });
          await entered.promise;
          const cleanup = Promise.resolve(retained?.onQueuedFollowupSettled?.()).catch(
            (error: unknown) => error,
          );
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(onQueuedFollowupSettled).not.toHaveBeenCalled();
          release.resolve();

          expect(await cleanup).toBe(deliveryFails ? deliveryFailure : cleanupFailure);
          expect(onQueuedFollowupSettled).toHaveBeenCalledOnce();
          if (deliveryFails) {
            expect(onError).toHaveBeenCalledExactlyOnceWith(deliveryFailure, { kind: "block" });
            await expect(dispatcher.waitForIdle()).rejects.toBe(deliveryFailure);
          } else {
            expect(onError).not.toHaveBeenCalled();
            expect((await dispatcher.waitForIdle())?.counts.block.delivered).toBe(1);
          }
        } finally {
          release.resolve();
          dispatcher.markComplete();
          await dispatcher.waitForIdle().catch(() => undefined);
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
        const releaseDelivery = createDeferred();
        const deliveryEntered = createDeferred();
        const followupEntered = createDeferred();
        let receiptCallbackWork: Promise<void> | undefined;
        const dispatcher = createReplyDispatcher({
          deliver: async (_payload, info) => {
            if (holdReceiptCallback) {
              deliveryOrder.push(`${info.kind}-delivered`);
              return;
            }
            deliveryOrder.push("final-start");
            deliveryEntered.resolve();
            await releaseDelivery.promise;
            deliveryOrder.push("final-end");
          },
        });
        let operation: ReturnType<typeof createReplyOperation> | undefined;
        let queuedOperation: ReturnType<typeof createReplyOperation> | undefined;
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
        const dispatchPromise = dispatchReplyFromConfig({
          ctx: createHookCtx(),
          cfg: emptyConfig,
          dispatcher,
          replyOptions: {
            abortSignal: abortController.signal,
            onBlockReplyQueued: holdReceiptCallback
              ? () => {
                  deliveryOrder.push("callback-start");
                  deliveryEntered.resolve();
                  receiptCallbackWork = releaseDelivery.promise.then(() => {
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
          await deliveryEntered.promise;
          expect(deliveryOrder).toEqual(heldOrder);
          const result = await dispatchPromise;

          expect(operation).toBeDefined();
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

          releaseDelivery.resolve();
          await dispatcher.waitForIdle();
          await followupEntered.promise;
          expect(queuedOperation).toBeDefined();

          expect(deliveryOrder).toEqual(completedOrder);
          expect(getSessionControllerOperation("agent:test:session")).toBe(queuedOperation);
        } finally {
          releaseDelivery.resolve();
          dispatcher.markComplete();
          await Promise.allSettled([dispatchPromise, receiptCallbackWork]);
          await dispatcher.waitForIdle();
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
