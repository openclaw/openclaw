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
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import type { OutboundPayloadPlan } from "../../infra/outbound/reply-payload-parts.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { outboundMessageIdentities } from "../message/outbound-echo-state.js";
import {
  readAgentRunTerminalOutcome,
  recordAgentRunTerminalOutcome,
} from "./agent-run-terminal-outcome.js";
import { hasVisibleChannelTurnDispatchFromReceipt as hasVisibleChannelTurnDispatch } from "./dispatch-result.js";
import { dispatchAssembledChannelTurn, dispatchRoutedChannelTurn } from "./lifecycle.js";
import {
  createCtx,
  createDispatch,
  createDispatcherBackedDispatch,
  createDurableSendResult,
  createRecordInboundSession,
  createReplyDispatchReceipt,
  createDeliveryResultCapture,
  type DurableSendRequest,
  type DurableSupportRequest,
  expectDispatched,
  expectNonVisibleFinalReceipt,
} from "./run-channel-turn.delivery.test-helpers.js";
import type { ChannelDeliveryInfo, ChannelTurnDeliveryAdapter, ChannelTurnPlan } from "./types.js";

const settlePendingFinalDelivery = vi.hoisted(() =>
  vi.fn(async (_completion: unknown, state: string) => ({ state })),
);

vi.mock("../../infra/outbound/delivery-completion.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/outbound/delivery-completion.js")>();
  return { ...actual, settlePendingFinalDelivery };
});

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

function runAssembled(
  overrides: Partial<
    Omit<
      Parameters<typeof dispatchAssembledChannelTurn>[0],
      "cfg" | "agentId" | "storePath" | "recordInboundSession"
    >
  >,
) {
  return dispatchAssembledChannelTurn({
    cfg: {},
    agentId: "main",
    storePath,
    recordInboundSession: createRecordInboundSession(),
    channel: "telegram",
    accountId: "acct",
    routeSessionKey: "agent:main:telegram:peer",
    ctxPayload: createCtx({ To: "123", OriginatingTo: "123" }),
    dispatchReplyWithBufferedBlockDispatcher: createDispatch(),
    delivery: { deliver: vi.fn(), durable: { replyToMode: "first" } },
    ...overrides,
  });
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
    vi.clearAllMocks();
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementation(createDispatch());
    outboundMessageIdentities.clear();
    resetDiagnosticEventsForTest();
    resetLogger();
    setLoggerOverride({ level: "info" });
    resolveOutboundDurableFinalDeliverySupport.mockResolvedValue({ ok: true });
    createMessageSentEmitter.mockImplementation(() => ({
      emitMessageSent,
      hasMessageSentHooks: true,
    }));
    getGlobalHookRunner.mockReturnValue(null);
  });
  afterEach(() => {
    setLoggerOverride(null);
    resetLogger();
  });

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
      await params.dispatcherOptions.deliverPrepared(
        { ...plan, sourceIndex: 7 },
        { kind: "final" },
      );
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });
    const runMessageSending = vi.fn(async ({ content }: { content: string }) => ({
      content: content + " + hook",
    }));
    getGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "message_sending",
      runMessageSending,
    });
    const entered = createDeferred();
    const pending = createDeferred();
    settlePendingFinalDelivery.mockImplementationOnce(async (_completion, state: string) => {
      order.push(state);
      return { state };
    });
    const deliver = vi.fn(async (payload: ReplyPayload, info: ChannelDeliveryInfo) => {
      expect(getReplyPayloadMetadata(payload)?.pendingFinalDeliveryCompletion).toEqual(completion);
      expect("onPlatformSendDispatch" in info).toBe(false);
      order.push("accepted");
      entered.resolve();
      await pending.promise;
      return { messageIds: ["direct-1"], visibleReplySent: true };
    });
    const deliverPrepared = vi.fn((plan: OutboundPayloadPlan, info: ChannelDeliveryInfo) => {
      expect(plan.sourceIndex).toBe(7);
      expect(plan.parts.text).toBe("reply [[reply_to:literal]] + prepared + hook");
      expect(plan.payload.replyToId).toBeUndefined();
      return deliver(plan.payload, info);
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
    expect(deliver).toHaveBeenCalledOnce();
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
    expect(settlePendingFinalDelivery).toHaveBeenNthCalledWith(
      1,
      { kind: "pending-final", ...completion },
      "unknown",
      ["prepared", "queued"],
    );
    expect(settlePendingFinalDelivery).toHaveBeenNthCalledWith(
      2,
      { kind: "pending-final", ...completion },
      "delivered",
    );
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
    const runMessageSending = vi.fn(async () => ({ content: "resurrected" }));
    getGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "message_sending",
      runMessageSending,
    });
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
    expect(onDelivered).toHaveBeenCalledWith(
      { text: "reply" },
      { kind: "final" },
      {
        visibleReplySent: false,
        suppression: { reason: "no_visible_payload" },
      },
    );
    expectDispatched(result);
    expectNonVisibleFinalReceipt(result.dispatchResult);
  });

  it("preserves visible siblings and failure outcomes when hooks cancel a media-only final", async () => {
    const runMessageSending = vi.fn(async ({ content }: { content: string }) =>
      content ? undefined : { cancel: true, cancelReason: "policy", metadata: { source: "test" } },
    );
    getGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "message_sending",
      runMessageSending,
    });
    const payload = { mediaUrls: ["media://only"] };
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(async (params) => {
      await params.dispatcherOptions.deliver({ text: "deliver me" }, { kind: "block" });
      await params.dispatcherOptions.deliver(payload, { kind: "final" });
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
    expect(onDelivered).toHaveBeenCalledWith(
      payload,
      { kind: "final" },
      {
        visibleReplySent: false,
        suppression: {
          reason: "cancelled_by_message_sending_hook",
          cancelReason: "policy",
          metadata: { source: "test" },
        },
      },
    );
    expect(emitMessageSent).toHaveBeenCalledOnce();
    expectDispatched(result);
    expect(hasVisibleChannelTurnDispatch(result.dispatchResult)).toBe(true);
    expect(result.dispatchResult.settledReceipt?.counts.final.deliveredNotVisible).toBe(1);
    expect(readAgentRunTerminalOutcome(result.dispatchResult)).toBe("failed");
  });

  it("maps durable hook cancellation to typed routed suppression", async () => {
    sendDurableMessageBatch.mockResolvedValueOnce({
      status: "suppressed",
      results: [],
      receipt: { platformMessageIds: [], parts: [], sentAt: 1 },
      reason: "cancelled_by_message_sending_hook",
      payloadOutcomes: [
        {
          index: 0,
          status: "suppressed",
          reason: "cancelled_by_message_sending_hook",
          hookEffect: { cancelReason: "policy", metadata: { source: "test" } },
        },
      ],
    });
    const onDelivered = vi.fn();
    const result = await runRouted(
      { deliver: vi.fn(), durable: { replyToMode: "first" }, onDelivered },
      { To: "chat-1" },
    );
    expect(onDelivered).toHaveBeenCalledWith(
      { text: "reply" },
      { kind: "final" },
      expect.objectContaining({
        visibleReplySent: false,
        suppression: {
          reason: "cancelled_by_message_sending_hook",
          cancelReason: "policy",
          metadata: { source: "test" },
        },
      }),
    );
    expectDispatched(result);
    expectNonVisibleFinalReceipt(result.dispatchResult);
  });

  it("keeps no-identity durable sends pending through lifecycle settlement", async () => {
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(
      createDispatcherBackedDispatch(() => {}),
    );
    sendDurableMessageBatch.mockResolvedValueOnce({
      status: "suppressed",
      results: [],
      receipt: { platformMessageIds: [], parts: [], sentAt: 1 },
      reason: "adapter_returned_no_identity",
    });
    const onDelivered = vi.fn();
    const result = await runRouted(
      { deliver: vi.fn(), durable: { replyToMode: "first" }, onDelivered },
      { To: "chat-1" },
    );
    expect(onDelivered).not.toHaveBeenCalled();
    expectDispatched(result);
    expect(result.dispatchResult.settledReceipt?.hasPendingDelivery).toBe(true);
    expectNonVisibleFinalReceipt(result.dispatchResult);
    expect(hasVisibleChannelTurnDispatch(result.dispatchResult)).toBe(false);
  });

  it("prepares durable payloads while leaving hooks and visible delivery with the durable owner", async () => {
    sendDurableMessageBatch.mockResolvedValueOnce(createDurableSendResult(["tlon-1"]));
    const onDelivered = vi.fn(),
      deliver = vi.fn(),
      runMessageSending = vi.fn();
    getGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "message_sending",
      runMessageSending,
    });
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
      { kind: "final" },
      expect.objectContaining({ visibleReplySent: true }),
    );
    expect(emitMessageSent).not.toHaveBeenCalled();
  });

  it("falls back to direct hooks before queueing when durable delivery is unsupported", async () => {
    resolveOutboundDurableFinalDeliverySupport.mockResolvedValueOnce({
      ok: false,
      reason: "missing_outbound_handler",
    });
    const runMessageSending = vi.fn(async ({ content }: { content: string }) => ({
      content: content + " + direct-hook",
    }));
    getGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "message_sending",
      runMessageSending,
    });
    const deliver = vi.fn(async () => ({ messageIds: ["legacy-1"], visibleReplySent: true }));
    await runRouted(
      { deliver, durable: { replyToMode: "first" } },
      { To: "chat-1", MessageThreadId: 777 },
    );
    expect(sendDurableMessageBatch).not.toHaveBeenCalled();
    expect(runMessageSending).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith({ text: "reply + direct-hook" }, { kind: "final" });
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
      status: "partial_failed",
      results: [{ channel: "telegram", messageId: "tg-1" }],
      receipt: {
        primaryPlatformMessageId: "tg-1",
        platformMessageIds: ["tg-1"],
        parts: [{ platformMessageId: "tg-1", kind: "text", index: 0 }],
        sentAt: 1,
      },
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
    emitMessageSent.mockImplementation((event) => {
      events.push("message_sent");
      return event;
    });
    const finalization = createDeferred<{
      content: string;
      messageIds: string[];
      visibleReplySent: true;
    }>();
    const dispatch = vi.fn<DispatchReplyWithBufferedBlockDispatcher>(async (params) => {
      expect(params.replyOptions?.onAgentRunStart?.("run-finalized", undefined, dispatchRun)).toBe(
        "reply-dispatch",
      );
      await params.dispatcherOptions.deliver({ text: "pre-final text" }, { kind: "final" });
      events.push("provider-finalized");
      finalization.resolve({
        content: "provider final text",
        messageIds: ["om-final"],
        visibleReplySent: true,
      });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
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
