/** Tests block reply pipeline buffering, dedupe, and final flush behavior. */
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";

const waitForAbort = (signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (!signal || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createBlockReplyPipeline dedup with threading", () => {
  it("keeps an un-aborted delivery signal when timeouts are disabled", async () => {
    let deliverySignal: AbortSignal | undefined;
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (_payload, options) => {
        deliverySignal = options?.abortSignal;
      },
      timeoutMs: 0,
    });

    pipeline.enqueue({ text: "response text" });
    await pipeline.flush({ force: true });

    expect(deliverySignal).toBeDefined();
    expect(deliverySignal?.aborted).toBe(false);
  });

  it.each([{ lane: "commentary", payload: { text: "Same answer", isCommentary: true } }])(
    "keeps $lane separate from a matching visible answer",
    async ({ payload }) => {
      for (const coalescing of [
        undefined,
        { minChars: 100, maxChars: 200, idleMs: 0, joiner: " " },
      ]) {
        const sent: ReplyPayload[] = [];
        const pipeline = createBlockReplyPipeline({
          onBlockReply: async (reply) => {
            sent.push(reply);
          },
          timeoutMs: 5000,
          ...(coalescing ? { coalescing } : {}),
        });

        pipeline.enqueue(payload);
        pipeline.enqueue({ text: "Same answer" });
        await pipeline.flush({ force: true });

        expect(sent).toEqual([payload, { text: "Same answer" }]);
        expect(pipeline.didStreamTerminalReply?.()).toBe(true);
      }
    },
  );

  it.each([
    {
      name: "coalesced text on both sides of audio",
      payloads: [{ text: "Before" }, { mediaUrl: "file:///voice.ogg" }, { text: "After" }],
      expected: [{ text: "Before" }, { mediaUrl: "file:///voice.ogg" }, { text: "After" }],
    },
    {
      name: "a late voice marker before following text",
      payloads: [{ mediaUrl: "file:///voice.ogg" }, { text: "After", audioAsVoice: true }],
      expected: [
        { mediaUrl: "file:///voice.ogg", audioAsVoice: true },
        { text: "After", audioAsVoice: true },
      ],
    },
    {
      name: "distinct portable location replies",
      payloads: [
        { location: { latitude: 1, longitude: 2 } },
        { location: { latitude: 3, longitude: 4 } },
      ],
      expected: [
        { location: { latitude: 1, longitude: 2 } },
        { location: { latitude: 3, longitude: 4 } },
      ],
    },
  ])("preserves streamed delivery order for $name", async ({ payloads, expected }) => {
    const sent: ReplyPayload[] = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        sent.push(payload);
      },
      timeoutMs: 5000,
      coalescing: {
        minChars: 1,
        maxChars: 200,
        idleMs: 0,
        joiner: " ",
      },
      isAudioPayload: (payload) =>
        [payload.mediaUrl, ...(payload.mediaUrls ?? [])].some((url) => url?.endsWith(".ogg")),
    });

    for (const payload of payloads) {
      pipeline.enqueue(payload);
    }
    await pipeline.flush({ force: true });

    expect(sent).toHaveLength(expected.length);
    expect(sent).toMatchObject(expected);
    expect(pipeline.getSentMediaUrls()).toEqual(
      Array.from(
        new Set(
          expected.flatMap((payload) =>
            "mediaUrls" in payload
              ? payload.mediaUrls
              : "mediaUrl" in payload
                ? [payload.mediaUrl]
                : [],
          ),
        ),
      ),
    );
  });

  it.each([
    { name: "reply-to-current media", routing: { replyToCurrent: true }, media: true },
  ] as const)(
    "preserves explicit reply routing and metadata for $name",
    async ({ routing, media }) => {
      const sent: ReplyPayload[] = [];
      const pipeline = createBlockReplyPipeline({
        onBlockReply: async (payload) => {
          sent.push(payload);
        },
        timeoutMs: 5000,
        coalescing: { minChars: 1, maxChars: 200, idleMs: 0, joiner: " " },
      });

      pipeline.enqueue(
        setReplyPayloadMetadata(
          { text: "Explicit answer", replyToId: "100", ...routing },
          { assistantMessageIndex: 7, replyToIdExplicit: true },
        ),
      );
      if (media) {
        pipeline.enqueue(
          setReplyPayloadMetadata(
            {
              mediaUrls: ["file:///photo.png"],
              replyToId: "100",
              replyToCurrent: undefined,
              replyToTag: undefined,
            },
            { assistantMessageIndex: 7, assistantTranscriptMediaUrls: ["file:///photo.png"] },
          ),
        );
      }
      await pipeline.flush({ force: true });

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        text: "Explicit answer",
        replyToId: "100",
        ...routing,
        ...(media ? { mediaUrls: ["file:///photo.png"] } : {}),
      });
      expect(sent.map(getReplyPayloadMetadata)).toEqual([
        expect.objectContaining({
          assistantMessageIndex: 7,
          replyToIdExplicit: true,
          ...(media ? { assistantTranscriptMediaUrls: ["file:///photo.png"] } : {}),
        }),
      ]);
    },
  );

  it("keeps media separate across assistant message boundaries", async () => {
    const sent: Array<{ text?: string; mediaUrls?: string[] }> = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        sent.push({ text: payload.text, mediaUrls: payload.mediaUrls });
      },
      timeoutMs: 5000,
      coalescing: {
        minChars: 1,
        maxChars: 200,
        idleMs: 0,
        joiner: " ",
      },
    });

    pipeline.enqueue(
      setReplyPayloadMetadata({ text: "First block" }, { assistantMessageIndex: 0 }),
    );
    pipeline.enqueue(
      setReplyPayloadMetadata({ mediaUrls: ["file:///photo.png"] }, { assistantMessageIndex: 1 }),
    );
    await pipeline.flush({ force: true });

    expect(sent).toEqual([
      { text: "First block", mediaUrls: undefined },
      { text: undefined, mediaUrls: ["file:///photo.png"] },
    ]);
  });

  it("preserves assistant metadata on coalesced text flushes", async () => {
    const sent: Array<{ assistantMessageIndex?: number; text?: string }> = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        sent.push({
          assistantMessageIndex: getReplyPayloadMetadata(payload)?.assistantMessageIndex,
          text: payload.text,
        });
      },
      timeoutMs: 5000,
      coalescing: {
        minChars: 100,
        maxChars: 200,
        idleMs: 1000,
        joiner: " ",
      },
    });

    pipeline.enqueue(setReplyPayloadMetadata({ text: "Alpha" }, { assistantMessageIndex: 0 }));
    pipeline.enqueue(setReplyPayloadMetadata({ text: "Beta" }, { assistantMessageIndex: 0 }));
    await pipeline.flush({ force: true });

    expect(sent).toEqual([{ assistantMessageIndex: 0, text: "Alpha Beta" }]);
  });
});

describe("createBlockReplyPipeline content coverage dedup", () => {
  it.each([true])(
    "deduplicates source ranges while preserving identical adjacent chunks (coalescing=%s)",
    async (coalescing) => {
      const sent: ReplyPayload[] = [];
      const pipeline = createBlockReplyPipeline({
        onBlockReply: async (payload) => {
          sent.push(payload);
        },
        timeoutMs: 5000,
        ...(coalescing
          ? { coalescing: { minChars: 100, maxChars: 200, idleMs: 0, joiner: "" } }
          : {}),
      });
      const sourceChunk = (range: readonly [number, number]) =>
        setReplyPayloadMetadata(
          { text: "aaa" },
          { assistantMessageIndex: 1, blockSourceText: "aaa", blockSourceRange: range },
        );

      pipeline.enqueue(sourceChunk([0, 3]));
      pipeline.enqueue(sourceChunk([3, 6]));
      pipeline.enqueue(sourceChunk([0, 3]));
      pipeline.enqueue(
        setReplyPayloadMetadata(
          { text: "bbb" },
          { assistantMessageIndex: 1, blockSourceText: "bbb", blockSourceRange: [0, 3] },
        ),
      );
      await pipeline.flush({ force: true });

      expect(sent.map((payload) => payload.text)).toEqual(
        coalescing ? ["aaaaaabbb"] : ["aaa", "aaa", "bbb"],
      );
    },
  );

  it.each([false])(
    "deduplicates an unkeyed replay after a source occurrence (coalescing=%s)",
    async (coalescing) => {
      const sent: ReplyPayload[] = [];
      const pipeline = createBlockReplyPipeline({
        onBlockReply: async (payload) => {
          sent.push(payload);
        },
        timeoutMs: 5000,
        ...(coalescing
          ? { coalescing: { minChars: 100, maxChars: 200, idleMs: 0, joiner: "" } }
          : {}),
      });

      pipeline.enqueue(
        setReplyPayloadMetadata(
          { text: "unchanged" },
          {
            assistantMessageIndex: 1,
            blockSourceText: "unchanged",
            blockSourceRange: [0, 9],
          },
        ),
      );
      await pipeline.flush({ force: true });
      pipeline.enqueue(
        setReplyPayloadMetadata({ text: "unchanged" }, { assistantMessageIndex: 1 }),
      );
      await pipeline.flush({ force: true });

      expect(sent.map((payload) => payload.text)).toEqual(["unchanged"]);
    },
  );

  it.each([true])(
    "recognizes delivered source through synthetic fence wrappers (coalescing=%s)",
    async (coalescing) => {
      const sent: ReplyPayload[] = [];
      const pipeline = createBlockReplyPipeline({
        onBlockReply: async (payload) => {
          sent.push(payload);
        },
        timeoutMs: 5000,
        ...(coalescing
          ? { coalescing: { minChars: 100, maxChars: 200, idleMs: 0, joiner: "\n\n" } }
          : {}),
      });
      const first = "```ts\nconst x = \n```";
      const second = "```ts\n1;\n```";
      const final = setReplyPayloadMetadata(
        { text: "```ts\nconst x = 1;\n```" },
        { assistantMessageIndex: 7 },
      );
      pipeline.enqueue(
        setReplyPayloadMetadata(
          { text: first },
          { assistantMessageIndex: 7, blockSourceText: "```ts\nconst x = " },
        ),
      );
      pipeline.enqueue(
        setReplyPayloadMetadata(
          { text: second },
          { assistantMessageIndex: 7, blockSourceText: "1;\n```" },
        ),
      );
      expect(pipeline.hasSentPayload(final)).toBe(false);

      await pipeline.flush({ force: true });

      expect(sent.map((payload) => payload.text)).toEqual(
        coalescing ? [`${first}\n\n${second}`] : [first, second],
      );
      expect(pipeline.hasSentPayload(final)).toBe(true);
      expect(pipeline.hasSentExactPayload?.(final)).toBe(false);
      expect(
        pipeline.hasSentPayload(
          setReplyPayloadMetadata({ ...final }, { assistantMessageIndex: 8 }),
        ),
      ).toBe(false);
      expect(pipeline.hasSentPayload({ text: "```ts\nconst x = 2;\n```" })).toBe(false);
    },
  );

  it("merges source coverage through ordinary text and a media continuation", async () => {
    const sent: ReplyPayload[] = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        sent.push(payload);
      },
      timeoutMs: 5000,
      coalescing: { minChars: 100, maxChars: 200, idleMs: 0, joiner: "\n\n" },
    });
    pipeline.enqueue({ text: "Example:" });
    pipeline.enqueue(
      setReplyPayloadMetadata(
        { text: "```ts\nconst x = \n```" },
        { blockSourceText: "```ts\nconst x = " },
      ),
    );
    pipeline.enqueue(
      setReplyPayloadMetadata(
        { text: "```ts\n1;\n```", mediaUrl: "file:///example.png" },
        { blockSourceText: "1;\n```" },
      ),
    );
    await pipeline.flush({ force: true });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      text: "Example:\n\n```ts\nconst x = \n```\n\n```ts\n1;\n```",
      mediaUrl: "file:///example.png",
    });
    expect(pipeline.hasSentPayload({ text: "Example:\n```ts\nconst x = 1;\n```" })).toBe(true);
    expect(pipeline.getSentMediaUrls()).toEqual(["file:///example.png"]);
  });

  it("does not credit removed source text when merging a media-only reply", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
      coalescing: { minChars: 100, maxChars: 200, idleMs: 0, joiner: "\n\n" },
    });
    pipeline.enqueue(
      setReplyPayloadMetadata(
        { text: "```ts\nconst x = 1;\n```" },
        { blockSourceText: "```ts\nconst x = 1;\n```" },
      ),
    );
    pipeline.enqueue(
      setReplyPayloadMetadata(
        { mediaUrl: "file:///example.png" },
        { blockSourceText: "withdrawn source" },
      ),
    );
    await pipeline.flush({ force: true });

    expect(pipeline.hasSentPayload({ text: "```ts\nconst x = 1;\n```" })).toBe(true);
    expect(pipeline.hasSentPayload({ text: "```ts\nconst x = 1;\n```withdrawn source" })).toBe(
      false,
    );
  });

  it("matches final assembled text to successfully streamed text chunks after abort", async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (_payload, options) => {
        callCount += 1;
        if (callCount === 3) {
          await waitForAbort(options?.abortSignal);
        }
      },
      timeoutMs: 1,
    });

    pipeline.enqueue({ text: "First paragraph." });
    pipeline.enqueue({ text: "Second paragraph." });
    pipeline.enqueue({ text: "Third paragraph." });
    const flushing = pipeline.flush({ force: true });
    await vi.advanceTimersByTimeAsync(1);
    await flushing;

    expect(pipeline.didStream()).toBe(true);
    expect(pipeline.isAborted()).toBe(true);
    expect(pipeline.hasSentPayload({ text: "First paragraph.\n\nSecond paragraph." })).toBe(true);
    expect(
      pipeline.hasSentPayload({
        text: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
      }),
    ).toBe(false);
  });

  it.each([{ lane: "commentary", payload: { text: "Same answer", isCommentary: true } }])(
    "keeps $lane out of visible final-content accounting",
    async ({ payload }) => {
      const pipeline = createBlockReplyPipeline({
        onBlockReply: async () => {},
        timeoutMs: 5000,
      });

      pipeline.enqueue(payload);
      await pipeline.flush({ force: true });

      expect(pipeline.didStream()).toBe(true);
      expect(pipeline.didStreamTerminalReply?.()).toBe(false);
      expect(pipeline.hasSentPayload({ text: "Same answer" })).toBe(false);
      expect(pipeline.hasSentExactPayload?.({ text: "Same answer" })).toBe(false);
    },
  );

  it("does not let a status notice de-dupe later matching assistant content", async () => {
    const sent: Array<{ text?: string; isStatusNotice?: boolean }> = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        sent.push({ text: payload.text, isStatusNotice: payload.isStatusNotice });
      },
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "same text", isStatusNotice: true });
    pipeline.enqueue({ text: "same text" });
    await pipeline.flush({ force: true });

    expect(sent).toEqual([{ text: "same text", isStatusNotice: true }, { text: "same text" }]);
    expect(pipeline.didStream()).toBe(true);
    expect(pipeline.hasSentPayload({ text: "same text" })).toBe(true);
  });

  it("does not suppress media payloads through streamed text coverage", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "Description" });
    await pipeline.flush({ force: true });

    expect(pipeline.hasSentPayload({ text: "Description", mediaUrl: "file:///photo.jpg" })).toBe(
      false,
    );
  });

  it("clamps oversized delivery timeouts before arming timers", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const observedTimeouts: number[] = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (_payload, options) => {
        observedTimeouts.push(options?.timeoutMs ?? 0);
        await waitForAbort(options?.abortSignal);
      },
      timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
    });

    pipeline.enqueue({ text: "slow block" });
    const flushing = pipeline.flush({ force: true });
    await Promise.resolve();

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    expect(observedTimeouts).toEqual([MAX_TIMER_TIMEOUT_MS]);

    await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
    await flushing;

    expect(pipeline.isAborted()).toBe(true);
    setTimeoutSpy.mockRestore();
  });
});
