import { describe, expect, it } from "vitest";
import type { MessageReceipt } from "../message/types.js";
import {
  createAcceptedChannelDeliveryResult,
  createChannelDeliveryAccumulator,
  createChannelDeliveryResultFromReceipt,
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "./delivery-result.js";
import {
  hasFinalChannelTurnDispatch,
  hasVisibleChannelTurnDispatch,
  resolveChannelTurnDispatchCounts,
} from "./dispatch-result.js";

const receipt = (overrides: Partial<MessageReceipt> = {}): MessageReceipt => ({
  platformMessageIds: [],
  parts: [],
  sentAt: 123,
  ...overrides,
});

describe("channel delivery results", () => {
  it("suppresses an empty batch and leaves failures before acceptance unchanged", () => {
    const accepted = createChannelDeliveryAccumulator();
    const error = new Error("send rejected");
    const partial = { visibleReplySent: true as const, messageIds: ["accepted-attachment"] };
    expect(accepted.result()).toEqual({
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });
    expect(accepted.partialError(error)).toBe(error);
    expect(accepted.partialError(createChannelPartialDeliveryError(error, partial))).toMatchObject({
      deliveryResult: { ...partial, content: "" },
    });
  });

  it("keeps immutable snapshots and a nested failure's accepted subset in send order", () => {
    const accepted = createChannelDeliveryAccumulator({ kind: "media", replyToId: "parent" });
    const prefix = { messageIds: ["first"], content: "first" };
    accepted.add({ messageId: "first" }, prefix.content);
    const snapshot = accepted.result();
    accepted.add({ messageId: "attachment" }, "");
    const failure = accepted.partialError(
      createChannelPartialDeliveryError(new Error("last caption rejected"), {
        visibleReplySent: true,
        messageIds: ["last-attachment"],
        content: "last",
      }),
    );

    expect(failure).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      sentBeforeError: true,
      visibleReplySent: true,
      deliveryResult: {
        visibleReplySent: true,
        messageIds: ["first", "attachment", "last-attachment"],
        content: "first\nlast",
        receipt: { primaryPlatformMessageId: "first", replyToId: "parent" },
      },
    });
    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    expect(snapshot).toMatchObject({
      ...prefix,
      receipt: { raw: [{ messageId: "first" }] },
    });
    expect(accepted.result()).toMatchObject({
      messageIds: ["first", "attachment"],
      content: prefix.content,
    });
  });
  it("retains accepted prefixes and nested partial receipt identities", () => {
    const nestedReceipt = receipt({
      primaryPlatformMessageId: "attachment",
      platformMessageIds: ["attachment", "caption"],
      parts: [{ platformMessageId: "attachment", kind: "media", index: 0, threadId: "thread" }],
    });
    const result = createAcceptedChannelDeliveryResult({
      results: [{ messageId: "prefix" }],
      deliveryResults: [{ visibleReplySent: true, messageIds: ["stale"], receipt: nestedReceipt }],
      kind: "media",
      content: "prefix\nattachment",
    });

    expect(result).toMatchObject({
      messageIds: ["prefix", "attachment", "caption"],
      content: "prefix\nattachment",
      visibleReplySent: true,
    });
    expect(result).not.toHaveProperty("threadId");
    expect(result.receipt.parts[0]?.platformMessageId).toBe("prefix");
    expect(result.receipt.parts[1]).toEqual(nestedReceipt.parts[0]);
  });

  it("preserves identityless accepted delivery without inventing routing or text", () => {
    const result = createAcceptedChannelDeliveryResult({});
    expect(result).toMatchObject({
      messageIds: [],
      receipt: { platformMessageIds: [], parts: [] },
      visibleReplySent: true,
    });
    expect(result).not.toHaveProperty("content");
    expect(result).not.toHaveProperty("threadId");
  });
  it("keeps legacy messageIds while attaching the receipt", () => {
    const input = {
      receipt: receipt({
        primaryPlatformMessageId: "m1",
        platformMessageIds: ["m1", "m2"],
        threadId: "canonical-thread",
      }),
      threadId: "requested-thread",
      replyToId: "reply-1",
      visibleReplySent: true,
      deliveryIntent: { id: "intent-1", kind: "outbound_queue", queuePolicy: "required" } as const,
    };
    expect(createChannelDeliveryResultFromReceipt(input)).toEqual({
      ...input,
      messageIds: ["m1", "m2"],
      threadId: "canonical-thread",
    });
  });

  it.each([
    { visibleReplySent: false, receipt: receipt() },
    {
      visibleReplySent: true,
      receipt: receipt({
        platformMessageIds: ["m1", "m2"],
        parts: [
          { platformMessageId: "m1", kind: "text", index: 0, threadId: "thread-1" },
          { platformMessageId: "m2", kind: "text", index: 1, threadId: "thread-2" },
        ],
      }),
    },
  ])(
    "preserves receipt identity without inventing a route (visible=$visibleReplySent)",
    (input) => {
      const result = createChannelDeliveryResultFromReceipt({
        ...input,
        ...(input.visibleReplySent ? { threadId: "requested-thread" } : {}),
      });
      expect(result.receipt).toBe(input.receipt);
      expect(result).toEqual({
        ...input,
        ...(input.visibleReplySent ? { messageIds: ["m1", "m2"] } : {}),
      });
    },
  );

  it("normalizes visible dispatch checks", () => {
    const toolDispatch = {
      settledReceipt: {
        anyVisibleDelivered: true,
        counts: { tool: { delivered: 1, failedAfterSend: 0 } },
      },
    };
    expect(hasVisibleChannelTurnDispatch(undefined)).toBe(false);
    expect(
      hasVisibleChannelTurnDispatch({
        queuedFinal: false,
        counts: { tool: 1, block: 0, final: 0 },
        settledReceipt: { anyVisibleDelivered: false, counts: {} },
      }),
    ).toBe(false);
    expect(hasVisibleChannelTurnDispatch(toolDispatch)).toBe(true);
    expect(hasVisibleChannelTurnDispatch(undefined, { observedReplyDelivery: true })).toBe(true);
    expect(hasFinalChannelTurnDispatch(toolDispatch)).toBe(false);
    expect(resolveChannelTurnDispatchCounts(undefined)).toEqual({ tool: 0, block: 0, final: 0 });
  });
});
