// Preserve mock setup before modules that consume it.
// oxfmt-ignore
import { channelTurnMocks } from "./run-channel-turn.test-support.js";
import { createServer } from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ReplyDispatchRun } from "../../auto-reply/get-reply-options.types.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { createBlockReplyCoalescer } from "../../auto-reply/reply/block-reply-coalescer.js";
import { resolveEffectiveBlockStreamingConfig } from "../../auto-reply/reply/block-streaming.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import type { OutboundPayloadPlan } from "../../infra/outbound/reply-payload-parts.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { createPluginRuntimeStore } from "../../plugin-sdk/runtime-store.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createRuntimeChannel } from "../../plugins/runtime/runtime-channel.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { outboundMessageIdentities } from "../message/outbound-echo-state.js";
import type { ChannelPlugin } from "../plugins/types.plugin.js";
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
const { mattermostPlugin } = await loadBundledPluginFacade<{ mattermostPlugin: ChannelPlugin }>({
  pluginId: "mattermost",
  artifactBasename: "channel-plugin-api.js",
});
let storePath: string;

function runAssembled(
  overrides: Partial<
    Omit<
      Parameters<typeof dispatchAssembledChannelTurn>[0],
      "agentId" | "storePath" | "recordInboundSession"
    >
  >,
  dispatch = dispatchAssembledChannelTurn,
) {
  return dispatch({
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

  it.each(["provider", "replacement", "fresh-blocks"] as const)(
    "posts tool progress through Mattermost HTTP in the original channel owner when %s queues the reply",
    async (sender) => {
      const registry = createEmptyPluginRegistry();
      const record = createPluginRecord({ id: "mattermost" });
      registry.plugins.push(record);
      const channel = new PluginInstance("mattermost", { record, registry });
      const provider = new PluginInstance(sender === "replacement" ? "mattermost" : "provider");
      const runtime = createPluginRuntimeStore<PluginRuntime>({
        pluginId: "mattermost",
        errorMessage: "Mattermost runtime not initialized",
      });
      const originalRuntime = createPluginRuntimeMock();
      const replacementRuntime = createPluginRuntimeMock();
      const requests: Array<{
        method: string | undefined;
        path: string | undefined;
        body: unknown;
      }> = [];
      const channelId = "cccccccccccccccccccccccccc";
      const postId = "pppppppppppppppppppppppppp";
      const server = await reserveTestPortListener({
        offsets: [0],
        createListener: () =>
          createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
              requests.push({
                method: request.method,
                path: request.url,
                body: JSON.parse(Buffer.concat(chunks).toString()),
              });
              response.writeHead(201, { "content-type": "application/json" });
              response.end(JSON.stringify({ id: postId, channel_id: channelId }));
            });
          }),
      });
      const cfg = {
        channels: {
          mattermost: {
            baseUrl: `http://127.0.0.1:${server.claim.port}`,
            botToken: "synthetic-channel-reply-owner",
            network: { dangerouslyAllowPrivateNetwork: true },
            streaming: {
              mode: "off" as const,
              block: { enabled: true, coalesce: { minChars: 1, idleMs: 300 } },
            },
          },
        },
      };
      const onError = vi.fn();
      channel.run(() => runtime.setRuntime(originalRuntime));
      if (sender === "replacement") {
        provider.run(() => runtime.setRuntime(replacementRuntime));
      }
      try {
        const sendText = mattermostPlugin.outbound?.sendText;
        if (!sendText) {
          throw new Error("Mattermost text transport is unavailable");
        }
        const acceptedPostIds: string[] = [];
        const turn = {
          cfg,
          agentId: "main",
          storePath,
          recordInboundSession: createRecordInboundSession(),
          channel: "mattermost",
          routeSessionKey: `agent:main:mattermost:channel:${channelId}`,
          ctxPayload: createCtx({
            Surface: "mattermost",
            To: channelId,
            OriginatingTo: channelId,
          }),
          delivery: {
            deliver: async (payload) => {
              const result = await sendText({
                cfg,
                to: `channel:${channelId}`,
                text: payload.text ?? "",
                accountId: "default",
              });
              acceptedPostIds.push(result.messageId);
              return {
                visibleReplySent: true,
                messageIds: [result.messageId],
                receipt: result.receipt,
              };
            },
            onError,
          },
          dispatchReplyWithBufferedBlockDispatcher: async (params) => {
            const dispatcher = createReplyDispatcher(params.dispatcherOptions);
            if (sender === "fresh-blocks") {
              const { coalescing } = resolveEffectiveBlockStreamingConfig({
                cfg,
                provider: "mattermost",
                accountId: "default",
              });
              expect(coalescing).toMatchObject({ minChars: 1, idleMs: 300 });
              if (!coalescing) {
                throw new Error("Mattermost block coalescing is unavailable");
              }
              const blocks = createBlockReplyCoalescer({
                config: coalescing,
                shouldAbort: () => false,
                onFlush: async (payload) => {
                  dispatcher.sendBlockReply(payload);
                },
              });
              try {
                for (const paragraph of [
                  "Checking the file.",
                  "Found the issue.",
                  "Applying the fix.",
                ]) {
                  await provider.run(async () => {
                    blocks.enqueue({ text: paragraph });
                    await blocks.flush({ force: false });
                    dispatcher.sendToolResult({ text: "tool progress" });
                    await dispatcher.waitForIdle();
                  });
                }
                expect(
                  requests.map((request) => (request.body as { message: string }).message),
                ).toEqual([
                  "Checking the file.",
                  "tool progress",
                  "Found the issue.",
                  "tool progress",
                  "Applying the fix.",
                  "tool progress",
                ]);
                provider.run(() => dispatcher.sendFinalReply({ text: "Finished." }));
              } finally {
                blocks.stop();
              }
            } else {
              provider.run(() => dispatcher.sendToolResult({ text: "tool progress" }));
            }
            dispatcher.markComplete();
            const settledReceipt = (await dispatcher.waitForIdle()) || undefined;
            return {
              queuedFinal: sender === "fresh-blocks",
              counts:
                sender === "fresh-blocks"
                  ? { tool: 3, block: 3, final: 1 }
                  : { tool: 1, block: 0, final: 0 },
              settledReceipt,
            };
          },
        } satisfies Parameters<typeof dispatchAssembledChannelTurn>[0];
        await channel.run(() =>
          createRuntimeChannel().inbound.run({
            channel: "mattermost",
            raw: { id: "fresh-message", text: "question" },
            adapter: {
              ingest: (raw) => ({ id: raw.id, rawText: raw.text, raw }),
              resolveTurn: () => turn,
            },
          }),
        );
        expect(onError).not.toHaveBeenCalled();
        expect(requests).toEqual(
          (sender === "fresh-blocks"
            ? [
                "Checking the file.",
                "tool progress",
                "Found the issue.",
                "tool progress",
                "Applying the fix.",
                "tool progress",
                "Finished.",
              ]
            : ["tool progress"]
          ).map((message) => ({
            method: "POST",
            path: "/api/v4/posts",
            body: { channel_id: channelId, message },
          })),
        );
        expect(acceptedPostIds).toEqual(requests.map(() => postId));
        expect(originalRuntime.channel.activity.record).toHaveBeenCalledTimes(requests.length);
        expect(replacementRuntime.channel.activity.record).not.toHaveBeenCalled();
      } finally {
        await channel.dispose();
        await provider.dispose();
        server.listener.closeAllConnections();
        await server.releaseListener();
        await server.claim.release();
      }
    },
  );

  it.each(["direct", "retained-facade"] as const)(
    "rejects stale delivery from %s",
    async (entry) => {
      const registry = createEmptyPluginRegistry();
      const record = createPluginRecord({ id: "mattermost" });
      registry.plugins.push(record);
      const channel = new PluginInstance("mattermost", { record, registry });
      const replacement = new PluginInstance("mattermost");
      const deliver = vi.fn(async () => {});
      let retainedDelivery:
        | Parameters<DispatchReplyWithBufferedBlockDispatcher>[0]["dispatcherOptions"]["deliver"]
        | undefined;
      try {
        await channel.run(() =>
          runAssembled(
            {
              delivery: { deliver },
              dispatchReplyWithBufferedBlockDispatcher: async (params) => {
                retainedDelivery = params.dispatcherOptions.deliver;
                return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
              },
            },
            entry === "direct"
              ? dispatchAssembledChannelTurn
              : createRuntimeChannel().inbound.dispatchReply,
          ),
        );
        if (!retainedDelivery) {
          throw new Error("delivery was not retained");
        }
        expect(channel.hasRetainedConsumers).toBe(false);
        if (entry === "retained-facade") {
          await expect(
            replacement.run(() => retainedDelivery!({ text: "late tool" }, { kind: "tool" })),
          ).rejects.toThrow("Plugin mattermost consumer is closed");
        }
        await channel.dispose();
        await expect(
          replacement.run(() => retainedDelivery!({ text: "late tool" }, { kind: "tool" })),
        ).rejects.toThrow(
          entry === "direct"
            ? "Plugin mattermost was reloaded or disabled"
            : "Plugin mattermost consumer is closed",
        );
        expect(deliver).not.toHaveBeenCalled();
      } finally {
        await channel.dispose();
        await replacement.dispose();
      }
    },
  );

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
