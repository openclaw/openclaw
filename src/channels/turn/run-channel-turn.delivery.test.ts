// Preserve mock setup before modules that consume it.
// oxfmt-ignore
import { channelTurnMocks } from "./run-channel-turn.test-support.js";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ReplyDispatchRun } from "../../auto-reply/get-reply-options.types.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../../auto-reply/reply-payload.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import type { OutboundPayloadPlan } from "../../infra/outbound/reply-payload-parts.js";
import type { HookRunner } from "../../plugins/hooks.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import {
  readAgentRunTerminalOutcome,
  recordAgentRunTerminalOutcome,
} from "./agent-run-terminal-outcome.js";
import { hasVisibleChannelTurnDispatch } from "./dispatch-result.js";
import { dispatchAssembledChannelTurn, dispatchRoutedChannelTurn } from "./lifecycle.js";
import {
  createCtx,
  createDispatch,
  createDispatcherBackedDispatch,
  createDurableSendResult,
  createReplyDispatchReceipt,
  createDeliveryResultCapture,
  type DurableSendRequest,
  type DurableSupportRequest,
  expectDispatched,
  expectNonVisibleFinalReceipt,
} from "./run-channel-turn.delivery.test-helpers.js";
import {
  assembledTurn,
  finalDispatch,
  finalInfo,
  reply,
  resetTurnLogger,
  resetTurnState,
} from "./turn-state.test-support.js";
import type {
  AssembledChannelTurn,
  ChannelDeliveryInfo,
  ChannelTurnDeliveryAdapter,
  ChannelTurnPlan,
} from "./types.js";

const settlePendingFinalDelivery = vi.hoisted(() =>
  vi.fn(async (_completion: unknown, state: string) => ({ state })),
);

vi.mock("../../infra/outbound/delivery-completion.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/outbound/delivery-completion.js")>()),
  settlePendingFinalDelivery,
}));

const {
  resolveOutboundDurableFinalDeliverySupport,
  sendDurableMessageBatch,
  dispatchReplyWithRoutedChannelDispatcherCore,
  emitMessageSent,
  getGlobalHookRunner,
  createMessageSentEmitter,
} = channelTurnMocks;

const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-channel-turn-delivery-" });
let storePath: string;

function runAssembled(overrides: Partial<AssembledChannelTurn>) {
  return dispatchAssembledChannelTurn(
    assembledTurn(storePath, {
      channel: "telegram",
      accountId: "acct",
      ctxPayload: createCtx({ To: "123", OriginatingTo: "123" }),
      delivery: { deliver: vi.fn(), durable: { replyToMode: "first" } },
      ...overrides,
    }),
  );
}

function messageSending(handler: HookRunner["runMessageSending"] = async () => undefined) {
  const runMessageSending = vi.fn(handler);
  getGlobalHookRunner.mockReturnValue({
    hasHooks: (name: string) => name === "message_sending",
    runMessageSending,
  });
  return runMessageSending;
}

function runRouted(
  delivery: ChannelTurnDeliveryAdapter,
  ctx: Parameters<typeof createCtx>[0] = {},
  overrides: Partial<Pick<ChannelTurnPlan, "channel" | "accountId" | "route">> = {},
) {
  const channel = overrides.channel ?? "telegram";
  return dispatchRoutedChannelTurn({
    cfg: {},
    channel,
    route: { agentId: "main", sessionKey: `agent:main:${channel}:peer` },
    ctxPayload: createCtx({ Surface: channel, ...ctx }),
    delivery,
    ...overrides,
  });
}

describe("channel turn delivery", () => {
  beforeAll(() => tempDirs.setup());
  afterAll(() => tempDirs.cleanup());
  beforeEach(async () => {
    storePath = path.join(await tempDirs.make(), "sessions.json");
    resetTurnState();
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementation(createDispatch());
    resolveOutboundDurableFinalDeliverySupport.mockResolvedValue({ ok: true });
  });
  afterEach(resetTurnLogger);

  it("preserves prepared payload custody and literals through preparation and message hooks", async () => {
    const order: string[] = [];
    const completion = {
      deliveryId: "delivery-1",
      intentId: "intent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:peer",
      storePath,
    };
    const source = setReplyPayloadMetadata(
      { text: "reply [[reply_to:literal]]" },
      { pendingFinalDeliveryCompletion: completion },
    );
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(async (params) => {
      const [plan] = createStructuredOutboundPayloadPlan([source]);
      if (!plan || !params.dispatcherOptions.deliverPrepared) {
        throw new Error("expected prepared delivery");
      }
      await params.dispatcherOptions.deliverPrepared({ ...plan, sourceIndex: 7 }, finalInfo);
      return finalDispatch();
    });
    const runMessageSending = messageSending(async ({ content }) => ({
      content: content + " + hook",
    }));
    const entered = createDeferred();
    const pending = createDeferred();
    settlePendingFinalDelivery.mockImplementationOnce(async (_completion, state: string) => {
      order.push(state);
      return { state };
    });
    const deliver = vi.fn();
    const deliverPrepared = vi.fn(async (plan: OutboundPayloadPlan, info: ChannelDeliveryInfo) => {
      expect(getReplyPayloadMetadata(plan.payload)?.pendingFinalDeliveryCompletion).toEqual(
        completion,
      );
      expect("onPlatformSendDispatch" in info).toBe(false);
      expect(plan).toMatchObject({
        sourceIndex: 7,
        parts: { text: "reply [[reply_to:literal]] + prepared + hook" },
      });
      expect(plan.payload.replyToId).toBeUndefined();
      order.push("accepted");
      entered.resolve();
      await pending.promise;
      return { messageIds: ["direct-1"], visibleReplySent: true };
    });
    const turn = runRouted(
      {
        preparePayload: async (payload) => ({ ...payload, text: payload.text + " + prepared" }),
        deliver,
        deliverPrepared,
      },
      { OriginatingTo: "chat-1", ReplyToId: "source-1", MessageThreadId: 42 },
      { accountId: "acct" },
    );
    try {
      await Promise.race([entered.promise, turn]);
      expect(order).toEqual(["unknown", "accepted"]);
    } finally {
      pending.resolve();
      await turn;
    }
    expect(deliverPrepared).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(runMessageSending).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "reply [[reply_to:literal]] + prepared",
        replyToId: "source-1",
        threadId: 42,
      }),
      expect.objectContaining({
        channelId: "telegram",
        accountId: "acct",
        conversationId: "chat-1",
        sessionKey: completion.sessionKey,
      }),
    );
    const custody = { kind: "pending-final", ...completion };
    expect(settlePendingFinalDelivery.mock.calls).toEqual([
      [custody, "unknown", ["prepared", "queued"]],
      [custody, "delivered", undefined, undefined],
    ]);
  });

  it.each([
    { deferred: true, visibleReplySent: false },
    { deferred: false, visibleReplySent: true },
  ])(
    "keeps identityless provider completion pending ($deferred, $visibleReplySent)",
    async ({ deferred, visibleReplySent }) => {
      const completion = {
        deliveryId: "ambiguous-delivery",
        intentId: "ambiguous-intent",
        sessionId: "session-1",
        sessionKey: "agent:main:discord:peer",
        storePath,
      };
      dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(
        createDispatch(
          [],
          setReplyPayloadMetadata(
            { text: "reply" },
            { pendingFinalDeliveryCompletion: completion },
          ),
        ),
      );
      const onDelivered = vi.fn();
      const pending = {
        visibleReplySent,
        suppression: { reason: "adapter_returned_no_identity" as const },
      };
      await runRouted(
        {
          deliverWithProviderMessageSending: async (_payload, info) => {
            await info.onPlatformSendDispatch();
            return deferred ? { ...pending, finalization: Promise.resolve(pending) } : pending;
          },
          observeMessageSent: true,
          onDelivered,
        },
        { OriginatingTo: "channel:123" },
        { channel: "discord" },
      );
      expect(settlePendingFinalDelivery).toHaveBeenLastCalledWith(
        { kind: "pending-final", ...completion },
        "unknown",
        undefined,
        undefined,
      );
      expect(settlePendingFinalDelivery.mock.calls.map(([, state]) => state)).toEqual([
        "unknown",
        "unknown",
      ]);
      expect(onDelivered).not.toHaveBeenCalled();
      expect(emitMessageSent).not.toHaveBeenCalled();
    },
  );

  it("does not let message hooks resurrect payloads suppressed during preparation", async () => {
    const runMessageSending = messageSending(async () => ({ content: "resurrected" }));
    const durable = vi.fn(),
      deliver = vi.fn(),
      onDelivered = vi.fn();
    const result = await runRouted(
      { preparePayload: () => null, durable, deliver, onDelivered },
      { OriginatingTo: "chat-1" },
      { channel: "whatsapp" },
    );
    expect(runMessageSending).not.toHaveBeenCalled();
    expect(durable).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(onDelivered).toHaveBeenCalledWith(reply, finalInfo, {
      visibleReplySent: false,
      suppression: { reason: "no_visible_payload" },
    });
    expectDispatched(result);
    expectNonVisibleFinalReceipt(result.dispatchResult);
  });

  it("preserves visible siblings and failure outcomes when hooks cancel a media-only final", async () => {
    const runMessageSending = messageSending(async ({ content }) =>
      content ? undefined : { cancel: true, cancelReason: "policy", metadata: { source: "test" } },
    );
    const payload = { mediaUrls: ["media://only"] };
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(async (params) => {
      await params.dispatcherOptions.deliver({ text: "deliver me" }, { kind: "block" });
      await params.dispatcherOptions.deliver(payload, finalInfo);
      return recordAgentRunTerminalOutcome(
        {
          queuedFinal: true,
          counts: { tool: 0, block: 1, final: 1 },
          settledReceipt: createReplyDispatchReceipt({
            block: { delivered: 1 },
            final: { deliveredNotVisible: 1 },
          }),
        },
        "failed",
      );
    });
    const deliver = vi.fn(async () => ({ visibleReplySent: true })),
      onDelivered = vi.fn();
    const result = await runRouted(
      { deliver, onDelivered, observeMessageSent: true },
      { OriginatingTo: "chat-1" },
    );
    expect(runMessageSending).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "",
        metadata: expect.objectContaining({ mediaUrls: payload.mediaUrls }),
      }),
      expect.anything(),
    );
    expect(deliver).toHaveBeenCalledExactlyOnceWith({ text: "deliver me" }, { kind: "block" });
    expect(onDelivered).toHaveBeenCalledWith(payload, finalInfo, {
      visibleReplySent: false,
      suppression: {
        reason: "cancelled_by_message_sending_hook",
        cancelReason: "policy",
        metadata: { source: "test" },
      },
    });
    expect(emitMessageSent).toHaveBeenCalledOnce();
    expectDispatched(result);
    expect(hasVisibleChannelTurnDispatch(result.dispatchResult)).toBe(true);
    expect(result.dispatchResult.settledReceipt?.counts.final.deliveredNotVisible).toBe(1);
    expect(readAgentRunTerminalOutcome(result.dispatchResult)).toBe("failed");
  });

  it.each(["cancelled_by_message_sending_hook", "adapter_returned_no_identity"] as const)(
    "settles durable suppression without inventing identity: %s",
    async (reason) => {
      const cancelled = reason === "cancelled_by_message_sending_hook";
      const suppression = {
        reason,
        cancelReason: "policy",
        metadata: { source: "test" },
      } as const;
      sendDurableMessageBatch.mockResolvedValueOnce({
        status: "suppressed",
        results: [],
        receipt: { platformMessageIds: [], parts: [], sentAt: 1 },
        reason: suppression.reason,
        ...(cancelled
          ? {
              payloadOutcomes: [
                {
                  index: 0,
                  status: "suppressed",
                  reason: suppression.reason,
                  hookEffect: {
                    cancelReason: suppression.cancelReason,
                    metadata: suppression.metadata,
                  },
                },
              ],
            }
          : {}),
      });
      const onDelivered = vi.fn();
      const capture = createDeliveryResultCapture();
      dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(
        cancelled ? capture.dispatch : createDispatcherBackedDispatch(() => {}),
      );
      const result = await runRouted(
        { deliver: vi.fn(), durable: { replyToMode: "first" }, onDelivered },
        { To: "chat-1" },
      );
      expectDispatched(result);
      expectNonVisibleFinalReceipt(result.dispatchResult);
      if (cancelled) {
        const expected = {
          receipt: { platformMessageIds: [], parts: [], sentAt: 1 },
          visibleReplySent: false,
          suppression,
        };
        expect(capture.getResult()).toEqual(expected);
        expect(onDelivered).toHaveBeenCalledWith(reply, finalInfo, expected);
      } else {
        expect(onDelivered).not.toHaveBeenCalled();
        expect(result.dispatchResult.settledReceipt?.hasPendingDelivery).toBe(true);
        expect(hasVisibleChannelTurnDispatch(result.dispatchResult)).toBe(false);
      }
    },
  );

  it("prepares durable payloads while leaving hooks and visible delivery with the durable owner", async () => {
    sendDurableMessageBatch.mockResolvedValueOnce(createDurableSendResult(["tlon-1"]));
    const onDelivered = vi.fn(),
      deliver = vi.fn();
    const runMessageSending = messageSending();
    const capture = createDeliveryResultCapture();
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(capture.dispatch);
    await runRouted(
      {
        deliver,
        durable: (payload) => ({
          replyToMode: "first",
          requiredCapabilities: { text: payload.text?.includes("Generated") === true },
        }),
        preparePayload: (payload) => ({ ...payload, text: payload.text + " Generated" }),
        observeMessageSent: true,
        onDelivered,
      },
      {
        To: "chat/~nec/general",
        OriginatingTo: "chat/~nec/general",
        MessageThreadId: 777,
        ChatType: "group",
        SenderId: "sender-1",
      },
      { channel: "tlon", accountId: "acct" },
    );
    expect(deliver).not.toHaveBeenCalled();
    expect(runMessageSending).not.toHaveBeenCalled();
    const request: DurableSendRequest = {
      channel: "tlon",
      to: "chat/~nec/general",
      accountId: "acct",
      payloads: [{ text: "reply Generated" }],
      durability: "best_effort",
      replyToMode: "first",
      threadId: 777,
      session: expect.objectContaining({
        key: "agent:main:test:peer",
        agentId: "main",
        requesterAccountId: "acct",
        requesterSenderId: "sender-1",
        conversationType: "group",
        conversationKind: "group",
      }),
    };
    const support: DurableSupportRequest = { channel: "tlon", requirements: { text: true } };
    expect(sendDurableMessageBatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(request),
    );
    expect(resolveOutboundDurableFinalDeliverySupport).toHaveBeenCalledWith(
      expect.objectContaining(support),
    );
    expect(capture.getResult()).toMatchObject({ messageIds: ["tlon-1"], visibleReplySent: true });
    expect(onDelivered).toHaveBeenCalledExactlyOnceWith(
      { text: "reply Generated" },
      finalInfo,
      expect.objectContaining({ visibleReplySent: true }),
    );
    expect(emitMessageSent).not.toHaveBeenCalled();
  });

  it("falls back to direct hooks before queueing when durable delivery is unsupported", async () => {
    resolveOutboundDurableFinalDeliverySupport.mockResolvedValueOnce({
      ok: false,
      reason: "missing_outbound_handler",
    });
    const runMessageSending = messageSending(async ({ content }) => ({
      content: content + " + direct-hook",
    }));
    const deliver = vi.fn(async () => ({ messageIds: ["legacy-1"], visibleReplySent: true }));
    await runRouted(
      { deliver, durable: { replyToMode: "first" } },
      { To: "chat-1", MessageThreadId: 777 },
    );
    expect(sendDurableMessageBatch).not.toHaveBeenCalled();
    expect(runMessageSending).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith({ text: "reply + direct-hook" }, finalInfo);
  });

  it("treats durable support preflight failures as terminal", async () => {
    resolveOutboundDurableFinalDeliverySupport.mockRejectedValueOnce(new Error("preflight failed"));
    const deliver = vi.fn();
    await expect(
      runAssembled({ delivery: { deliver, durable: { replyToMode: "first" } } }),
    ).rejects.toThrow("preflight failed");
    expect(sendDurableMessageBatch).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("preserves durable partial-send visibility without retrying via direct delivery", async () => {
    sendDurableMessageBatch.mockResolvedValueOnce({
      ...createDurableSendResult(["tg-1"]),
      status: "partial_failed",
      error: new Error("second chunk failed"),
      sentBeforeError: true,
    });
    const deliver = vi.fn();
    await expect(
      runAssembled({ delivery: { deliver, durable: { replyToMode: "first" } } }),
    ).rejects.toMatchObject({ sentBeforeError: true, visibleReplySent: true });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("observes provider-finalized content and identity after deferred delivery settles", async () => {
    const events: string[] = [];
    const onAgentRunStart = vi.fn(() => "reply-dispatch");
    const dispatchRun: ReplyDispatchRun = {
      completionSource: "reply-dispatch",
      getResult: () => ({}),
    };
    emitMessageSent.mockImplementation(() => {
      events.push("message_sent");
    });
    const finalized = {
      content: "provider final text",
      messageIds: ["om-final"],
      visibleReplySent: true as const,
    };
    const finalization = createDeferred<typeof finalized>();
    const dispatch = vi.fn<DispatchReplyWithBufferedBlockDispatcher>(async (params) => {
      expect(params.replyOptions?.onAgentRunStart?.("run-finalized", undefined, dispatchRun)).toBe(
        "reply-dispatch",
      );
      await params.dispatcherOptions.deliver({ text: "pre-final text" }, finalInfo);
      events.push("provider-finalized");
      finalization.resolve(finalized);
      return finalDispatch();
    });
    await runAssembled({
      channel: "feishu",
      routeSessionKey: "agent:main:feishu:peer",
      ctxPayload: createCtx({ Surface: "feishu", Provider: "feishu", OriginatingTo: "oc_chat" }),
      dispatchReplyWithBufferedBlockDispatcher: dispatch,
      replyOptions: { onAgentRunStart },
      delivery: {
        deliver: async () => {
          events.push("deliver");
          return { visibleReplySent: false, finalization: finalization.promise };
        },
        observeMessageSent: true,
      },
    });
    expect(events).toEqual(["deliver", "provider-finalized", "message_sent"]);
    expect(onAgentRunStart).toHaveBeenCalledExactlyOnceWith(
      "run-finalized",
      undefined,
      dispatchRun,
    );
    expect(emitMessageSent).toHaveBeenCalledExactlyOnceWith({
      success: true,
      content: "provider final text",
      messageId: "om-final",
    });
    expect(createMessageSentEmitter).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "feishu",
        to: "oc_chat",
        runId: "run-finalized",
        sessionKeyForInternalHooks: "agent:main:feishu:peer",
      }),
    );
  });
});
