import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlockReplyCoalescer } from "./block-reply-coalescer.js";

describe("BlockReplyCoalescer hold/resume behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not flush on idle timer when held", async () => {
    const onFlush = vi.fn();
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 1, maxChars: 1000, idleMs: 1000, joiner: "" },
      shouldAbort: () => false,
      onFlush,
    });

    // Enqueue text (starts idle timer)
    coalescer.enqueue({ text: "Hello" });
    expect(onFlush).not.toHaveBeenCalled();

    // Hold the coalescer
    coalescer.hold();

    // Advance time past idleMs
    await vi.advanceTimersByTimeAsync(1500);

    // Should NOT have flushed
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("resumes idle timer after resume()", async () => {
    const onFlush = vi.fn();
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 1, maxChars: 1000, idleMs: 1000, joiner: "" },
      shouldAbort: () => false,
      onFlush,
    });

    // Enqueue text
    coalescer.enqueue({ text: "Hello" });

    // Hold
    coalescer.hold();
    await vi.advanceTimersByTimeAsync(1500);
    expect(onFlush).not.toHaveBeenCalled();

    // Resume (should restart idle timer)
    coalescer.resume();

    // Advance time past idleMs
    await vi.advanceTimersByTimeAsync(1100);

    // Should have flushed
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith({ text: "Hello" });
  });

  it("hold clears existing idle timer", async () => {
    const onFlush = vi.fn();
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 1, maxChars: 1000, idleMs: 1000, joiner: "" },
      shouldAbort: () => false,
      onFlush,
    });

    // Enqueue text (starts idle timer)
    coalescer.enqueue({ text: "Hello" });

    // Advance partway through idle period
    await vi.advanceTimersByTimeAsync(500);

    // Hold before timer fires
    coalescer.hold();

    // Advance past original idleMs
    await vi.advanceTimersByTimeAsync(600);

    // Should NOT have flushed (timer was cleared)
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("resume with no buffered text does not schedule timer", async () => {
    const onFlush = vi.fn();
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 1, maxChars: 1000, idleMs: 1000, joiner: "" },
      shouldAbort: () => false,
      onFlush,
    });

    // Hold with no text
    coalescer.hold();

    // Resume with no buffered text
    coalescer.resume();

    // Advance time
    await vi.advanceTimersByTimeAsync(1500);

    // Should NOT have flushed (no buffered text)
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("flush with force:true works even when held", async () => {
    const onFlush = vi.fn();
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 1, maxChars: 1000, idleMs: 1000, joiner: "" },
      shouldAbort: () => false,
      onFlush,
    });

    // Enqueue text
    coalescer.enqueue({ text: "Hello" });

    // Hold
    coalescer.hold();

    // Force flush
    await coalescer.flush({ force: true });

    // Should have flushed despite being held
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith({ text: "Hello" });
  });

  it("multiple hold/resume cycles work correctly", async () => {
    const onFlush = vi.fn();
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 1, maxChars: 1000, idleMs: 1000, joiner: "" },
      shouldAbort: () => false,
      onFlush,
    });

    // First cycle
    coalescer.enqueue({ text: "First" });
    coalescer.hold();
    await vi.advanceTimersByTimeAsync(1500);
    expect(onFlush).not.toHaveBeenCalled();

    coalescer.resume();
    await vi.advanceTimersByTimeAsync(1100);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith({ text: "First" });

    // Second cycle
    onFlush.mockClear();
    coalescer.enqueue({ text: "Second" });
    coalescer.hold();
    await vi.advanceTimersByTimeAsync(1500);
    expect(onFlush).not.toHaveBeenCalled();

    coalescer.resume();
    await vi.advanceTimersByTimeAsync(1100);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith({ text: "Second" });

    // Third cycle - enqueue after hold/resume
    onFlush.mockClear();
    coalescer.hold();
    coalescer.resume();
    coalescer.enqueue({ text: "Third" });
    await vi.advanceTimersByTimeAsync(1100);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith({ text: "Third" });
  });

  it("enqueue during hold accumulates text for later flush", async () => {
    const onFlush = vi.fn();
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 1, maxChars: 1000, idleMs: 1000, joiner: "" },
      shouldAbort: () => false,
      onFlush,
    });

    // Enqueue first text
    coalescer.enqueue({ text: "text_1" });
    expect(onFlush).not.toHaveBeenCalled();

    // Hold
    coalescer.hold();

    // Enqueue second text while held
    coalescer.enqueue({ text: "text_2" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(onFlush).not.toHaveBeenCalled();

    // Resume and wait for flush
    coalescer.resume();
    await vi.advanceTimersByTimeAsync(1100);

    // Should have flushed coalesced text
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith({ text: "text_1text_2" });
  });

  it("parallel holds require matching resumes", async () => {
    const onFlush = vi.fn();
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 1, maxChars: 1000, idleMs: 1000, joiner: "" },
      shouldAbort: () => false,
      onFlush,
    });

    // Enqueue text
    coalescer.enqueue({ text: "Hello" });

    // Two parallel holds
    coalescer.hold();
    coalescer.hold();

    // First resume (holdCount=1, still held)
    coalescer.resume();
    await vi.advanceTimersByTimeAsync(1500);
    expect(onFlush).not.toHaveBeenCalled();

    // Second resume (holdCount=0, no longer held)
    coalescer.resume();
    await vi.advanceTimersByTimeAsync(1100);

    // Should have flushed after both resumes
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith({ text: "Hello" });
  });

  it("media enqueue during hold does not reset hold state", async () => {
    const onFlush = vi.fn();
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 1, maxChars: 1000, idleMs: 1000, joiner: "" },
      shouldAbort: () => false,
      onFlush,
    });

    // Enqueue text
    coalescer.enqueue({ text: "Hello" });
    expect(onFlush).not.toHaveBeenCalled();

    // Hold
    coalescer.hold();

    // Enqueue media (triggers internal force flush)
    coalescer.enqueue({ mediaUrl: "http://example.com/image.jpg" });

    // Media should have flushed text, then media
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenNthCalledWith(1, { text: "Hello" });
    expect(onFlush).toHaveBeenNthCalledWith(2, { mediaUrl: "http://example.com/image.jpg" });

    // Enqueue more text after media
    onFlush.mockClear();
    coalescer.enqueue({ text: "World" });

    // Advance time - should NOT flush because still held
    await vi.advanceTimersByTimeAsync(1500);
    expect(onFlush).not.toHaveBeenCalled();

    // Resume should allow flush
    coalescer.resume();
    await vi.advanceTimersByTimeAsync(1100);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith({ text: "World" });
  });
});
