import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../types.js";
import { createBlockReplyDeliveryHandler } from "./reply-delivery.js";
import type { TypingSignaler } from "./typing-mode.js";

function createMockTypingSignals(): TypingSignaler {
  return {
    mode: "never",
    shouldStartImmediately: false,
    shouldStartOnMessageStart: false,
    shouldStartOnText: false,
    shouldStartOnReasoning: false,
    signalRunStart: vi.fn().mockResolvedValue(undefined),
    signalMessageStart: vi.fn().mockResolvedValue(undefined),
    signalTextDelta: vi.fn().mockResolvedValue(undefined),
    signalReasoningDelta: vi.fn().mockResolvedValue(undefined),
    signalToolStart: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockParams(overrides: {
  blockStreamingEnabled: boolean;
  blockReplyPipeline?: { enqueue: ReturnType<typeof vi.fn> } | null;
}) {
  const onBlockReply = vi.fn();
  const directlySentBlockKeys = new Set<string>();
  return {
    onBlockReply,
    currentMessageId: "msg-1",
    normalizeStreamingText: (payload: ReplyPayload) => ({
      text: payload.text,
      skip: false,
    }),
    applyReplyToMode: (payload: ReplyPayload) => payload,
    typingSignals: createMockTypingSignals(),
    blockStreamingEnabled: overrides.blockStreamingEnabled,
    blockReplyPipeline: (overrides.blockReplyPipeline ?? null) as unknown as Parameters<
      typeof createBlockReplyDeliveryHandler
    >[0]["blockReplyPipeline"],
    directlySentBlockKeys,
  };
}

describe("createBlockReplyDeliveryHandler", () => {
  it("enqueues to pipeline when block streaming is enabled and pipeline exists", async () => {
    const pipeline = { enqueue: vi.fn() };
    const params = createMockParams({
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
    });
    const handler = createBlockReplyDeliveryHandler(params);

    await handler({ text: "hello" });

    expect(pipeline.enqueue).toHaveBeenCalledTimes(1);
    expect(params.onBlockReply).not.toHaveBeenCalled();
  });

  it("sends directly when block streaming is enabled but pipeline is null", async () => {
    const params = createMockParams({
      blockStreamingEnabled: true,
      blockReplyPipeline: null,
    });
    const handler = createBlockReplyDeliveryHandler(params);

    await handler({ text: "hello" });

    expect(params.onBlockReply).toHaveBeenCalledTimes(1);
    expect(params.directlySentBlockKeys.size).toBe(1);
  });

  it("delivers block replies at message boundaries when streaming is disabled (#43020)", async () => {
    const params = createMockParams({
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
    });
    const handler = createBlockReplyDeliveryHandler(params);

    await handler({ text: "turn-1 response" });

    expect(params.onBlockReply).toHaveBeenCalledTimes(1);
    expect(params.onBlockReply.mock.calls[0][0]).toMatchObject({ text: "turn-1 response" });
    expect(params.directlySentBlockKeys.size).toBe(1);
  });

  it("tracks multiple boundary deliveries for deduplication", async () => {
    const params = createMockParams({
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
    });
    const handler = createBlockReplyDeliveryHandler(params);

    await handler({ text: "turn-1" });
    await handler({ text: "turn-2" });

    expect(params.onBlockReply).toHaveBeenCalledTimes(2);
    expect(params.directlySentBlockKeys.size).toBe(2);
  });

  it("skips empty payloads", async () => {
    const params = createMockParams({
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
    });
    const handler = createBlockReplyDeliveryHandler(params);

    await handler({ text: "" });

    expect(params.onBlockReply).not.toHaveBeenCalled();
  });

  it("skips when normalizeStreamingText returns skip=true and no media", async () => {
    const params = createMockParams({
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
    });
    params.normalizeStreamingText = () => ({ text: "hello", skip: true });
    const handler = createBlockReplyDeliveryHandler(params);

    await handler({ text: "hello" });

    expect(params.onBlockReply).not.toHaveBeenCalled();
  });
});
