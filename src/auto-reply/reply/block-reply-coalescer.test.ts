/** Tests block reply coalescer edge cases: abort race, stop flush, and logging. */
import { describe, expect, it, vi } from "vitest";
import { createBlockReplyCoalescer } from "./block-reply-coalescer.js";

describe("createBlockReplyCoalescer", () => {
  it("flushes buffered text when force=true even if shouldAbort is true", async () => {
    const onFlush = vi.fn();
    let aborted = false;
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 800, maxChars: 2000, idleMs: 1000, joiner: "", },
      shouldAbort: () => aborted,
      onFlush,
    });

    // Enqueue a small tail (under minChars)
    coalescer.enqueue({ text: "This is the tail that should not be lost" });

    // Simulate: during streaming, a previous block times out → abort flag set
    aborted = true;

    // flush with force:true — should send even though shouldAbort is true
    await coalescer.flush({ force: true });

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "This is the tail that should not be lost",
      }),
    );
  });

  it("stop() flushes buffered text before clearing the idle timer", async () => {
    const onFlush = vi.fn();
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 800, maxChars: 2000, idleMs: 1000, joiner: "", },
      shouldAbort: () => false,
      onFlush,
    });

    // Enqueue a small tail (under minChars)
    coalescer.enqueue({ text: "Buffered tail to be flushed on stop" });

    // stop should flush the buffered text before clearing
    coalescer.stop();

    // Wait for the flush promise to resolve
    await new Promise((resolve) => { setImmediate(resolve); });

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Buffered tail to be flushed on stop",
      }),
    );
  });

  it("flush({force:false}) with buffer under minChars reschedules idle flush (default behavior preserved)", async () => {
    const onFlush = vi.fn();
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 800, maxChars: 2000, idleMs: 50, joiner: "", },
      shouldAbort: () => false,
      onFlush,
    });

    coalescer.enqueue({ text: "Small text" });

    // Non-force flush with buffer under minChars should not send
    // (it reschedules the idle timer instead)
    await coalescer.flush({ force: false });

    expect(onFlush).not.toHaveBeenCalled();

    // After idleMs, the idle timer should fire and try again
    // but since buffer is still under minChars and not force, it won't send
    await new Promise((resolve) => { setTimeout(resolve, 60); });

    // Still not sent because sub-minChars non-force flush reschedules
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("flush({force:true}) sends buffer even when under minChars", async () => {
    const onFlush = vi.fn();
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 800, maxChars: 2000, idleMs: 1000, joiner: "", },
      shouldAbort: () => false,
      onFlush,
    });

    coalescer.enqueue({ text: "Small but forced text" });

    // Force flush should bypass minChars check
    await coalescer.flush({ force: true });

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Small but forced text",
      }),
    );
  });

  it("hasBuffered returns true after enqueue with text under minChars", () => {
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 800, maxChars: 2000, idleMs: 1000, joiner: "", },
      shouldAbort: () => false,
      onFlush: vi.fn(),
    });

    coalescer.enqueue({ text: "Small" });
    expect(coalescer.hasBuffered()).toBe(true);
  });

  it("hasBuffered returns false after stop flushes the buffer", async () => {
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 800, maxChars: 2000, idleMs: 1000, joiner: "", },
      shouldAbort: () => false,
      onFlush: vi.fn(),
    });

    coalescer.enqueue({ text: "Small tail" });
    expect(coalescer.hasBuffered()).toBe(true);

    coalescer.stop();

    // Wait for flush promise (fire-and-forget from stop)
    await new Promise((resolve) => { setImmediate(resolve); });

    expect(coalescer.hasBuffered()).toBe(false);
  });

  it("multiple enqueues with accumulated text >= maxChars triggers immediate flush", async () => {
    const onFlush = vi.fn();
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 10, maxChars: 50, idleMs: 1000, joiner: "", },
      shouldAbort: () => false,
      onFlush,
    });

    // Each enqueue accumulates; the 6th one should push over maxChars=50
    coalescer.enqueue({ text: "Hello " });   // 6 chars → buffer
    coalescer.enqueue({ text: "world " });    // 13 chars → buffer
    coalescer.enqueue({ text: "this " });     // 19 chars → buffer
    coalescer.enqueue({ text: "is " });       // 23 chars → buffer
    coalescer.enqueue({ text: "a test" });    // 30 chars → buffer

    // Not flushed yet since 30 < 50
    expect(onFlush).not.toHaveBeenCalled();

    // This should exceed maxChars
    coalescer.enqueue({ text: " and more text to push over the limit!" });

    // Should have flushed the first batch and buffered the new text
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(onFlush).toHaveBeenCalled();
    const firstCall = onFlush.mock.calls[0]?.[0]?.text ?? "";
    expect(firstCall).toContain("Hello");
    expect(firstCall).toContain("a test");
  });

  it("abort without force discards buffer and onFlush is not called", async () => {
    const onFlush = vi.fn();
    let aborted = false;
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 10, maxChars: 2000, idleMs: 1000, joiner: "", },
      shouldAbort: () => aborted,
      onFlush,
    });

    coalescer.enqueue({ text: "This text will be discarded on abort" });
    aborted = true;

    // Non-force flush with abort → buffer should be reset
    await coalescer.flush();

    expect(onFlush).not.toHaveBeenCalled();
    expect(coalescer.hasBuffered()).toBe(false);
  });

  it("full pipeline simulation: tail text is preserved across finalization", async () => {
    // Simulates the real gateway pipeline scenario from issue #102578
    const sentPayloads: Array<{ text: string }> = [];
    const onBlockReply = vi.fn().mockImplementation(async (payload) => {
      sentPayloads.push(payload);
    });

    // Recreate the pipeline behavior: create coalescer with typical Telegram block config
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 800, maxChars: 2000, idleMs: 1000, joiner: "", },
      shouldAbort: () => false,
      onFlush: (payload) => {
        onBlockReply(payload);
      },
    });

    // 1. Stream a few large blocks that accumulate but don't exceed maxChars
    coalescer.enqueue({ text: "A".repeat(1000) });
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(coalescer.hasBuffered()).toBe(true);

    // 2. Add a tail that should be flushed on finalization
    coalescer.enqueue({ text: "The critical tail text" });
    // The buffer now has 1000 + len("The critical tail text") = 1021 chars
    // Still under maxChars=2000, so no auto-flush

    // 3. Simulate finalization: flush({force:true}) then stop()
    await coalescer.flush({ force: true });
    coalescer.stop();

    // The accumulated text should have been sent in one or more flushes
    await new Promise((resolve) => { setImmediate(resolve); });
    const allText = sentPayloads.map((p) => p.text).join("");
    expect(allText).toContain("The critical tail text");
    expect(allText).toContain("A".repeat(1000));
  });
});