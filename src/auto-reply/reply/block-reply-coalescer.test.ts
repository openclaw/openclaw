import { describe, expect, it, vi } from "vitest";
import { createBlockReplyCoalescer } from "./block-reply-coalescer.js";

function makeConfig(overrides = {}) {
  return {
    minChars: 10,
    maxChars: 100,
    idleMs: 0,
    joiner: "",
    flushOnEnqueue: false,
    ...overrides,
  };
}

describe("createBlockReplyCoalescer", () => {
  it("buffers text below minChars", () => {
    const onFlush = vi.fn();
    const coalescer = createBlockReplyCoalescer({
      config: makeConfig({ minChars: 20 }),
      shouldAbort: () => false,
      onFlush,
    });
    coalescer.enqueue({ text: "short" });
    expect(coalescer.hasBuffered()).toBe(true);
    expect(onFlush).not.toHaveBeenCalled();
    coalescer.stop();
  });

  it("flushes when buffer exceeds maxChars", async () => {
    const onFlush = vi.fn();
    const coalescer = createBlockReplyCoalescer({
      config: makeConfig({ minChars: 1, maxChars: 10 }),
      shouldAbort: () => false,
      onFlush,
    });
    coalescer.enqueue({ text: "a".repeat(15) });
    // Large payload flushed directly
    expect(onFlush).toHaveBeenCalled();
    coalescer.stop();
  });

  it("force flush sends buffered text", async () => {
    const onFlush = vi.fn();
    const coalescer = createBlockReplyCoalescer({
      config: makeConfig({ minChars: 100 }),
      shouldAbort: () => false,
      onFlush,
    });
    coalescer.enqueue({ text: "buffered" });
    await coalescer.flush({ force: true });
    expect(onFlush).toHaveBeenCalledWith(expect.objectContaining({ text: "buffered" }));
    expect(coalescer.hasBuffered()).toBe(false);
    coalescer.stop();
  });

  it("media payloads bypass coalescing", () => {
    const onFlush = vi.fn();
    const coalescer = createBlockReplyCoalescer({
      config: makeConfig(),
      shouldAbort: () => false,
      onFlush,
    });
    coalescer.enqueue({ text: "caption", mediaUrl: "http://img.png" });
    expect(onFlush).toHaveBeenCalled();
    coalescer.stop();
  });

  it("skips enqueue when aborted", () => {
    const onFlush = vi.fn();
    const coalescer = createBlockReplyCoalescer({
      config: makeConfig(),
      shouldAbort: () => true,
      onFlush,
    });
    coalescer.enqueue({ text: "should not buffer" });
    expect(coalescer.hasBuffered()).toBe(false);
    expect(onFlush).not.toHaveBeenCalled();
    coalescer.stop();
  });

  it("uses joiner between concatenated texts", async () => {
    const onFlush = vi.fn();
    const coalescer = createBlockReplyCoalescer({
      config: makeConfig({ minChars: 1, maxChars: 200, joiner: "\n" }),
      shouldAbort: () => false,
      onFlush,
    });
    coalescer.enqueue({ text: "line1" });
    coalescer.enqueue({ text: "line2" });
    await coalescer.flush({ force: true });
    expect(onFlush).toHaveBeenCalledWith(expect.objectContaining({ text: "line1\nline2" }));
    coalescer.stop();
  });

  it("flushOnEnqueue sends each payload separately", () => {
    const onFlush = vi.fn();
    const coalescer = createBlockReplyCoalescer({
      config: makeConfig({ flushOnEnqueue: true, minChars: 1 }),
      shouldAbort: () => false,
      onFlush,
    });
    coalescer.enqueue({ text: "first" });
    coalescer.enqueue({ text: "second" });
    expect(onFlush).toHaveBeenCalledTimes(2);
    coalescer.stop();
  });

  it("ignores empty text", () => {
    const onFlush = vi.fn();
    const coalescer = createBlockReplyCoalescer({
      config: makeConfig(),
      shouldAbort: () => false,
      onFlush,
    });
    coalescer.enqueue({ text: "" });
    coalescer.enqueue({ text: "   " });
    expect(coalescer.hasBuffered()).toBe(false);
    expect(onFlush).not.toHaveBeenCalled();
    coalescer.stop();
  });
});
