import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBlockReplyCoalescer } from "./block-reply-coalescer.js";

describe("block-reply-coalescer channelData bypass", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createHarness() {
    const flushes: ReplyPayload[] = [];
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 1, maxChars: 200, idleMs: 100, joiner: " " },
      shouldAbort: () => false,
      onFlush: (payload) => {
        flushes.push(payload);
      },
    });
    return { flushes, coalescer };
  }

  it("immediately flushes channelData-only payload without buffering", async () => {
    const { flushes, coalescer } = createHarness();

    coalescer.enqueue({
      channelData: { line: { sticker: { packageId: "446", stickerId: "1988" } } },
    });

    expect(flushes).toHaveLength(1);
    expect(flushes[0].channelData?.line).toEqual({
      sticker: { packageId: "446", stickerId: "1988" },
    });
    coalescer.stop();
  });

  it("flushes buffered text before dispatching channelData-only payload", async () => {
    vi.useFakeTimers();
    const { flushes, coalescer } = createHarness();

    coalescer.enqueue({ text: "Hello" });
    coalescer.enqueue({
      channelData: { line: { sticker: { packageId: "446", stickerId: "1988" } } },
    });

    expect(flushes.map((p) => p.text ?? null)).toEqual(["Hello", null]);
    expect(flushes[1].channelData?.line).toEqual({
      sticker: { packageId: "446", stickerId: "1988" },
    });
    coalescer.stop();
  });

  it("does not drop channelData-only payload when text and media are absent", () => {
    const { flushes, coalescer } = createHarness();

    coalescer.enqueue({ channelData: { line: { quickReplies: ["A", "B"] } } });

    expect(flushes).toHaveLength(1);
    expect(flushes[0].channelData?.line).toEqual({ quickReplies: ["A", "B"] });
    coalescer.stop();
  });

  it("ignores empty channelData object (treats as no channelData)", () => {
    const { flushes, coalescer } = createHarness();

    coalescer.enqueue({ channelData: {} });

    expect(flushes).toHaveLength(0);
    coalescer.stop();
  });
});
