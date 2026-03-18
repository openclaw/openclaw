import { describe, expect, it, vi } from "vitest";
import {
  deliverFormattedTextWithAttachments,
  deliverTextOrMediaReply,
  isNumericTargetId,
  resolveOutboundMediaUrls,
  resolveTextChunksWithFallback,
  sendMediaWithLeadingCaption,
  sendPayloadWithChunkedTextAndMedia,
} from "./reply-payload.js";

describe("sendPayloadWithChunkedTextAndMedia", () => {
  it("returns empty result when payload has no text and no media", async () => {
    const result = await sendPayloadWithChunkedTextAndMedia({
      ctx: { payload: {} },
      sendText: async () => ({ channel: "test", messageId: "text" }),
      sendMedia: async () => ({ channel: "test", messageId: "media" }),
      emptyResult: { channel: "test", messageId: "" },
    });
    expect(result).toEqual({ channel: "test", messageId: "" });
  });

  it("sends first media with text and remaining media without text", async () => {
    const calls: Array<{ text: string; mediaUrl: string }> = [];
    const result = await sendPayloadWithChunkedTextAndMedia({
      ctx: {
        payload: { text: "hello", mediaUrls: ["https://a", "https://b"] },
      },
      sendText: async () => ({ channel: "test", messageId: "text" }),
      sendMedia: async (ctx) => {
        calls.push({ text: ctx.text, mediaUrl: ctx.mediaUrl });
        return { channel: "test", messageId: ctx.mediaUrl };
      },
      emptyResult: { channel: "test", messageId: "" },
    });
    expect(calls).toEqual([
      { text: "hello", mediaUrl: "https://a" },
      { text: "", mediaUrl: "https://b" },
    ]);
    expect(result).toEqual({ channel: "test", messageId: "https://b" });
  });

  it("chunks text and sends each chunk", async () => {
    const chunks: string[] = [];
    const result = await sendPayloadWithChunkedTextAndMedia({
      ctx: { payload: { text: "alpha beta gamma" } },
      textChunkLimit: 5,
      chunker: () => ["alpha", "beta", "gamma"],
      sendText: async (ctx) => {
        chunks.push(ctx.text);
        return { channel: "test", messageId: ctx.text };
      },
      sendMedia: async () => ({ channel: "test", messageId: "media" }),
      emptyResult: { channel: "test", messageId: "" },
    });
    expect(chunks).toEqual(["alpha", "beta", "gamma"]);
    expect(result).toEqual({ channel: "test", messageId: "gamma" });
  });

  it("detects numeric target IDs", () => {
    expect(isNumericTargetId("12345")).toBe(true);
    expect(isNumericTargetId("  987  ")).toBe(true);
    expect(isNumericTargetId("ab12")).toBe(false);
    expect(isNumericTargetId("")).toBe(false);
  });
});

describe("resolveOutboundMediaUrls", () => {
  it("prefers mediaUrls over the legacy single-media field", () => {
    expect(
      resolveOutboundMediaUrls({
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
        mediaUrl: "https://example.com/legacy.png",
      }),
    ).toEqual(["https://example.com/a.png", "https://example.com/b.png"]);
  });

  it("falls back to the legacy single-media field", () => {
    expect(
      resolveOutboundMediaUrls({
        mediaUrl: "https://example.com/legacy.png",
      }),
    ).toEqual(["https://example.com/legacy.png"]);
  });
});

describe("resolveTextChunksWithFallback", () => {
  it("returns existing chunks unchanged", () => {
    expect(resolveTextChunksWithFallback("hello", ["a", "b"])).toEqual(["a", "b"]);
  });

  it("falls back to the full text when chunkers return nothing", () => {
    expect(resolveTextChunksWithFallback("hello", [])).toEqual(["hello"]);
  });

  it("returns empty for empty text with no chunks", () => {
    expect(resolveTextChunksWithFallback("", [])).toEqual([]);
  });
});

describe("deliverTextOrMediaReply", () => {
  it("sends media first with caption only on the first attachment", async () => {
    const sendMedia = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);

    await expect(
      deliverTextOrMediaReply({
        payload: { text: "hello", mediaUrls: ["https://a", "https://b"] },
        text: "hello",
        sendText,
        sendMedia,
      }),
    ).resolves.toBe("media");

    expect(sendMedia).toHaveBeenNthCalledWith(1, {
      mediaUrl: "https://a",
      caption: "hello",
    });
    expect(sendMedia).toHaveBeenNthCalledWith(2, {
      mediaUrl: "https://b",
      caption: undefined,
    });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("falls back to chunked text delivery when there is no media", async () => {
    const sendMedia = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);

    await expect(
      deliverTextOrMediaReply({
        payload: { text: "alpha beta gamma" },
        text: "alpha beta gamma",
        chunkText: () => ["alpha", "beta", "gamma"],
        sendText,
        sendMedia,
      }),
    ).resolves.toBe("text");

    expect(sendText).toHaveBeenCalledTimes(3);
    expect(sendText).toHaveBeenNthCalledWith(1, "alpha");
    expect(sendText).toHaveBeenNthCalledWith(2, "beta");
    expect(sendText).toHaveBeenNthCalledWith(3, "gamma");
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it("returns empty when chunking produces no sendable text", async () => {
    const sendMedia = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);

    await expect(
      deliverTextOrMediaReply({
        payload: { text: "   " },
        text: "   ",
        chunkText: () => [],
        sendText,
        sendMedia,
      }),
    ).resolves.toBe("empty");

    expect(sendText).not.toHaveBeenCalled();
    expect(sendMedia).not.toHaveBeenCalled();
  });
});

describe("sendMediaWithLeadingCaption", () => {
  it("passes leading-caption metadata to async error handlers", async () => {
    const send = vi
      .fn<({ mediaUrl, caption }: { mediaUrl: string; caption?: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const onError = vi.fn(async () => undefined);

    await expect(
      sendMediaWithLeadingCaption({
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
        caption: "hello",
        send,
        onError,
      }),
    ).resolves.toBe(true);

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/a.png",
        caption: "hello",
        index: 0,
        isFirst: true,
      }),
    );
    expect(send).toHaveBeenNthCalledWith(2, {
      mediaUrl: "https://example.com/b.png",
      caption: undefined,
    });
  });
});

describe("deliverFormattedTextWithAttachments", () => {
  it("combines attachment links and forwards replyToId", async () => {
    const send = vi.fn(async () => undefined);

    await expect(
      deliverFormattedTextWithAttachments({
        payload: {
          text: "hello",
          mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
          replyToId: "r1",
        },
        send,
      }),
    ).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith({
      text: "hello\n\nAttachment: https://example.com/a.png\nAttachment: https://example.com/b.png",
      replyToId: "r1",
    });
  });
});
