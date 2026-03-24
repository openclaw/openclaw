import { describe, expect, it, vi } from "vitest";
import { createBlockReplyContentKey } from "./block-reply-pipeline.js";
import { createBlockReplyDeliveryHandler } from "./reply-delivery.js";
import type { TypingSignaler } from "./typing-mode.js";

function createTypingSignalerStub(): TypingSignaler {
  return {
    mode: "instant",
    shouldStartImmediately: true,
    shouldStartOnMessageStart: false,
    shouldStartOnText: true,
    shouldStartOnReasoning: false,
    signalRunStart: vi.fn(async () => {}),
    signalMessageStart: vi.fn(async () => {}),
    signalTextDelta: vi.fn(async () => {}),
    signalReasoningDelta: vi.fn(async () => {}),
    signalToolStart: vi.fn(async () => {}),
  };
}

describe("createBlockReplyDeliveryHandler direct delivery", () => {
  it("does not track declined direct block sends as delivered", async () => {
    const directlySentBlockKeys = new Set<string>();
    const handler = createBlockReplyDeliveryHandler({
      onBlockReply: vi.fn(async () => false),
      currentMessageId: "msg-1",
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: createTypingSignalerStub(),
      blockStreamingEnabled: true,
      blockReplyPipeline: null,
      directlySentBlockKeys,
    });

    await handler({ text: "Chunk" });

    expect(directlySentBlockKeys.size).toBe(0);
  });

  it("tracks successful direct block sends as delivered", async () => {
    const directlySentBlockKeys = new Set<string>();
    const handler = createBlockReplyDeliveryHandler({
      onBlockReply: vi.fn(async () => undefined),
      currentMessageId: "msg-1",
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: createTypingSignalerStub(),
      blockStreamingEnabled: true,
      blockReplyPipeline: null,
      directlySentBlockKeys,
    });

    await handler({ text: "Chunk" });

    expect(directlySentBlockKeys).toEqual(
      new Set([createBlockReplyContentKey({ text: "Chunk", replyToId: "msg-1" })]),
    );
  });
});
