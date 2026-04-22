import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createBlockReplyDeliveryHandler,
  normalizeReplyPayloadDirectives,
} from "./reply-delivery.js";
import type { TypingSignaler } from "./typing-mode.js";

type BlockReplyPipelineLike = NonNullable<
  Parameters<typeof createBlockReplyDeliveryHandler>[0]["blockReplyPipeline"]
>;

describe("createBlockReplyDeliveryHandler", () => {
  it("accumulates media-bearing block replies for buildReplyPayloads when block streaming is disabled", async () => {
    // When block streaming is disabled, media-bearing blocks must NOT be sent immediately via
    // onBlockReply. Sending them immediately would invoke normalizeMediaPaths a second time
    // (once in reply-delivery, once in buildReplyPayloads), producing different UUID outbound
    // paths and defeating the deduplication key — resulting in duplicate media delivery.
    // Instead, media blocks are accumulated and sent via buildReplyPayloads at end of run.
    // See: https://github.com/openclaw/openclaw/issues/70085
    const onBlockReply = vi.fn(async () => {});
    const normalizeStreamingText = vi.fn((payload: { text?: string }) => ({
      text: payload.text,
      skip: false,
    }));
    const directlySentBlockKeys = new Set<string>();
    const typingSignals = {
      signalTextDelta: vi.fn(async () => {}),
    } as unknown as TypingSignaler;

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply,
      normalizeStreamingText,
      applyReplyToMode: (payload) => payload,
      typingSignals,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      directlySentBlockKeys,
    });

    await handler({
      text: "here's the vibe",
      mediaUrls: ["/tmp/generated.png"],
      replyToCurrent: true,
    });

    // onBlockReply must NOT be called — media will be sent via buildReplyPayloads
    expect(onBlockReply).not.toHaveBeenCalled();
    // No content key tracked since nothing was sent
    expect(directlySentBlockKeys).toEqual(new Set());
    // Typing signal still sent for the text portion
    expect(typingSignals.signalTextDelta).toHaveBeenCalledWith("here's the vibe");
  });

  it("keeps text-only block replies buffered when block streaming is disabled", async () => {
    const onBlockReply = vi.fn(async () => {});

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply,
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      directlySentBlockKeys: new Set(),
    });

    await handler({ text: "text only" });

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("trims leading whitespace in block-streamed replies", async () => {
    const blockReplyPipeline = {
      enqueue: vi.fn(),
    } as unknown as BlockReplyPipelineLike;

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

    await handler({ text: "\n\n  Hello from stream" });

    expect(blockReplyPipeline.enqueue).toHaveBeenCalledWith({
      text: "Hello from stream",
      mediaUrl: undefined,
      replyToId: undefined,
      replyToCurrent: undefined,
      replyToTag: undefined,
      audioAsVoice: false,
      mediaUrls: undefined,
    });
  });

  it("parses media directives in block replies before path normalization", () => {
    const normalized = normalizeReplyPayloadDirectives({
      payload: { text: "Result\nMEDIA: ./image.png" },
      trimLeadingWhitespace: true,
      parseMode: "auto",
    });

    expect(normalized.payload).toMatchObject({
      text: "Result",
      mediaUrl: "./image.png",
      mediaUrls: ["./image.png"],
    });
  });

  it("passes normalized media block replies through media path normalization", async () => {
    const blockReplyPipeline = {
      enqueue: vi.fn(),
    } as unknown as BlockReplyPipelineLike;
    const absPath = path.join("/tmp/home", "openclaw", "image.png");

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply: vi.fn(async () => {}),
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      normalizeMediaPaths: async (payload) => ({
        ...payload,
        mediaUrl: absPath,
        mediaUrls: [absPath],
      }),
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
      blockStreamingEnabled: true,
      blockReplyPipeline,
      directlySentBlockKeys: new Set(),
    });

    await handler({ text: "Result\nMEDIA: ./image.png" });

    expect(blockReplyPipeline.enqueue).toHaveBeenCalledWith({
      text: "Result",
      mediaUrl: absPath,
      mediaUrls: [absPath],
      replyToId: undefined,
      replyToCurrent: false,
      replyToTag: false,
      audioAsVoice: false,
    });
  });
});
