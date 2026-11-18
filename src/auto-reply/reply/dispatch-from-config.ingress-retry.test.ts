import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { consumeAcpTurnStream } from "../../acp/control-plane/manager.turn-stream.js";
import type { AcpRunTurnInput } from "../../acp/control-plane/manager.types.js";
import {
  bindIngressLifecycleToReplyOptions,
  type ChannelIngressDispatchLifecycle,
} from "../../channels/message/ingress-drain-lifecycle.js";
import { createChannelIngressDrain } from "../../channels/message/ingress-drain.js";
import {
  createTestIngressQueue,
  observeChannelIngressQueueWrite,
  withTempState,
} from "../../channels/message/ingress-drain.test-helpers.js";
import type { PluginHookReplyDispatchContext } from "../../plugins/hook-types.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import { testing as controllerTesting } from "../../sessions/session-controller.test-support.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import {
  acpManagerRuntimeMocks,
  acpMocks,
  createDispatcher,
  hookMocks,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticDirectReplyConfig,
  createAcpRuntime,
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
  tryDispatchAcpReplyHook,
} from "./dispatch-from-config.test-support.js";
import {
  withDispatchProcessedOutcomeSink,
  type DispatchProcessedNote,
} from "./dispatch-processed-outcome.js";
import { isFinalizedInboundContext } from "./inbound-context.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import {
  completeFollowupRunLifecycle,
  enqueueFollowupRun,
  scheduleFollowupDrain,
  type FollowupRun,
} from "./queue.js";
import { createQueueTestRun, rejectQueuePreparation } from "./queue.test-helpers.js";
import { clearSessionQueues } from "./queue/cleanup.js";
import { resetRecentQueuedMessageIdDedupe } from "./queue/recent-message-ids.test-support.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { buildTestCtx } from "./test-ctx.js";
import { createAcpSessionMeta } from "./test-fixtures/acp-runtime.js";

beforeAll(globalBeforeAll0);
beforeEach(() => {
  describe0BeforeEach0();
  setNoAbort();
  resetRecentQueuedMessageIdDedupe();
  vi.useFakeTimers();
});
afterEach(() => {
  controllerTesting.resetSessionControllerForTest();
  resetInboundDedupe();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("dispatch retry after queued ingress abandonment", () => {
  it.each([
    "watchdog-after-deferral",
    "abandon-before-dispatch-return",
    "replay-before-abandon",
    "custody-timeout-zero-floor",
    "custody-timeout-default",
    "signal-post-dispatch-failure",
    "runner-throws-before-adoption",
    "explicit-consumption",
  ] as const)("preserves ingress custody after %s", async (abandonment) => {
    await withTempState(async (stateDir) => {
      let clock = Date.now();
      const receivedAt = clock;
      const custodyTimeout = abandonment.startsWith("custody-timeout");
      const key = `agent:main:discord:direct:ingress-${abandonment}`;
      const messageId = `retry-${abandonment}`;
      const text = "Please deliver this queued message";
      const ctx = buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        ChatType: "direct",
        From: "user:ingress-fixture",
        To: "channel:ingress-fixture",
        SessionKey: key,
        MessageSid: messageId,
        BodyForAgent: text,
      });
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      const released = observeChannelIngressQueueWrite(queue, "release");
      const onDeadLetter = vi.fn();
      await queue.enqueue(messageId, { text }, { laneKey: key });
      let dispatcher = createDispatcher();
      const outcomes: Array<DispatchProcessedNote | undefined> = [];
      const lifecycles: ChannelIngressDispatchLifecycle[] = [];
      const preparationStarted = createDeferred();
      const releasePreparation = createDeferred();
      let sourceSettlement: Promise<unknown> | undefined;
      const finishAbortedFollowup = vi.fn(async (run: FollowupRun) => {
        if (abandonment === "runner-throws-before-adoption") {
          throw new Error("correlation begin failed");
        }
        if (abandonment === "replay-before-abandon" || custodyTimeout) {
          preparationStarted.resolve();
          await releasePreparation.promise;
          expect(run.abortSignal?.aborted).toBe(true);
          rejectQueuePreparation(run, new Error("cancelled preparation"));
        }
        expect(run.abortSignal?.aborted).toBe(true);
      });
      const enqueue = (
        run: FollowupRun,
        settings: Parameters<typeof enqueueFollowupRun>[2] = { mode: "followup", debounceMs: 0 },
      ) => {
        expect(
          enqueueFollowupRun(key, run, settings, "message-id", finishAbortedFollowup, false),
        ).toBe(true);
      };
      const resolver = vi.fn(async (_ctx: MsgContext, options?: GetReplyOptions) => {
        if (resolver.mock.calls.length > 1) {
          return { text: "Queued message delivered" };
        }
        const run = createQueueTestRun({
          prompt: text,
          messageId,
          originatingChannel: "discord",
          originatingTo: "channel:ingress-fixture",
        });
        run.run.agentId = "main";
        run.run.config = {
          session: { store: sessionStoreMocks.resolveSessionStorePathCore() },
        };
        run.turnAdoptionLifecycle = options?.turnAdoptionLifecycle;
        run.abortSignal = options?.turnAdoptionLifecycle?.abortSignal;
        let renewalFailed = false;
        const lifecycle = run.turnAdoptionLifecycle;
        const heartbeat = lifecycle?.onDeferredHeartbeat;
        if (lifecycle) {
          lifecycle.onDeferredHeartbeat = () => {
            if (renewalFailed) {
              throw new Error("deferred heartbeat owner failed");
            }
            heartbeat?.();
          };
        }
        enqueue(run, { mode: "followup", debounceMs: 0, cap: 10, dropPolicy: "summarize" });
        if (abandonment === "watchdog-after-deferral") {
          renewalFailed = true;
          enqueue(
            createQueueTestRun({
              prompt: "Healthy pending sibling",
              messageId: "healthy-sibling",
            }),
          );
        }
        const runState = resolveReplyOperationRunState(options);
        if (!runState) {
          throw new Error("dispatch did not bind its run state");
        }
        runState.admission = { status: "accepted", mode: "followup" };
        if (abandonment === "abandon-before-dispatch-return") {
          clearSessionQueues([key]);
        }
        return undefined;
      });
      const createDrain = () =>
        createChannelIngressDrain({
          queue,
          now: () => clock,
          adoptionStallTimeoutMs: 1_000,
          retryPolicy: {
            baseMs: 1_000,
            maxMs: 30_000,
            deadLetterMinAgeMs: abandonment === "custody-timeout-default" ? undefined : 0,
          },
          onDeadLetter,
          dispatchClaimedEvent: async (_event, lifecycle) => {
            lifecycles.push(lifecycle);
            dispatcher = createDispatcher();
            const { processedOutcome } = await withDispatchProcessedOutcomeSink(() =>
              dispatchReplyFromConfig({
                ctx,
                cfg: automaticDirectReplyConfig,
                dispatcher,
                replyOptions: bindIngressLifecycleToReplyOptions(lifecycle),
                replyResolver: resolver,
              }),
            );
            outcomes.push(processedOutcome);
            if (
              abandonment === "signal-post-dispatch-failure" &&
              resolver.mock.calls.length === 1
            ) {
              throw new Error("retryable post-dispatch no-send failure");
            }
          },
        });
      let drain = createDrain();
      try {
        await drain.drainOnce();
        await drain.waitForIdle();
        expect(resolver).toHaveBeenCalledOnce();
        expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
        if (abandonment === "explicit-consumption") {
          const source = getExistingFollowupQueue(key)?.items[0];
          if (!source?.controllerInput) {
            throw new Error("Expected the deferred source");
          }
          expect(source.controllerInput.custody.adopted).not.toBe(true);
          completeFollowupRunLifecycle(source, "consumed");
          await source.controllerInput.settlement.promise;
          drain.dispose();
          drain = createDrain();
          await drain.drainOnce();
          await drain.waitForIdle();
          expect(resolver).toHaveBeenCalledOnce();
          expect((await queue.enqueue(messageId, { text })).kind).toBe("completed");
          return;
        }
        if (
          abandonment === "replay-before-abandon" ||
          custodyTimeout ||
          abandonment === "signal-post-dispatch-failure"
        ) {
          sourceSettlement = getExistingFollowupQueue(key)?.entries[0]?.settlement.promise;
          expect(sourceSettlement).toBeDefined();
          if (abandonment === "replay-before-abandon" || custodyTimeout) {
            scheduleFollowupDrain(key, finishAbortedFollowup);
            await preparationStarted.promise;
            drain.dispose();
            drain = createDrain();
          }
          for (let attempt = 0; attempt < 9; attempt += 1) {
            clock += 30_000;
            expect(await drain.drainOnce()).toEqual({ started: 1 });
            await drain.waitForIdle();
            expect(await drain.drainOnce()).toEqual({ started: 0 });
          }
          expect(onDeadLetter).not.toHaveBeenCalled();
          expect(resolver).toHaveBeenCalledOnce();
          expect((await queue.enqueue(messageId, { text })).kind).not.toBe("completed");
          expect(await queue.listPending()).toMatchObject([
            {
              id: messageId,
              attempts: abandonment === "replay-before-abandon" || custodyTimeout ? 0 : 1,
            },
          ]);
          if (custodyTimeout) {
            clock += 30 * 60_000;
            for (let attempt = 1; attempt <= 8; attempt += 1) {
              expect(await drain.drainOnce()).toEqual({ started: 1 });
              await drain.waitForIdle();
              if (attempt < 8 || abandonment === "custody-timeout-default") {
                expect(await queue.listPending()).toMatchObject([
                  { id: messageId, attempts: attempt },
                ]);
                expect(onDeadLetter).not.toHaveBeenCalled();
              }
              clock += 30_000;
            }
            if (abandonment === "custody-timeout-default") {
              clock = receivedAt + 24 * 60 * 60_000;
              expect(await drain.drainOnce()).toEqual({ started: 1 });
              await drain.waitForIdle();
            }
            expect(onDeadLetter).toHaveBeenCalledOnce();
            expect(await queue.listFailed?.()).toMatchObject([
              { id: messageId, reason: "retry-limit-exceeded" },
            ]);
            expect(await queue.listPending()).toEqual([]);
            expect(resolver).toHaveBeenCalledOnce();
            expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
            return;
          }
          if (abandonment === "signal-post-dispatch-failure") {
            expect(lifecycles[0]?.abortSignal.aborted).toBe(false);
            clearSessionQueues([key]);
          }
          releasePreparation.resolve();
          await vi.advanceTimersByTimeAsync(250);
          await sourceSettlement;
        }
        if (abandonment === "runner-throws-before-adoption") {
          sourceSettlement = getExistingFollowupQueue(key)?.entries[0]?.settlement.promise;
          scheduleFollowupDrain(key, finishAbortedFollowup);
          await sourceSettlement;
          expect(await queue.listPending()).toMatchObject([{ id: messageId, attempts: 1 }]);
        }
        if (abandonment === "watchdog-after-deferral") {
          expect(await queue.listClaims()).toHaveLength(1);
          clock += 1_000;
          await vi.advanceTimersByTimeAsync(1_000);
          await drain.waitForIdle();
          expect(lifecycles[0]?.abortSignal.aborted).toBe(true);
        }
        await expect(released).resolves.toBe(true);
        expect(await queue.listPending()).toMatchObject([
          { id: messageId, attempts: abandonment === "replay-before-abandon" ? 0 : 1 },
        ]);
        clock += 30_000;
        expect(await drain.drainOnce()).toEqual({ started: 1 });
        await drain.waitForIdle();
        // The old bug tombstones this retry as a duplicate without invoking the resolver.
        expect(resolver).toHaveBeenCalledTimes(2);
        if (abandonment === "watchdog-after-deferral") {
          expect(finishAbortedFollowup).toHaveBeenCalledOnce();
          expect(getExistingFollowupQueue(key)?.items.map((run) => run.messageId)).toEqual([
            "healthy-sibling",
          ]);
        }
        expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
          text: "Queued message delivered",
        });
        expect(outcomes.at(-1)).toMatchObject({ outcome: "completed" });
        expect(await Promise.all([queue.listPending(), queue.listClaims()])).toEqual([[], []]);
        expect((await queue.enqueue(messageId, { text: "duplicate" })).kind).toBe("completed");

        const duplicateDispatcher = createDispatcher();
        const duplicate = await withDispatchProcessedOutcomeSink(() =>
          dispatchReplyFromConfig({
            ctx,
            cfg: automaticDirectReplyConfig,
            dispatcher: duplicateDispatcher,
            replyResolver: resolver,
          }),
        );
        expect(duplicate.processedOutcome).toEqual({ outcome: "skipped", reason: "duplicate" });
        expect(resolver).toHaveBeenCalledTimes(2);
        expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
        expect(duplicateDispatcher.sendFinalReply).not.toHaveBeenCalled();
      } finally {
        releasePreparation.resolve();
        clearSessionQueues([key]);
        if (sourceSettlement) {
          await vi.advanceTimersByTimeAsync(250);
        }
        await Promise.allSettled(sourceSettlement ? [sourceSettlement] : []);
        drain.dispose();
        clearSessionQueues([key]);
      }
    });
  });
});

it.each(["old", "new", "summarize"] as const)(
  "skips redelivery after an exclusive queue-cap %s drop",
  async (dropPolicy) => {
    await withTempState(async (stateDir) => {
      const key = `agent:main:discord:direct:cap-${dropPolicy}`;
      const messageId = `cap-${dropPolicy}`;
      const ctx = buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        ChatType: "direct",
        From: "user:ingress-fixture",
        To: "channel:ingress-fixture",
        SessionKey: key,
        MessageSid: messageId,
        BodyForAgent: "Queued source",
      });
      const queue = createTestIngressQueue(stateDir);
      const failed = observeChannelIngressQueueWrite(queue, "fail", messageId);
      const settings = { mode: "followup", debounceMs: 0, cap: 1, dropPolicy } as const;
      const addSibling = (index: number) =>
        enqueueFollowupRun(
          key,
          createQueueTestRun({ prompt: `Sibling ${index}`, messageId: `sibling-${index}` }),
          settings,
          "message-id",
          undefined,
          false,
        );
      if (dropPolicy === "new") {
        expect(addSibling(0)).toBe(true);
      }
      let source: FollowupRun | undefined;
      let lifecycle: ChannelIngressDispatchLifecycle | undefined;
      const dispatcher = createDispatcher();
      const resolver = vi.fn(async (_ctx: MsgContext, options?: GetReplyOptions) => {
        source = createQueueTestRun({ prompt: "Queued source", messageId });
        source.turnAdoptionLifecycle = options?.turnAdoptionLifecycle;
        expect(enqueueFollowupRun(key, source, settings, "message-id", undefined, false)).toBe(
          dropPolicy !== "new",
        );
        const runState = resolveReplyOperationRunState(options);
        if (!runState) {
          throw new Error("dispatch did not bind its run state");
        }
        runState.admission = {
          status: "accepted",
          mode: "followup",
        };
        return undefined;
      });
      const drain = createChannelIngressDrain({
        queue,
        dispatchClaimedEvent: async (_event, incoming) => {
          lifecycle = incoming;
          await dispatchReplyFromConfig({
            ctx,
            cfg: automaticDirectReplyConfig,
            dispatcher,
            replyOptions: bindIngressLifecycleToReplyOptions(incoming),
            replyResolver: resolver,
          });
        },
      });
      try {
        await queue.enqueue(messageId, { text: "Queued source" });
        await drain.drainOnce();
        await drain.waitForIdle();
        if (dropPolicy !== "new") {
          expect(addSibling(1)).toBe(true);
          if (dropPolicy === "summarize") {
            expect(addSibling(2)).toBe(true);
            expect(addSibling(3)).toBe(true);
          }
        }
        await expect(failed).resolves.toBe(true);
        if (!source?.controllerInput || !lifecycle) {
          throw new Error("dispatch did not retain the queued source and ingress lifecycle");
        }
        await source.controllerInput.settlement.promise;
        expect(await queue.listFailed?.()).toMatchObject([
          {
            id: messageId,
            attempts: 0,
            reason: dropPolicy === "new" ? "queue-cap-new" : "queue-cap-old",
          },
        ]);
        const duplicateDispatcher = createDispatcher();
        const duplicateReplyOptions = bindIngressLifecycleToReplyOptions(lifecycle);
        const duplicate = await withDispatchProcessedOutcomeSink(() =>
          dispatchReplyFromConfig({
            ctx,
            cfg: automaticDirectReplyConfig,
            dispatcher: duplicateDispatcher,
            replyOptions: duplicateReplyOptions,
            replyResolver: resolver,
          }),
        );
        expect(duplicate.processedOutcome).toEqual({ outcome: "skipped", reason: "duplicate" });
        expect(resolver).toHaveBeenCalledOnce();
        expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
        expect(duplicateDispatcher.sendFinalReply).not.toHaveBeenCalled();
      } finally {
        drain.dispose();
        clearSessionQueues([key]);
      }
    });
  },
);

it.each(["completed", "cancelled", "adoption-rejected", "non-finalized-context"] as const)(
  "holds ACP ingress custody through %s",
  async (outcome) => {
    await withTempState(async (stateDir) => {
      const sessionKey = "agent:main:acp:ingress";
      const cfg = {
        ...automaticDirectReplyConfig,
        acp: { enabled: true, dispatch: { enabled: true } },
      };
      const ctx = buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        ChatType: "direct",
        SessionKey: sessionKey,
        MessageSid: "long-acp-turn",
        BodyForAgent: "Complete the long task",
      });
      acpMocks.readAcpSessionEntry.mockReturnValue({ acp: createAcpSessionMeta() });
      const started = createDeferred();
      const release = createDeferred();
      const runtime = createAcpRuntime([]);
      runtime.runTurn.mockImplementation(async function* () {
        started.resolve();
        await release.promise;
        if (outcome !== "cancelled") {
          yield { type: "text_delta", text: "Long task completed." };
        }
        yield { type: "done", status: outcome === "cancelled" ? "cancelled" : "completed" };
      });
      const manager = acpManagerRuntimeMocks.getAcpSessionManager();
      const runTurn = vi.fn(async (input: AcpRunTurnInput) => {
        await consumeAcpTurnStream({
          runtime,
          turn: {
            ...input,
            handle: {
              sessionKey,
              backend: "acpx",
              runtimeSessionName: "runtime:ingress",
            },
          },
          eventGate: { open: true },
          onBeforePrompt: input.onBeforePrompt,
          onEvent: input.onEvent,
        });
      });
      acpManagerRuntimeMocks.getAcpSessionManager.mockReturnValue({ ...manager, runTurn });
      const builder = createTestPluginRegistry();
      const acpx = createPluginRecord({ id: "acpx", origin: "bundled" });
      const fallbackPlugin = createPluginRecord({ id: "fallback", origin: "bundled" });
      builder.registry.plugins.push(acpx, fallbackPlugin);
      builder.createApi(acpx, { config: cfg }).on(
        "reply_dispatch",
        (event, context) => {
          if (outcome === "non-finalized-context") {
            const copiedContext = { ...event.ctx };
            expect(isFinalizedInboundContext(copiedContext)).toBe(false);
            return tryDispatchAcpReplyHook({ ...event, ctx: copiedContext }, context);
          }
          return tryDispatchAcpReplyHook(event, context);
        },
        { priority: 10 },
      );
      const fallback = vi.fn(() => undefined);
      builder.createApi(fallbackPlugin, { config: cfg }).on("reply_dispatch", fallback);
      const hooks = createHookRunner(builder.registry);
      hookMocks.runner.runReplyDispatch.mockImplementation((event, context) =>
        hooks.runReplyDispatch(event, context as PluginHookReplyDispatchContext),
      );
      const queue = createTestIngressQueue(stateDir);
      const released = observeChannelIngressQueueWrite(queue, "release");
      await queue.enqueue("long-acp-turn", { text: "Complete the long task" });
      let dispatcher = createDispatcher();
      const controller = new AbortController();
      let dispatched = createDeferred();
      const rejected = new Error("Ingress adoption refused");
      let rejectAdoption = outcome === "adoption-rejected";
      const drain = createChannelIngressDrain({
        queue,
        retryPolicy: { baseMs: 1, maxMs: 1 },
        dispatchClaimedEvent: async (_event, lifecycle) => {
          const replyOptions = bindIngressLifecycleToReplyOptions(lifecycle);
          if (rejectAdoption) {
            replyOptions.turnAdoptionLifecycle.onAdopted = async () => {
              throw rejected;
            };
          }
          try {
            await dispatchReplyFromConfig({
              ctx,
              cfg,
              dispatcher,
              replyOptions: { ...replyOptions, abortSignal: controller.signal },
            });
          } finally {
            dispatched.resolve();
          }
        },
      });
      try {
        await drain.drainOnce();
        if (outcome === "adoption-rejected") {
          await dispatched.promise;
          await released;
          await drain.waitForIdle();
          expect(runtime.runTurn).not.toHaveBeenCalled();
          expect(fallback).not.toHaveBeenCalled();
          expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
          expect(await queue.listPending()).toMatchObject([{ id: "long-acp-turn", attempts: 1 }]);
          rejectAdoption = false;
          dispatcher = createDispatcher();
          dispatched = createDeferred();
          await vi.advanceTimersByTimeAsync(1);
          expect(await drain.drainOnce()).toEqual({ started: 1 });
          await started.promise;
          release.resolve();
          await dispatched.promise;
          await drain.waitForIdle();
        } else {
          await awaitGateBeforeSettlement(
            started.promise,
            dispatched.promise,
            "ACP dispatch ended before backend submission",
          );
          expect(await queue.listClaims()).toEqual([]);
          await vi.advanceTimersByTimeAsync(300_001);
          expect(runTurn.mock.calls[0]?.[0].signal?.aborted).not.toBe(true);
          expect(await drain.drainOnce()).toEqual({ started: 0 });
          if (outcome === "cancelled") {
            controller.abort();
          }
          release.resolve();
          await dispatched.promise;
        }
        await drain.waitForIdle();
        if (outcome !== "cancelled") {
          expect(dispatcher.sendFinalReply).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ text: "Long task completed." }),
          );
        } else {
          expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
        }
        expect(runtime.runTurn).toHaveBeenCalledOnce();
        expect(await queue.listPending()).toEqual([]);
        expect((await queue.enqueue("long-acp-turn", { text: "duplicate" })).kind).toBe(
          "completed",
        );
      } finally {
        release.resolve();
        drain.dispose();
        await drain.waitForIdle();
      }
    });
  },
);
