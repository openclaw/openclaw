import { describe, expect, it } from "vitest";
import {
  createMessageReceiptFromOutboundResults,
  listMessageReceiptPlatformIds,
  resolveMessageReceiptPrimaryId,
  resolveReceiptSourceId,
} from "./receipt.js";

function nestedReceipt(id: string, threadId: string, sentAt: number) {
  return {
    receipt: {
      platformMessageIds: [id],
      parts: [{ platformMessageId: id, kind: "text" as const, index: 0 }],
      threadId,
      sentAt,
    },
  };
}

describe("createMessageReceiptFromOutboundResults", () => {
  it("excludes explicit no-send results from identity and aggregate receipt evidence", () => {
    const notSent = {
      outcome: "not_sent" as const,
      messageId: "not-a-delivery",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ messageId: "stale-id" }],
        threadId: "stale-thread",
      }),
    };
    const receipt = createMessageReceiptFromOutboundResults({
      results: [notSent, { messageId: "accepted" }],
    });
    expect(resolveReceiptSourceId(notSent)).toBeUndefined();
    expect(receipt.platformMessageIds).toEqual(["accepted"]);
    expect(receipt.parts.map((part) => part.platformMessageId)).toEqual(["accepted"]);
    expect(receipt.threadId).toBeUndefined();
    expect(receipt.raw?.[0]).toBe(notSent);
  });

  it("builds a multi-part receipt from outbound delivery results", () => {
    const receipt = createMessageReceiptFromOutboundResults({
      results: [
        { channel: "telegram", messageId: "m1" },
        { channel: "telegram", messageId: "m2" },
      ],
      kind: "text",
      threadId: "topic-1",
      replyToId: "reply-1",
      sentAt: 123,
    });
    expect(receipt).toMatchObject({
      primaryPlatformMessageId: "m1",
      platformMessageIds: ["m1", "m2"],
      threadId: "topic-1",
      replyToId: "reply-1",
      sentAt: 123,
      parts: [
        { platformMessageId: "m1", kind: "text", index: 0 },
        { platformMessageId: "m2", kind: "text", index: 1 },
      ],
    });
  });

  it("keeps routing metadata without a message id out of platform identity", () => {
    const result = {
      channel: "demo",
      chatId: "route-only",
      channelId: "route-only",
      roomId: "route-only",
      conversationId: "route-only",
      toJid: "route-only",
      target: { kind: "channel" as const, id: "route-only" },
    };
    const receipt = createMessageReceiptFromOutboundResults({ results: [result], sentAt: 123 });

    expect(receipt.primaryPlatformMessageId).toBeUndefined();
    expect(receipt.platformMessageIds).toEqual([]);
    expect(receipt.parts).toEqual([]);
    expect(receipt.raw).toEqual([result]);
  });

  it("does not fabricate platform ids from iMessage bridge placeholders", () => {
    const result = { channel: "imessage", messageId: "ok" };
    const receiptMetadata = { replyToId: "source-1" };
    const adapterReceipt = {
      platformMessageIds: [],
      parts: [],
      sentAt: 123,
      ...receiptMetadata,
    };
    const receipt = createMessageReceiptFromOutboundResults({
      results: [{ ...result, receipt: adapterReceipt }],
    });
    expect(receipt).toMatchObject({
      ...receiptMetadata,
      platformMessageIds: [],
      parts: [],
      sentAt: 123,
    });
    expect(receipt.primaryPlatformMessageId).toBeUndefined();
  });

  it("keeps conflicting provider threads on parts and omits the aggregate thread", () => {
    const receipt = createMessageReceiptFromOutboundResults({
      results: [
        nestedReceipt("m1", "canonical-thread-1", 123),
        nestedReceipt("m2", "canonical-thread-2", 124),
      ],
      threadId: "requested-thread",
    });
    expect(receipt.threadId).toBeUndefined();
    expect(receipt.parts.map((part) => part.threadId)).toEqual([
      "canonical-thread-1",
      "canonical-thread-2",
    ]);
  });

  it("preserves mixed nested reply metadata when the route has a reply target", () => {
    const receipt = createMessageReceiptFromOutboundResults({
      results: [
        {
          channel: "discord",
          messageId: "m2",
          receipt: {
            primaryPlatformMessageId: "m1",
            platformMessageIds: ["m1", "m2"],
            parts: [
              { platformMessageId: "m1", kind: "text", index: 0, replyToId: "reply-1" },
              { platformMessageId: "m2", kind: "text", index: 1 },
            ],
            replyToId: "reply-1",
            sentAt: 123,
          },
        },
      ],
      replyToId: "reply-1",
    });
    expect(receipt.replyToId).toBe("reply-1");
    expect(receipt.parts.map((part) => part.replyToId)).toEqual(["reply-1", undefined]);
  });

  it("normalizes receipt ids for compatibility edges", () => {
    const receipt = {
      primaryPlatformMessageId: " ",
      platformMessageIds: [" m1 ", "", "m1", "m2"],
      parts: [],
      sentAt: 123,
    };
    expect(listMessageReceiptPlatformIds(receipt)).toEqual(["m1", "m2"]);
    expect(resolveMessageReceiptPrimaryId(receipt)).toBe("m1");
  });
});
