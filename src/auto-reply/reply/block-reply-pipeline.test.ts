import { describe, expect, it } from "vitest";
import { createBlockReplyPipeline, createBlockReplyPayloadKey } from "./block-reply-pipeline.js";

describe("createBlockReplyPipeline", () => {
  it("tracks delivery success in sentKeys and didStream", async () => {
    const delivered: string[] = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "first" });
    pipeline.enqueue({ text: "second" });
    await pipeline.flush({ force: true });

    expect(delivered).toEqual(["first", "second"]);
    expect(pipeline.didStream()).toBe(true);
    expect(pipeline.isAborted()).toBe(false);
    expect(pipeline.hasSentPayload({ text: "first" })).toBe(true);
    expect(pipeline.hasSentPayload({ text: "second" })).toBe(true);
  });

  it("does not mark payload as sent when delivery fails", async () => {
    const delivered: string[] = [];
    let callCount = 0;
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        callCount++;
        if (callCount === 1) {
          // First delivery fails
          throw new Error("Telegram API error");
        }
        // Second delivery succeeds
        delivered.push(payload.text ?? "");
      },
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "first" });
    pipeline.enqueue({ text: "second" });
    await pipeline.flush({ force: true });

    // Only second was delivered
    expect(delivered).toEqual(["second"]);
    // Pipeline streamed (second succeeded)
    expect(pipeline.didStream()).toBe(true);
    expect(pipeline.isAborted()).toBe(false);
    // First was NOT sent (delivery failed) — critical for fallback to final payloads
    expect(pipeline.hasSentPayload({ text: "first" })).toBe(false);
    // Second was sent
    expect(pipeline.hasSentPayload({ text: "second" })).toBe(true);
  });

  it("didStream is false when all deliveries fail", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {
        throw new Error("Telegram API error");
      },
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "first" });
    pipeline.enqueue({ text: "second" });
    await pipeline.flush({ force: true });

    expect(pipeline.didStream()).toBe(false);
    expect(pipeline.isAborted()).toBe(false);
    expect(pipeline.hasSentPayload({ text: "first" })).toBe(false);
    expect(pipeline.hasSentPayload({ text: "second" })).toBe(false);
  });

  it("aborts on timeout and does not mark timed-out payload as sent", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {
        // Never resolves within timeout
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      },
      timeoutMs: 50,
    });

    pipeline.enqueue({ text: "first" });
    await pipeline.flush({ force: true });

    expect(pipeline.didStream()).toBe(false);
    expect(pipeline.isAborted()).toBe(true);
    expect(pipeline.hasSentPayload({ text: "first" })).toBe(false);
  });
});

describe("createBlockReplyPayloadKey", () => {
  it("normalizes text with trim", () => {
    expect(createBlockReplyPayloadKey({ text: "  hello  " })).toBe(
      createBlockReplyPayloadKey({ text: "hello" }),
    );
  });
});
