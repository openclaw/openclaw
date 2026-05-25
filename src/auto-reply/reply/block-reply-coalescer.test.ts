import { describe, expect, it, vi } from "vitest";
import { createBlockReplyCoalescer } from "./block-reply-coalescer.js";

describe("createBlockReplyCoalescer", () => {
  it("merges buffered text into a media payload as a single message", async () => {
    const flushed: Array<{ text?: string; mediaUrl?: string }> = [];
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 10, maxChars: 200, idleMs: 0 },
      shouldAbort: () => false,
      onFlush: async (payload) => {
        flushed.push({ text: payload.text, mediaUrl: payload.mediaUrl });
      },
    });

    coalescer.enqueue({ text: "Here is the image:" });
    coalescer.enqueue({ text: "photo.jpg", mediaUrl: "file:///photo.jpg" });
    await coalescer.flush({ force: true });

    expect(flushed).toHaveLength(1);
    expect(flushed[0].text).toBe("Here is the image:\nphoto.jpg");
    expect(flushed[0].mediaUrl).toBe("file:///photo.jpg");
  });

  it("sends media payload alone when buffer is empty", async () => {
    const flushed: Array<{ text?: string; mediaUrl?: string }> = [];
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 10, maxChars: 200, idleMs: 0 },
      shouldAbort: () => false,
      onFlush: async (payload) => {
        flushed.push({ text: payload.text, mediaUrl: payload.mediaUrl });
      },
    });

    coalescer.enqueue({ text: "photo.jpg", mediaUrl: "file:///photo.jpg" });
    await coalescer.flush({ force: true });

    expect(flushed).toHaveLength(1);
    expect(flushed[0].text).toBe("photo.jpg");
    expect(flushed[0].mediaUrl).toBe("file:///photo.jpg");
  });

  it("flushes buffered text separately when replyToId conflicts with media payload", async () => {
    const flushed: Array<{ text?: string; mediaUrl?: string; replyToId?: string }> = [];
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 10, maxChars: 200, idleMs: 0 },
      shouldAbort: () => false,
      onFlush: async (payload) => {
        flushed.push({
          text: payload.text,
          mediaUrl: payload.mediaUrl,
          replyToId: payload.replyToId,
        });
      },
    });

    coalescer.enqueue({ text: "Reply to thread A", replyToId: "thread-a" });
    coalescer.enqueue({ text: "photo.jpg", mediaUrl: "file:///photo.jpg", replyToId: "thread-b" });
    await coalescer.flush({ force: true });

    expect(flushed).toHaveLength(2);
    expect(flushed[0].text).toBe("Reply to thread A");
    expect(flushed[0].replyToId).toBe("thread-a");
    expect(flushed[1].text).toBe("photo.jpg");
    expect(flushed[1].mediaUrl).toBe("file:///photo.jpg");
    expect(flushed[1].replyToId).toBe("thread-b");
  });

  it("uses buffered text as caption when media payload has no text", async () => {
    const flushed: Array<{ text?: string; mediaUrl?: string }> = [];
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 10, maxChars: 200, idleMs: 0 },
      shouldAbort: () => false,
      onFlush: async (payload) => {
        flushed.push({ text: payload.text, mediaUrl: payload.mediaUrl });
      },
    });

    coalescer.enqueue({ text: "Look at this:" });
    coalescer.enqueue({ mediaUrl: "file:///photo.jpg" });
    await coalescer.flush({ force: true });

    expect(flushed).toHaveLength(1);
    expect(flushed[0].text).toBe("Look at this:");
    expect(flushed[0].mediaUrl).toBe("file:///photo.jpg");
  });
});
