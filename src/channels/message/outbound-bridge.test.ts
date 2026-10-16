// Outbound bridge tests cover channel message handoff from core to outbound adapters.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createChannelMessageAdapterFromOutbound } from "./outbound-bridge.js";
import type {
  ChannelMessageSendPayloadContext,
  ChannelMessageSendPollContext,
  ChannelMessageSendTextContext,
  MessageReceipt,
} from "./types.js";

type OutboundBridgeAdapter = Parameters<
  typeof createChannelMessageAdapterFromOutbound
>[0]["outbound"];
type ChannelMessageOutboundBridgeResult = Awaited<
  ReturnType<NonNullable<OutboundBridgeAdapter["sendText"]>>
>;

const cfg = {} as OpenClawConfig;

function makeReceipt(ids: string[], kind: MessageReceipt["parts"][number]["kind"]): MessageReceipt {
  return {
    primaryPlatformMessageId: ids[0],
    platformMessageIds: ids,
    parts: ids.map((platformMessageId, index) => ({ platformMessageId, kind, index })),
    sentAt: 123,
  };
}

describe("createChannelMessageAdapterFromOutbound", () => {
  it("preserves explicit no-send facts in progress and final results", async () => {
    const notSent = { outcome: "not_sent" as const, messageId: "" };
    const adapter = createChannelMessageAdapterFromOutbound({
      outbound: {
        sendText: async ({ onDeliveryResult }) => {
          await onDeliveryResult?.(notSent);
          return notSent;
        },
      },
    });
    const onDeliveryResult = vi.fn();
    const result = await adapter.send?.text?.({ cfg, to: "room-1", text: "---", onDeliveryResult });
    for (const delivery of [result, onDeliveryResult.mock.calls[0]?.[0]]) {
      expect(delivery).toMatchObject({
        outcome: "not_sent",
        receipt: { platformMessageIds: [], parts: [] },
      });
      expect(delivery).not.toHaveProperty("messageId");
    }
  });

  it("wraps outbound text sends with a message receipt", async () => {
    const sendText = vi.fn(async (_request: ChannelMessageSendTextContext) => ({
      channel: "demo",
      messageId: "msg-1",
    }));
    const adapter = createChannelMessageAdapterFromOutbound({
      id: "demo",
      outbound: {
        deliveryCapabilities: { durableFinal: { text: true, replyTo: true } },
        sendText,
      },
    });
    const result = await adapter.send?.text?.({
      cfg,
      to: "room-1",
      text: "hello",
      replyToId: "parent-1",
      threadId: "thread-1",
    });
    expect(adapter.id).toBe("demo");
    expect(adapter.durableFinal).toEqual({ capabilities: { text: true, replyTo: true } });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[0]).toMatchObject({
      to: "room-1",
      text: "hello",
      replyToId: "parent-1",
      threadId: "thread-1",
    });
    expect(result).toMatchObject({
      messageId: "msg-1",
      receipt: {
        primaryPlatformMessageId: "msg-1",
        platformMessageIds: ["msg-1"],
        threadId: "thread-1",
        replyToId: "parent-1",
        parts: [
          { platformMessageId: "msg-1", kind: "text", threadId: "thread-1", replyToId: "parent-1" },
        ],
      },
    });
  });

  it("normalizes outbound progress results before forwarding them to message callers", async () => {
    const sendText = vi.fn(
      async (request: {
        onDeliveryResult?: (result: ChannelMessageOutboundBridgeResult) => Promise<void> | void;
      }) => {
        await request.onDeliveryResult?.({ channel: "demo", messageId: "chunk-1" });
        return { channel: "demo", messageId: "chunk-2" };
      },
    );
    const onDeliveryResult = vi.fn();
    const adapter = createChannelMessageAdapterFromOutbound({ outbound: { sendText } });

    await adapter.send?.text?.({
      cfg,
      to: "room-1",
      text: "hello",
      onDeliveryResult,
    });

    expect(onDeliveryResult).toHaveBeenCalledTimes(1);
    expect(onDeliveryResult).toHaveBeenCalledWith({
      messageId: "chunk-1",
      receipt: expect.objectContaining({
        primaryPlatformMessageId: "chunk-1",
        platformMessageIds: ["chunk-1"],
      }),
    });
  });

  it("preserves route-only final and progress metadata without fabricating message ids", async () => {
    const sendText = vi.fn(
      async (request: {
        onDeliveryResult?: (result: ChannelMessageOutboundBridgeResult) => Promise<void> | void;
      }) => {
        await request.onDeliveryResult?.({ messageId: "", toJid: "progress-route" });
        return { chatId: "final-route" };
      },
    );
    const onDeliveryResult = vi.fn();
    const adapter = createChannelMessageAdapterFromOutbound({ outbound: { sendText } });

    const result = await adapter.send?.text?.({
      cfg,
      to: "room-1",
      text: "hello",
      onDeliveryResult,
    });

    expect(onDeliveryResult).toHaveBeenCalledWith({
      toJid: "progress-route",
      receipt: expect.objectContaining({ platformMessageIds: [], parts: [] }),
    });
    expect(onDeliveryResult.mock.calls[0]?.[0]).not.toHaveProperty("messageId");
    expect(result).toMatchObject({
      chatId: "final-route",
      receipt: { platformMessageIds: [], parts: [] },
    });
    expect(result).not.toHaveProperty("messageId");
  });

  it("preserves target-only routing metadata without fabricating delivery identity", async () => {
    const target = { kind: "channel" as const, id: "route-only" };
    const adapter = createChannelMessageAdapterFromOutbound({
      outbound: {
        sendText: vi.fn(async () => ({ target })),
      },
    });
    const result = await adapter.send?.text?.({ cfg, to: "room-1", text: "hello" });
    expect(result?.target).toEqual(target);
    expect(result).not.toHaveProperty("messageId");
    expect(result?.receipt.primaryPlatformMessageId).toBeUndefined();
    expect(result?.receipt.platformMessageIds).toEqual([]);
    expect(result?.receipt.parts).toEqual([]);
  });

  it("preserves contracted delivery facts without exposing private provider fields", async () => {
    const sourceResult = (messageId: string) => ({
      channel: "forged-channel",
      messageId,
      chatId: "chat-1",
      channelId: "channel-1",
      roomId: "room-1",
      conversationId: "conversation-1",
      toJid: "recipient@example.invalid",
      pollId: "poll-1",
      timestamp: 123,
      meta: { questionActionIds: ["question:1"], questionMessageId: "question-card" },
      receipt: makeReceipt([messageId], "text"),
      accessToken: "private-access-token",
      content: "private-provider-content",
      primaryMessageId: "private-primary-id",
      threadTs: "private-thread-ts",
      blocks: [{ text: "private-block" }],
      callback: { value: "private-callback" },
      action: { value: "private-action" },
    });
    const onDeliveryResult = vi.fn();
    const adapter = createChannelMessageAdapterFromOutbound({
      outbound: {
        sendText: async ({ onDeliveryResult: reportProgress }) => {
          await reportProgress?.(sourceResult("progress-1"));
          return sourceResult("final-1");
        },
      },
    });
    const result = await adapter.send?.text?.({
      cfg,
      to: "room-1",
      text: "hello",
      onDeliveryResult,
    });
    expect(onDeliveryResult).toHaveBeenCalledOnce();
    const progress = onDeliveryResult.mock.calls[0]?.[0];
    for (const [delivery, messageId] of [
      [progress, "progress-1"],
      [result, "final-1"],
    ] as const) {
      expect(delivery).toMatchObject({
        messageId,
        chatId: "chat-1",
        channelId: "channel-1",
        roomId: "room-1",
        conversationId: "conversation-1",
        toJid: "recipient@example.invalid",
        pollId: "poll-1",
        timestamp: 123,
        meta: { questionActionIds: ["question:1"], questionMessageId: "question-card" },
      });
      for (const privateField of [
        "channel",
        "accessToken",
        "content",
        "primaryMessageId",
        "threadTs",
        "blocks",
        "callback",
        "action",
      ]) {
        expect(delivery).not.toHaveProperty(privateField);
      }
    }
  });

  it("preserves an outbound receipt instead of rebuilding it", async () => {
    const receipt = makeReceipt(["receipt-1", "receipt-2"], "media");
    const adapter = createChannelMessageAdapterFromOutbound({
      outbound: {
        deliveryCapabilities: { durableFinal: { media: true } },
        sendMedia: vi.fn(async () => ({ channel: "demo", messageId: "legacy-id", receipt })),
      },
    });
    await expect(
      adapter.send?.media?.({
        cfg,
        to: "room-1",
        text: "caption",
        mediaUrl: "file:///tmp/a.png",
      }),
    ).resolves.toEqual({ messageId: "legacy-id", receipt });
  });

  it("preserves an authoritative empty receipt with routing metadata", async () => {
    const receipt: MessageReceipt = {
      platformMessageIds: [],
      parts: [],
      threadId: "canonical-thread",
      sentAt: 123,
    };
    const adapter = createChannelMessageAdapterFromOutbound({
      outbound: {
        sendText: vi.fn(async () => ({ messageId: "", toJid: "route-only", receipt })),
      },
    });

    await expect(
      adapter.send?.text?.({ cfg, to: "room-1", text: "hello", threadId: "requested-thread" }),
    ).resolves.toEqual({ toJid: "route-only", receipt });
  });

  it.each([
    {
      name: "portable presentation with fallback text",
      payload: {
        text: "Fallback",
        presentation: { blocks: [{ type: "divider" }] },
      },
      expected: "card",
    },
    {
      name: "title-only presentation",
      payload: {
        text: "Fallback",
        presentation: { title: "Heading", blocks: [] },
      },
      expected: "card",
    },
    {
      name: "rendered presentation blocks",
      payload: {
        text: "Fallback",
        channelData: { slack: { presentationBlocks: [{ type: "divider" }] } },
      },
      expected: "card",
    },
    {
      name: "empty rendered presentation blocks",
      payload: {
        text: "Fallback",
        channelData: { slack: { presentationBlocks: [] } },
      },
      expected: "text",
    },
    {
      name: "unrelated channel metadata",
      payload: {
        text: "Fallback",
        channelData: { slack: { unfurl: false } },
      },
      expected: "text",
    },
  ] satisfies Array<{
    name: string;
    payload: ChannelMessageSendPayloadContext["payload"];
    expected: "card" | "text";
  }>)("classifies $name payloads as $expected", async ({ payload, expected }) => {
    const adapter = createChannelMessageAdapterFromOutbound({
      outbound: {
        sendPayload: vi.fn(async () => ({ channel: "demo", messageId: "msg-1" })),
      },
    });
    const result = await adapter.send?.payload?.({
      cfg,
      to: "room-1",
      text: payload.text ?? "",
      payload,
    });
    expect(result?.receipt.parts[0]?.kind).toBe(expected);
  });

  it("wraps rich payload sends and infers the receipt part kind", async () => {
    const sendPayload = vi.fn(async (_request: ChannelMessageSendPayloadContext) => ({
      channel: "demo",
      messageId: "card-1",
    }));
    const adapter = createChannelMessageAdapterFromOutbound({
      capabilities: { payload: true, batch: true },
      outbound: { sendPayload },
    });

    const result = await adapter.send?.payload?.({
      cfg,
      to: "room-1",
      text: "",
      payload: {
        presentation: { blocks: [{ type: "text", text: "ready" }] },
      },
    });

    expect(adapter.durableFinal?.capabilities).toEqual({ payload: true, batch: true });
    expect(sendPayload).toHaveBeenCalledTimes(1);
    const sendPayloadRequest = requireFirstCallArg(
      sendPayload,
    ) as unknown as ChannelMessageSendPayloadContext;
    expect(sendPayloadRequest.payload).toEqual({
      presentation: { blocks: [{ type: "text", text: "ready" }] },
    });
    expect(result?.receipt.parts[0]?.platformMessageId).toBe("card-1");
    expect(result?.receipt.parts[0]?.kind).toBe("card");
  });

  it("wraps outbound poll sends with poll receipts", async () => {
    const sendPoll = vi.fn(async (_request: ChannelMessageSendPollContext) => ({
      channel: "demo",
      pollId: "poll-1",
    }));
    const adapter = createChannelMessageAdapterFromOutbound({
      capabilities: { poll: true },
      outbound: { sendPoll },
    });

    const result = await adapter.send?.poll?.({
      cfg,
      to: "room-1",
      poll: { question: "Ship?", options: ["Yes", "No"] },
      threadId: "thread-1",
    });

    expect(adapter.durableFinal?.capabilities).toEqual({ poll: true });
    expect(sendPoll).toHaveBeenCalledTimes(1);
    const sendPollRequest = requireFirstCallArg(
      sendPoll,
    ) as unknown as ChannelMessageSendPollContext;
    expect(sendPollRequest.poll).toEqual({ question: "Ship?", options: ["Yes", "No"] });
    expect(sendPollRequest.threadId).toBe("thread-1");
    expect(result?.messageId).toBe("poll-1");
    expect(result?.receipt.parts[0]?.platformMessageId).toBe("poll-1");
    expect(result?.receipt.parts[0]?.kind).toBe("poll");
  });

  it("normalizes existing outbound poll receipts", async () => {
    const receipt = makeReceipt(["card-1"], "card");
    const adapter = createChannelMessageAdapterFromOutbound({
      capabilities: { poll: true },
      outbound: {
        sendPoll: vi.fn(async () => ({ messageId: "card-1", receipt })),
      },
    });
    const result = await adapter.send?.poll?.({
      cfg,
      to: "room-1",
      poll: { question: "Ship?", options: ["Yes", "No"] },
    });
    expect(result?.messageId).toBe("card-1");
    expect(result?.receipt.parts).toEqual([
      { platformMessageId: "card-1", kind: "poll", index: 0 },
    ]);
    expect(receipt.parts[0]?.kind).toBe("card");
  });

  it("exposes only send methods backed by outbound handlers", async () => {
    const adapter = createChannelMessageAdapterFromOutbound({
      outbound: {
        sendText: vi.fn(async () => ({ messageId: "msg-1" })),
      },
    });

    const sendText = adapter.send?.text;
    if (!sendText) {
      throw new Error("expected text send adapter");
    }

    const result = await sendText({ cfg, to: "room-1", text: "hello" });
    expect(result.messageId).toBe("msg-1");
    expect(result.receipt.primaryPlatformMessageId).toBe("msg-1");
    expect(result.receipt.platformMessageIds).toEqual(["msg-1"]);
    expect(adapter.send?.media).toBeUndefined();
    expect(adapter.send?.payload).toBeUndefined();
    expect(adapter.send?.poll).toBeUndefined();
  });

  it("defaults outbound-derived adapters to plugin-owned receive acknowledgements", () => {
    const adapter = createChannelMessageAdapterFromOutbound({
      outbound: {
        sendText: vi.fn(async () => ({ messageId: "msg-1" })),
      },
    });

    expect(adapter.receive).toEqual({
      defaultAckPolicy: "manual",
      supportedAckPolicies: ["manual"],
    });
  });

  it("preserves declared live and receive lifecycle metadata", () => {
    const live = { capabilities: { draftPreview: true, previewFinalization: true } };
    const receive = {
      defaultAckPolicy: "after_agent_dispatch" as const,
      supportedAckPolicies: ["after_receive_record", "after_agent_dispatch"] as const,
    };
    const adapter = createChannelMessageAdapterFromOutbound({
      outbound: {},
      live,
      receive: { ...receive, supportedAckPolicies: [...receive.supportedAckPolicies] },
    });
    expect(adapter.live).toEqual({
      capabilities: { draftPreview: true, previewFinalization: true },
    });
    expect(adapter.receive).toEqual({
      defaultAckPolicy: "after_agent_dispatch",
      supportedAckPolicies: ["after_receive_record", "after_agent_dispatch"],
    });
  });
});
