import { describe, expect, it, vi } from "vitest";
import { createBlockReplyPayloadKey, createBlockReplyPipeline } from "./block-reply-pipeline.js";

describe("BlockReplyPipeline.hasAttemptedPayload", () => {
  it("returns true for payloads attempted before pipeline abort", async () => {
    const onBlockReply = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 5_000)));

    const pipeline = createBlockReplyPipeline({
      onBlockReply,
      timeoutMs: 50,
    });

    pipeline.enqueue({ text: "hello" });

    // Wait for the timeout to trigger abort
    await pipeline.flush({ force: true });

    expect(pipeline.isAborted()).toBe(true);
    expect(pipeline.hasSentPayload({ text: "hello" })).toBe(false);
    expect(pipeline.hasAttemptedPayload({ text: "hello" })).toBe(true);
  });

  it("returns false for payloads never attempted", () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: vi.fn(),
      timeoutMs: 15_000,
    });

    expect(pipeline.hasAttemptedPayload({ text: "never seen" })).toBe(false);
  });

  it("keeps queued tail payloads eligible for final fallback after abort", async () => {
    const onBlockReply = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 5_000)));

    const pipeline = createBlockReplyPipeline({
      onBlockReply,
      timeoutMs: 50,
    });

    pipeline.enqueue({ text: "first" });
    pipeline.enqueue({ text: "second" });

    await pipeline.flush({ force: true });

    expect(pipeline.isAborted()).toBe(true);
    expect(pipeline.hasAttemptedPayload({ text: "first" })).toBe(true);
    expect(pipeline.hasAttemptedPayload({ text: "second" })).toBe(false);
    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("returns true for successfully sent payloads", async () => {
    const onBlockReply = vi.fn().mockResolvedValue(undefined);

    const pipeline = createBlockReplyPipeline({
      onBlockReply,
      timeoutMs: 15_000,
    });

    pipeline.enqueue({ text: "sent ok" });
    await pipeline.flush({ force: true });

    expect(pipeline.isAborted()).toBe(false);
    expect(pipeline.hasSentPayload({ text: "sent ok" })).toBe(true);
    expect(pipeline.hasAttemptedPayload({ text: "sent ok" })).toBe(true);
  });

  it("keeps reply targets distinct in payload key deduplication", () => {
    const keyA = createBlockReplyPayloadKey({ text: "same", replyToId: "111" });
    const keyB = createBlockReplyPayloadKey({ text: "same", replyToId: "222" });

    expect(keyA).not.toBe(keyB);
  });
});
