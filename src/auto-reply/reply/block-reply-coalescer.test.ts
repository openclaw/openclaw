import { afterEach, describe, expect, it, vi } from "vitest";
import { createBlockReplyCoalescer } from "./block-reply-coalescer.js";

describe("block reply coalescer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces chunks within the idle window", async () => {
    vi.useFakeTimers();
    const flushes: string[] = [];
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 1, maxChars: 200, idleMs: 100, joiner: " " },
      shouldAbort: () => false,
      onFlush: (payload) => {
        flushes.push(payload.text ?? "");
      },
    });

    coalescer.enqueue({ text: "Hello" });
    coalescer.enqueue({ text: "world" });

    await vi.advanceTimersByTimeAsync(100);
    expect(flushes).toEqual(["Hello world"]);
    coalescer.stop();
  });

  it("waits until minChars before idle flush", async () => {
    vi.useFakeTimers();
    const flushes: string[] = [];
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 10, maxChars: 200, idleMs: 50, joiner: " " },
      shouldAbort: () => false,
      onFlush: (payload) => {
        flushes.push(payload.text ?? "");
      },
    });

    coalescer.enqueue({ text: "short" });
    await vi.advanceTimersByTimeAsync(50);
    expect(flushes).toEqual([]);

    coalescer.enqueue({ text: "message" });
    await vi.advanceTimersByTimeAsync(50);
    expect(flushes).toEqual(["short message"]);
    coalescer.stop();
  });

  it("flushes buffered text before media payloads", () => {
    const flushes: Array<{ text?: string; mediaUrls?: string[] }> = [];
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 1, maxChars: 200, idleMs: 0, joiner: " " },
      shouldAbort: () => false,
      onFlush: (payload) => {
        flushes.push({
          text: payload.text,
          mediaUrls: payload.mediaUrls,
        });
      },
    });

    coalescer.enqueue({ text: "Hello" });
    coalescer.enqueue({ text: "world" });
    coalescer.enqueue({ mediaUrls: ["https://example.com/a.png"] });
    void coalescer.flush({ force: true });

    expect(flushes[0].text).toBe("Hello world");
    expect(flushes[1].mediaUrls).toEqual(["https://example.com/a.png"]);
    coalescer.stop();
  });
});
