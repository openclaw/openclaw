import { describe, expect, it } from "vitest";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import {
  createBlockReplyContentKey,
  createBlockReplyPayloadKey,
  createBlockReplyPipeline,
} from "./block-reply-pipeline.js";

describe("createBlockReplyPayloadKey", () => {
  it("produces different keys for payloads differing only by replyToId", () => {
    const a = createBlockReplyPayloadKey({ text: "hello world", replyToId: "post-1" });
    const b = createBlockReplyPayloadKey({ text: "hello world", replyToId: "post-2" });
    const c = createBlockReplyPayloadKey({ text: "hello world" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("produces different keys for payloads with different text", () => {
    const a = createBlockReplyPayloadKey({ text: "hello" });
    const b = createBlockReplyPayloadKey({ text: "world" });
    expect(a).not.toBe(b);
  });

  it("produces different keys for payloads with different media", () => {
    const a = createBlockReplyPayloadKey({ text: "hello", mediaUrl: "file:///a.png" });
    const b = createBlockReplyPayloadKey({ text: "hello", mediaUrl: "file:///b.png" });
    expect(a).not.toBe(b);
  });

  it("trims whitespace from text for key comparison", () => {
    const a = createBlockReplyPayloadKey({ text: "  hello  " });
    const b = createBlockReplyPayloadKey({ text: "hello" });
    expect(a).toBe(b);
  });
});

describe("createBlockReplyContentKey", () => {
  it("produces the same key for payloads differing only by replyToId", () => {
    const a = createBlockReplyContentKey({ text: "hello world", replyToId: "post-1" });
    const b = createBlockReplyContentKey({ text: "hello world", replyToId: "post-2" });
    const c = createBlockReplyContentKey({ text: "hello world" });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });
});

describe("createBlockReplyPipeline dedup with threading", () => {
  it("keeps separate deliveries for same text with different replyToId", async () => {
    const sent: Array<{ text?: string; replyToId?: string }> = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        sent.push({ text: payload.text, replyToId: payload.replyToId });
      },
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "response text", replyToId: "thread-root-1" });
    pipeline.enqueue({ text: "response text", replyToId: undefined });
    await pipeline.flush({ force: true });

    expect(sent).toEqual([
      { text: "response text", replyToId: "thread-root-1" },
      { text: "response text", replyToId: undefined },
    ]);
  });

  it("hasSentPayload matches regardless of replyToId", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "response text", replyToId: "thread-root-1" });
    await pipeline.flush({ force: true });

    // Final payload with no replyToId should be recognized as already sent
    expect(pipeline.hasSentPayload({ text: "response text" })).toBe(true);
    expect(pipeline.hasSentPayload({ text: "response text", replyToId: "other-id" })).toBe(true);
  });

  // Regression test for GH #65468 — duplicate MEDIA: delivery.
  // When MEDIA: appears at a streaming block boundary it is dispatched as a
  // media-only block. The same media URL is then carried in the final reply
  // text and normalised a second time, producing a duplicate attachment on
  // the wire. getSentMediaUrls() lets the final-reply path strip media that
  // was already delivered in a preceding block.
  it("getSentMediaUrls returns media URLs delivered via block pipeline", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    // Initially empty before anything is sent.
    expect(pipeline.getSentMediaUrls()).toEqual([]);

    pipeline.enqueue({ text: "caption", mediaUrl: "file:///a.ogg" });
    pipeline.enqueue({ text: "", mediaUrls: ["file:///b.ogg", "file:///c.ogg"] });
    await pipeline.flush({ force: true });

    const sent = pipeline.getSentMediaUrls();
    expect(sent).toContain("file:///a.ogg");
    expect(sent).toContain("file:///b.ogg");
    expect(sent).toContain("file:///c.ogg");
  });

  it("getSentMediaUrls stays empty when no media is delivered", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "hello" });
    pipeline.enqueue({ text: "world" });
    await pipeline.flush({ force: true });

    expect(pipeline.getSentMediaUrls()).toEqual([]);
  });

  it("does not coalesce logical assistant blocks across assistantMessageIndex boundaries", async () => {
    const sent: string[] = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        sent.push(payload.text ?? "");
      },
      timeoutMs: 5000,
      coalescing: {
        minChars: 100,
        maxChars: 200,
        idleMs: 1000,
        joiner: "\n\n",
      },
    });

    pipeline.enqueue(setReplyPayloadMetadata({ text: "Alpha" }, { assistantMessageIndex: 0 }));
    pipeline.enqueue(setReplyPayloadMetadata({ text: "Beta" }, { assistantMessageIndex: 1 }));
    await pipeline.flush({ force: true });

    expect(sent).toEqual(["Alpha", "Beta"]);
  });
});
