import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAudioTag } from "./audio-tags.js";
import { createBlockReplyCoalescer } from "./block-reply-coalescer.js";
import { createReplyReferencePlanner } from "./reply-reference.js";
import { createStreamingDirectiveAccumulator } from "./streaming-directives.js";

describe("parseAudioTag", () => {
  it("detects audio_as_voice and strips the tag", () => {
    const result = parseAudioTag("Hello [[audio_as_voice]] world");
    expect(result.audioAsVoice).toBe(true);
    expect(result.hadTag).toBe(true);
    expect(result.text).toBe("Hello world");
  });

  it("returns empty output for missing text", () => {
    const result = parseAudioTag(undefined);
    expect(result.audioAsVoice).toBe(false);
    expect(result.hadTag).toBe(false);
    expect(result.text).toBe("");
  });

  it("removes tag-only messages", () => {
    const result = parseAudioTag("[[audio_as_voice]]");
    expect(result.audioAsVoice).toBe(true);
    expect(result.text).toBe("");
  });
});

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

describe("createReplyReferencePlanner", () => {
  it("disables references when mode is off", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "off",
      startId: "parent",
    });
    expect(planner.use()).toBeUndefined();
    expect(planner.hasReplied()).toBe(false);
  });

  it("uses startId once when mode is first", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "first",
      startId: "parent",
    });
    expect(planner.use()).toBe("parent");
    expect(planner.hasReplied()).toBe(true);
    planner.markSent();
    expect(planner.use()).toBeUndefined();
  });

  it("returns startId for every call when mode is all", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "all",
      startId: "parent",
    });
    expect(planner.use()).toBe("parent");
    expect(planner.use()).toBe("parent");
  });

  it("prefers existing thread id regardless of mode", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "off",
      existingId: "thread-1",
      startId: "parent",
    });
    expect(planner.use()).toBe("thread-1");
    expect(planner.hasReplied()).toBe(true);
  });

  it("honors allowReference=false", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "all",
      startId: "parent",
      allowReference: false,
    });
    expect(planner.use()).toBeUndefined();
    expect(planner.hasReplied()).toBe(false);
    planner.markSent();
    expect(planner.hasReplied()).toBe(true);
  });
});

describe("createStreamingDirectiveAccumulator", () => {
  it("stashes reply_to_current until a renderable chunk arrives", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    expect(accumulator.consume("[[reply_to_current]]")).toBeNull();

    const result = accumulator.consume("Hello");
    expect(result?.text).toBe("Hello");
    expect(result?.replyToCurrent).toBe(true);
    expect(result?.replyToTag).toBe(true);
  });

  it("handles reply tags split across chunks", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    expect(accumulator.consume("[[reply_to_")).toBeNull();

    const result = accumulator.consume("current]] Yo");
    expect(result?.text).toBe("Yo");
    expect(result?.replyToCurrent).toBe(true);
    expect(result?.replyToTag).toBe(true);
  });

  it("propagates explicit reply ids across chunks", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    expect(accumulator.consume("[[reply_to: abc-123]]")).toBeNull();

    const result = accumulator.consume("Hi");
    expect(result?.text).toBe("Hi");
    expect(result?.replyToId).toBe("abc-123");
    expect(result?.replyToTag).toBe(true);
  });
});
