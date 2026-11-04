// Outbound bridge tests cover channel message handoff from core to outbound adapters.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createChannelMessageAdapterFromOutbound } from "./outbound-bridge.js";
import type {
  ChannelMessageSendPayloadContext,
  ChannelMessageSendTextContext,
  MessageReceipt,
} from "./types.js";

const cfg = {} as OpenClawConfig;

function requireFirstCallArg(mock: {
  mock: { calls: readonly unknown[][] };
}): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected first mock call");
  }
  const [arg] = call;
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    throw new Error("expected first mock call argument to be an object");
  }
  return arg as Record<string, unknown>;
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
    const sendTextRequest = requireFirstCallArg(
      sendText,
    ) as unknown as ChannelMessageSendTextContext;
    expect(sendTextRequest.to).toBe("room-1");
    expect(sendTextRequest.text).toBe("hello");
    expect(sendTextRequest.replyToId).toBe("parent-1");
    expect(sendTextRequest.threadId).toBe("thread-1");
    expect(result?.messageId).toBe("msg-1");
    expect(result?.receipt.primaryPlatformMessageId).toBe("msg-1");
    expect(result?.receipt.platformMessageIds).toEqual(["msg-1"]);
    expect(result?.receipt.threadId).toBe("thread-1");
    expect(result?.receipt.replyToId).toBe("parent-1");
    expect(
      result?.receipt.parts.map(({ platformMessageId, kind, threadId, replyToId }) => ({
        platformMessageId,
        kind,
        threadId,
        replyToId,
      })),
    ).toEqual([
      {
        platformMessageId: "msg-1",
        kind: "text",
        threadId: "thread-1",
        replyToId: "parent-1",
      },
    ]);
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
      receipt: {
        primaryPlatformMessageId: messageId,
        platformMessageIds: [messageId],
        parts: [{ platformMessageId: messageId, kind: "text" as const, index: 0 }],
        sentAt: 123,
      },
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
    const receipt: MessageReceipt = {
      primaryPlatformMessageId: "receipt-1",
      platformMessageIds: ["receipt-1", "receipt-2"],
      parts: [
        { platformMessageId: "receipt-1", kind: "media", index: 0 },
        { platformMessageId: "receipt-2", kind: "media", index: 1 },
      ],
      sentAt: 123,
    };
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
      name: "empty rendered presentation blocks",
      payload: {
        text: "Fallback",
        channelData: { slack: { presentationBlocks: [] } },
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

  it("normalizes existing outbound poll receipts", async () => {
    const receipt: MessageReceipt = {
      primaryPlatformMessageId: "card-1",
      platformMessageIds: ["card-1"],
      parts: [{ platformMessageId: "card-1", kind: "card", index: 0 }],
      sentAt: 123,
    };
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

  it("preserves declared live and receive lifecycle metadata", () => {
    const adapter = createChannelMessageAdapterFromOutbound({
      outbound: {},
      live: {
        capabilities: {
          draftPreview: true,
          previewFinalization: true,
        },
      },
      receive: {
        defaultAckPolicy: "after_agent_dispatch",
        supportedAckPolicies: ["after_receive_record", "after_agent_dispatch"],
      },
    });

    expect(adapter.live).toEqual({
      capabilities: {
        draftPreview: true,
        previewFinalization: true,
      },
    });
    expect(adapter.receive).toEqual({
      defaultAckPolicy: "after_agent_dispatch",
      supportedAckPolicies: ["after_receive_record", "after_agent_dispatch"],
    });
  });
});
