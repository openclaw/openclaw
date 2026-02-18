import { describe, expect, it, vi } from "vitest";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";

describe("BlockReplyPipeline.hasEnqueuedPayload", () => {
  it("returns true for payloads enqueued before pipeline abort", async () => {
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
    expect(pipeline.hasEnqueuedPayload({ text: "hello" })).toBe(true);
  });

  it("returns false for payloads never enqueued", () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: vi.fn(),
      timeoutMs: 15_000,
    });

    expect(pipeline.hasEnqueuedPayload({ text: "never seen" })).toBe(false);
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
    expect(pipeline.hasEnqueuedPayload({ text: "sent ok" })).toBe(true);
  });
});
