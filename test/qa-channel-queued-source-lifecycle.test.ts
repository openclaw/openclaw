import { randomUUID } from "node:crypto";
import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, expect, it, vi } from "vitest";
import {
  injectQaBusInboundMessage,
  pollQaBus,
  qaChannelPlugin,
} from "../extensions/qa-channel/api.js";
import { createQaBusState, startQaBusServer } from "../extensions/qa-lab/api.js";
import {
  admitFollowupRunLifecycle,
  enqueueFollowupRun,
  scheduleFollowupDrain,
} from "../src/auto-reply/reply/queue.js";
import {
  createQueueSettings,
  createQueueTestRun,
  installQueueRuntimeErrorSilencer,
} from "../src/auto-reply/reply/queue.test-helpers.js";
import {
  clearFollowupQueue,
  DEFAULT_QUEUE_DEBOUNCE_MS,
} from "../src/auto-reply/reply/queue/state.js";
import { isFollowupRunAborted, type FollowupRun } from "../src/auto-reply/reply/queue/types.js";
import { captureSessionControllerSourceSettlement } from "../src/sessions/session-controller.mailbox.js";
import { createDeferred, nextEventLoopTurn, withinTest } from "./helpers/promise.js";

installQueueRuntimeErrorSilencer();
afterEach(() => vi.restoreAllMocks());

it.for([
  { failure: "adoption", stopRequested: false, policy: "default" },
  { failure: "adoption", stopRequested: true, policy: "default" },
  { failure: "poll", stopRequested: false, policy: "default" },
  { failure: "deadline", stopRequested: false, policy: "default" },
  { failure: "adoption", stopRequested: false, policy: "immediate" },
] as const)(
  "settles real queued QA input after $failure failure ($policy debounce, stop requested=$stopRequested)",
  async ({ failure, stopRequested, policy }, { signal }) => {
    const key = `qa-ack-failure-${randomUUID()}`;
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    const controller = new AbortController();
    const runtime = createPluginRuntimeMock();
    const queued = createDeferred<FollowupRun>();
    const refused = createDeferred();
    const adoptionFailed = createDeferred();
    const ready = createDeferred();
    const pollStarted = createDeferred();
    const releasePoll = createDeferred();
    const pollFailed = createDeferred();
    const deadline = new AbortController();
    const effects: string[] = [];
    let dispatchQueued = false;
    let heldPoll = false;
    let failPoll = false;
    let adoptionAttempts = 0;
    const runFollowup = async (run: FollowupRun) => {
      if (isFollowupRunAborted(run)) {
        return;
      }
      try {
        await admitFollowupRunLifecycle(run);
      } catch (error) {
        adoptionFailed.resolve();
        throw error;
      }
      run.abortSignal?.throwIfAborted();
      effects.push(run.prompt);
    };
    // Inject only dispatch/effects. HTTP receipts, source adoption, retries and
    // terminal correlation cleanup use the real QA and queue owners.
    vi.mocked(runtime.channel.inbound.dispatch).mockImplementation(async (plan) => {
      const run = createQueueTestRun(
        {
          prompt: "queued QA input",
          messageId: plan.ctxPayload.MessageSid,
          originatingChannel: "qa-channel",
          originatingTo: plan.ctxPayload.From,
          turnAdoptionLifecycle: plan.turnAdoptionLifecycle,
          abortSignal: plan.turnAdoptionLifecycle?.abortSignal,
          deliveryCorrelations: plan.replyOptions?.queuedDeliveryCorrelations,
        },
        { sessionKey: key },
      );
      expect(
        enqueueFollowupRun(
          key,
          run,
          createQueueSettings({
            debounceMs: policy === "default" ? DEFAULT_QUEUE_DEBOUNCE_MS : 0,
          }),
          "message-id",
          runFollowup,
          false,
        ),
      ).toBe(true);
      dispatchQueued = true;
      queued.resolve(run);
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: plan.ctxPayload,
        routeSessionKey: plan.route.sessionKey,
        dispatchResult: {
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
          deferredToActiveRun: "followup",
        },
      };
    });
    const recordReceipts = state.recordPollReceipts.bind(state);
    vi.spyOn(state, "recordPollReceipts").mockImplementation((input) => {
      if (input?.adoptedEventCursors?.length) {
        adoptionAttempts++;
        refused.resolve();
        throw new Error("QA adoption receipt refused");
      }
      return recordReceipts(input);
    });
    const waitForCursorAdvance = state.waitForCursorAdvance;
    vi.spyOn(state, "waitForCursorAdvance").mockImplementation(async (...args) => {
      if (dispatchQueued && !stopRequested && !heldPoll) {
        heldPoll = true;
        pollStarted.resolve();
        await releasePoll.promise;
        return;
      }
      await waitForCursorAdvance(...args);
    });
    const poll = state.poll.bind(state);
    vi.spyOn(state, "poll").mockImplementation((input) => {
      if (failPoll && input?.timeoutMs) {
        pollFailed.resolve();
        throw new Error("QA poll refused");
      }
      return poll(input);
    });
    if (failure === "deadline") {
      const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
      // Keep the real node:http deadline error, with a controlled clock signal.
      vi.spyOn(AbortSignal, "timeout").mockImplementation((timeoutMs) =>
        timeoutMs === 10_010 ? deadline.signal : nativeTimeout(timeoutMs),
      );
    }
    const cfg = { channels: { "qa-channel": { baseUrl: bus.baseUrl, allowFrom: ["*"] } } };
    const startAccount = qaChannelPlugin.gateway?.startAccount;
    if (!startAccount) {
      throw new Error("expected QA account gateway");
    }
    const gateway = Promise.resolve(
      startAccount({
        ...createStartAccountContext({
          cfg,
          account: {
            ...qaChannelPlugin.config.resolveAccount(cfg, "default"),
            pollTimeoutMs: 10,
          },
          abortSignal: controller.signal,
          statusPatchSink: (status) => {
            if (status.lifecycle === "ready") {
              ready.resolve();
            }
          },
        }),
        channelRuntime: runtime.channel,
      }),
    );
    let stopped = false;
    const outcome = gateway.then(
      () => {
        stopped = true;
        return undefined;
      },
      (error: unknown) => {
        stopped = true;
        return error;
      },
    );
    try {
      await withinTest(ready.promise, signal);
      const { message } = await injectQaBusInboundMessage({
        baseUrl: bus.baseUrl,
        input: {
          conversation: { id: "qa-ack-failure", kind: "direct" },
          senderId: "qa-driver",
          text: "queued input",
        },
      });
      const run = await withinTest(queued.promise, signal);
      if (stopRequested) {
        controller.abort();
        await nextEventLoopTurn();
        expect(stopped).toBe(false);
      } else {
        await withinTest(pollStarted.promise, signal);
      }
      if (failure === "adoption") {
        scheduleFollowupDrain(key, runFollowup);
        await withinTest(refused.promise, signal);
        await withinTest(adoptionFailed.promise, signal);
      }
      if (failure === "deadline") {
        deadline.abort(new DOMException("QA poll deadline", "TimeoutError"));
      } else if (!stopRequested) {
        // The held main poll fails after adoption's exact error was captured.
        // It must neither replace that first failure nor keep its source alive.
        failPoll = true;
        releasePoll.resolve();
        await withinTest(pollFailed.promise, signal);
      }
      await vi.waitFor(() => expect(stopped).toBe(true));
      const settlement = withinTest(
        captureSessionControllerSourceSettlement(run.controllerInput!),
        signal,
      );
      if (failure === "adoption") {
        expect(await outcome).toEqual(new Error("QA adoption receipt refused"));
        expect(adoptionAttempts).toBe(1);
        await expect(settlement).rejects.toThrow("QA adoption receipt refused");
      } else {
        if (failure === "deadline") {
          expect(await outcome).toMatchObject({
            name: "AbortError",
            cause: { name: "TimeoutError", message: "QA poll deadline" },
          });
        } else {
          expect(await outcome).toEqual(new Error("QA poll refused"));
        }
        expect(adoptionAttempts).toBe(0);
        // Dormant cancellation settles custody without inventing an adoption failure.
        await expect(settlement).resolves.toBeUndefined();
      }
      expect(run.controllerInput?.phase).toBe("consumed");
      expect(effects).toEqual([]);
      expect(state.hasCompletedInboundEvent("default", 1)).toBe(false);
      const replay = await pollQaBus({
        baseUrl: bus.baseUrl,
        accountId: "default",
        cursor: 0,
        timeoutMs: 0,
      });
      expect(replay.events).toMatchObject([
        { kind: "inbound-message", message: { id: message.id } },
      ]);
    } finally {
      // Cleanup must not be what settles the source used by the assertions above.
      releasePoll.resolve();
      clearFollowupQueue(key);
      controller.abort();
      await outcome;
      await bus.stop();
    }
  },
);
