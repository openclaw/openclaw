// Control UI chat module tests cover stream buffer behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatStreamBuffer } from "./chat-stream-buffer";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function nextRaf(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof globalThis.requestAnimationFrame === "function") {
      const id = globalThis.requestAnimationFrame(() => resolve());
      if (typeof id === "number") {
        return;
      }
    }
    setImmediate(resolve);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    const id = ((window as unknown as Record<string, number>).__rafId ??= 0) + 1;
    (window as unknown as Record<string, number>).__rafId = id;
    setTimeout(() => cb(Date.now()), 0);
    return id;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, number>).__rafId;
});

/* ------------------------------------------------------------------ */
/*  Basic state lifecycle                                              */
/* ------------------------------------------------------------------ */

describe("ChatStreamBuffer", () => {
  it("starts with empty display text and incomplete state", () => {
    const buffer = new ChatStreamBuffer();
    expect(buffer.text).toBe("");
    expect(buffer.completed).toBe(false);
    expect(buffer.state).toEqual({ displayText: "", streamComplete: false });
  });

  it("emits display text on each animation frame", async () => {
    const buffer = new ChatStreamBuffer(4);
    buffer.enqueue("abcdef");
    expect(buffer.text).toBe("");

    await vi.advanceTimersByTimeAsync(16);
    expect(buffer.text).toBe("abcd");

    await vi.advanceTimersByTimeAsync(16);
    expect(buffer.text).toBe("abcdef");
  });

  it("marks stream complete after terminal commit", async () => {
    const buffer = new ChatStreamBuffer(2);
    buffer.enqueue("abc");
    buffer.complete();
    expect(buffer.completed).toBe(true);

    await vi.advanceTimersByTimeAsync(16);
    expect(buffer.text).toBe("ab");

    await vi.advanceTimersByTimeAsync(16);
    expect(buffer.text).toBe("abc");
  });

  it("preserves text across sendSessionKey switches", () => {
    const buffer = new ChatStreamBuffer();
    buffer.enqueue("partial");
    buffer.complete();
    expect(buffer.text).toBe("partial");
    expect(buffer.completed).toBe(true);
  });

  it("drains pending text immediately when requestAnimationFrame is unavailable", () => {
    const original = globalThis.requestAnimationFrame;
    // @ts-expect-error simulate missing rAF on next tick
    globalThis.requestAnimationFrame = undefined;
    const buffer = new ChatStreamBuffer();
    buffer.enqueue("hello");
    expect(buffer.text).toBe("hello");
    globalThis.requestAnimationFrame = original;
  });
});

/* ------------------------------------------------------------------ */
/*  Flush logic                                                        */
/* ------------------------------------------------------------------ */

describe("ChatStreamBuffer flush logic", () => {
  it("flushes full batches up to maxBatchBytes", async () => {
    const buffer = new ChatStreamBuffer(3);
    buffer.enqueue("abcde");
    await vi.advanceTimersByTimeAsync(16);
    expect(buffer.text).toBe("abc");

    await vi.advanceTimersByTimeAsync(16);
    expect(buffer.text).toBe("abcde");
  });

  it("splits large deltas across frames", async () => {
    const buffer = new ChatStreamBuffer(3);
    buffer.enqueue("abcdef");
    await vi.advanceTimersByTimeAsync(16);
    expect(buffer.text).toBe("abc");

    await vi.advanceTimersByTimeAsync(16);
    expect(buffer.text).toBe("abcdef");
  });

  it("accumulates deltas across multiple enqueue calls before flush", async () => {
    const buffer = new ChatStreamBuffer(10);
    buffer.enqueue("hel");
    buffer.enqueue("lo ");
    buffer.enqueue("world");
    expect(buffer.text).toBe("");

    await vi.advanceTimersByTimeAsync(16);
    expect(buffer.text).toBe("hello world");
  });

  it("drains remainder after terminal commit in the final frame", async () => {
    const buffer = new ChatStreamBuffer(3);
    buffer.enqueue("abcdef");
    buffer.complete();
    await vi.advanceTimersByTimeAsync(16);
    expect(buffer.text).toBe("abc");

    await vi.advanceTimersByTimeAsync(16);
    expect(buffer.text).toBe("abcdef");
  });

  it("does not flush empty deltas", async () => {
    const buffer = new ChatStreamBuffer(100);
    buffer.enqueue("");
    buffer.enqueue("   ");
    await vi.advanceTimersByTimeAsync(16);
    expect(buffer.text).toBe("");

    buffer.enqueue("x");
    await vi.advanceTimersByTimeAsync(16);
    expect(buffer.text).toBe("x");
  });
});

/* ------------------------------------------------------------------ */
/*  Reset / reuse                                                      */
/* ------------------------------------------------------------------ */

describe("ChatStreamBuffer reset", () => {
  it("clears all buffered and displayed text", async () => {
    const buffer = new ChatStreamBuffer();
    buffer.enqueue("stale");
    buffer.complete();
    await vi.advanceTimersByTimeAsync(16);
    buffer.reset();
    expect(buffer.text).toBe("");
    expect(buffer.completed).toBe(false);
    buffer.enqueue("fresh");
    await vi.advanceTimersByTimeAsync(16);
    expect(buffer.text).toBe("fresh");
  });

  it("ignores completion when terminal buffer is stale", async () => {
    const buffer = new ChatStreamBuffer();
    buffer.enqueue("delta");
    buffer.reset();
    buffer.complete();
    await vi.advanceTimersByTimeAsync(16);
    expect(buffer.text).toBe("");
  });
});
