import { describe, expect, it, vi } from "vitest";
import { createBlockReplyDeliveryHandler } from "./reply-delivery.js";
import type { TypingSignaler } from "./typing-mode.js";

type BlockReplyPipelineLike = NonNullable<
  Parameters<typeof createBlockReplyDeliveryHandler>[0]["blockReplyPipeline"]
>;

describe("CoT-frame leak suppression in block-streaming path", () => {
  it("suppresses bracketed internal narration from streamed block reply", async () => {
    const enqueue = vi.fn();
    const blockReplyPipeline = { enqueue } as unknown as BlockReplyPipelineLike;

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply: vi.fn(async () => {}),
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: true,
      blockReplyPipeline,
      directlySentBlockKeys: new Set(),
    });

    await handler({ text: "[internal] thinking out loud about the leak" });

    // Today: enqueue IS suppressed for CoT-frame text → no leak ships.
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("suppresses bare reasoning frames from streamed block reply", async () => {
    const enqueue = vi.fn();
    const blockReplyPipeline = { enqueue } as unknown as BlockReplyPipelineLike;

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply: vi.fn(async () => {}),
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: true,
      blockReplyPipeline,
      directlySentBlockKeys: new Set(),
    });

    await handler({ text: "[reasoning] internal narration" });

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("suppresses scratchpad frames from streamed block reply", async () => {
    const enqueue = vi.fn();
    const blockReplyPipeline = { enqueue } as unknown as BlockReplyPipelineLike;

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply: vi.fn(async () => {}),
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: true,
      blockReplyPipeline,
      directlySentBlockKeys: new Set(),
    });

    await handler({ text: "[scratchpad] surfacing thought" });

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("control: legitimate text WITHOUT a CoT frame still flows through", async () => {
    const enqueue = vi.fn();
    const blockReplyPipeline = { enqueue } as unknown as BlockReplyPipelineLike;

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply: vi.fn(async () => {}),
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: true,
      blockReplyPipeline,
      directlySentBlockKeys: new Set(),
    });

    await handler({ text: "regular reply, no frame" });

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ text: "regular reply, no frame" }),
    );
  });
});
