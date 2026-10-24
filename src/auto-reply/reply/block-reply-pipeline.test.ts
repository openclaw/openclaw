import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayloadMetadata,
} from "../reply-payload.js";
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

afterEach(() => {
  vi.useRealTimers();
});

function capturePipeline(options: Partial<Parameters<typeof createBlockReplyPipeline>[0]> = {}) {
  const sent: ReplyPayload[] = [];
  const pipeline = createBlockReplyPipeline({
    timeoutMs: 5000,
    onBlockReply: async (payload) => {
      sent.push(payload);
    },
    ...options,
  });
  return { sent, pipeline };
}

const coalescing = { minChars: 100, maxChars: 200, idleMs: 0, joiner: "\n\n" };
const mediaCoalescing = { ...coalescing, minChars: 1, joiner: " " };
const sourceReply = (text: string, metadata: ReplyPayloadMetadata, payload: ReplyPayload = {}) =>
  setReplyPayloadMetadata({ text, ...payload }, metadata);

describe("createBlockReplyPipeline dedup with threading", () => {
  it("keeps commentary separate from a matching visible answer", async () => {
    const payload = { text: "Same answer", isCommentary: true };
    for (const config of [undefined, { ...coalescing, joiner: " " }]) {
      const { sent, pipeline } = capturePipeline({ coalescing: config });

      pipeline.enqueue(payload);
      pipeline.enqueue({ text: "Same answer" });
      await pipeline.flush({ force: true });

      expect(sent).toEqual([payload, { text: "Same answer" }]);
      expect(pipeline.didStreamTerminalReply?.()).toBe(true);
    }
  });

  it.each([
    {
      name: "coalesced text on both sides of audio",
      payloads: [{ text: "Before" }, { mediaUrl: "file:///voice.ogg" }, { text: "After" }],
      expected: [{ text: "Before" }, { mediaUrl: "file:///voice.ogg" }, { text: "After" }],
      mediaUrls: ["file:///voice.ogg"],
    },
    {
      name: "a late voice marker before following text",
      payloads: [{ mediaUrl: "file:///voice.ogg" }, { text: "After", audioAsVoice: true }],
      expected: [
        { mediaUrl: "file:///voice.ogg", audioAsVoice: true },
        { text: "After", audioAsVoice: true },
      ],
      mediaUrls: ["file:///voice.ogg"],
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
      mediaUrls: [],
    },
  ])("preserves streamed delivery order for $name", async ({ payloads, expected, mediaUrls }) => {
    const { sent, pipeline } = capturePipeline({
      coalescing: mediaCoalescing,
      isAudioPayload: (payload) =>
        [payload.mediaUrl, ...(payload.mediaUrls ?? [])].some((url) => url?.endsWith(".ogg")),
    });

    for (const payload of payloads) {
      pipeline.enqueue(payload);
    }
    await pipeline.flush({ force: true });

    expect(sent).toHaveLength(expected.length);
    expect(sent).toMatchObject(expected);
    expect(pipeline.getSentMediaUrls()).toEqual(mediaUrls);
  });

  it("preserves explicit reply routing and metadata for reply-to-current media", async () => {
    const routing = { replyToCurrent: true };
    const { sent, pipeline } = capturePipeline({ coalescing: mediaCoalescing });

    pipeline.enqueue(
      setReplyPayloadMetadata(
        { text: "Explicit answer", replyToId: "100", ...routing },
        { assistantMessageIndex: 7, replyToIdExplicit: true },
      ),
    );
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
    await pipeline.flush({ force: true });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      text: "Explicit answer",
      replyToId: "100",
      ...routing,
      mediaUrls: ["file:///photo.png"],
    });
    expect(sent.map(getReplyPayloadMetadata)).toEqual([
      expect.objectContaining({
        assistantMessageIndex: 7,
        replyToIdExplicit: true,
        assistantTranscriptMediaUrls: ["file:///photo.png"],
      }),
    ]);
  });

  it.each([
    ["an oversized caption", 16, " ", "caption", true],
    ["a joiner crossing the limit", 20, " ", "caption", true],
    ["an exact-limit caption", 21, " ", "caption", false],
    ["captionless media without another joiner", 15, "\n\n", undefined, false],
  ] as const)(
    "preserves delivery and metadata for %s",
    async (_name, maxChars, joiner, caption, split) => {
      const { sent, pipeline } = capturePipeline({
        coalescing: { minChars: 1, maxChars, idleMs: 0, joiner },
      });
      const routing = { replyToId: "100", replyToCurrent: true };
      pipeline.enqueue(
        sourceReply(
          "Preview",
          {
            assistantMessageIndex: 7,
            replyToIdExplicit: true,
            blockSourceText: "Preview",
            blockSourceRange: [0, 7],
          },
          routing,
        ),
      );
      pipeline.enqueue(
        sourceReply(
          "below",
          {
            assistantMessageIndex: 7,
            blockSourceText: "below",
            blockSourceRange: [7, 12],
          },
          routing,
        ),
      );
      const media = setReplyPayloadMetadata(
        { text: caption, mediaUrls: ["file:///photo.png"], ...routing },
        {
          assistantMessageIndex: 7,
          assistantTranscriptMediaUrls: ["file:///photo.png"],
          ...(caption ? { blockSourceText: "caption", blockSourceRange: [12, 19] as const } : {}),
        },
      );
      pipeline.enqueue(media);
      await pipeline.flush({ force: true });

      const buffered = "Preview" + joiner + "below";
      expect(sent.map((payload) => ({ text: payload.text, mediaUrls: payload.mediaUrls }))).toEqual(
        split
          ? [
              { text: buffered, mediaUrls: undefined },
              { text: caption, mediaUrls: ["file:///photo.png"] },
            ]
          : [
              {
                text: caption ? buffered + joiner + "caption" : buffered,
                mediaUrls: ["file:///photo.png"],
              },
            ],
      );
      expect(sent.every((payload) => (payload.text?.length ?? 0) <= maxChars)).toBe(true);
      for (const payload of sent) {
        expect(payload).toMatchObject(routing);
      }
      const expectedMetadata = {
        assistantMessageIndex: 7,
        replyToIdExplicit: true,
        blockSourceText: "Previewbelow" + (split ? "" : (caption ?? "")),
        blockSourceRange: [0, !split && caption ? 19 : 12],
      };
      expect(sent.map(getReplyPayloadMetadata)).toEqual(
        split
          ? [expect.objectContaining(expectedMetadata), getReplyPayloadMetadata(media)]
          : [
              expect.objectContaining({
                ...expectedMetadata,
                assistantTranscriptMediaUrls: ["file:///photo.png"],
              }),
            ],
      );
      expect(pipeline.getSentMediaUrls()).toEqual(["file:///photo.png"]);
      expect(pipeline.hasSentPayload({ text: "Previewbelow" + (caption ?? "") })).toBe(true);
    },
  );

  it("keeps media separate across assistant message boundaries", async () => {
    const { sent, pipeline } = capturePipeline({ coalescing: mediaCoalescing });

    pipeline.enqueue(
      setReplyPayloadMetadata({ text: "First block" }, { assistantMessageIndex: 0 }),
    );
    pipeline.enqueue(
      setReplyPayloadMetadata({ mediaUrls: ["file:///photo.png"] }, { assistantMessageIndex: 1 }),
    );
    await pipeline.flush({ force: true });

    expect(sent.map(({ text, mediaUrls }) => ({ text, mediaUrls }))).toEqual([
      { text: "First block", mediaUrls: undefined },
      { text: undefined, mediaUrls: ["file:///photo.png"] },
    ]);
  });
});

describe("createBlockReplyPipeline content coverage dedup", () => {
  it("deduplicates source ranges while preserving identical adjacent coalesced chunks", async () => {
    const { sent, pipeline } = capturePipeline({ coalescing: { ...coalescing, joiner: "" } });
    const sourceChunk = (range: readonly [number, number]) =>
      setReplyPayloadMetadata(
        { text: "aaa" },
        { assistantMessageIndex: 1, blockSourceText: "aaa", blockSourceRange: range },
      );

    pipeline.enqueue(sourceChunk([0, 3]));
    pipeline.enqueue(sourceChunk([3, 6]));
    pipeline.enqueue(sourceChunk([0, 3]));
    pipeline.enqueue(
      sourceReply("bbb", {
        assistantMessageIndex: 1,
        blockSourceText: "bbb",
        blockSourceRange: [0, 3],
      }),
    );
    await pipeline.flush({ force: true });

    expect(sent.map((payload) => payload.text)).toEqual(["aaaaaabbb"]);
  });

  it("deduplicates an unkeyed replay after a source occurrence", async () => {
    const { sent, pipeline } = capturePipeline();

    pipeline.enqueue(
      sourceReply("unchanged", {
        assistantMessageIndex: 1,
        blockSourceText: "unchanged",
        blockSourceRange: [0, 9],
      }),
    );
    await pipeline.flush({ force: true });
    pipeline.enqueue(setReplyPayloadMetadata({ text: "unchanged" }, { assistantMessageIndex: 1 }));
    await pipeline.flush({ force: true });

    expect(sent.map((payload) => payload.text)).toEqual(["unchanged"]);
  });

  it("recognizes delivered source through coalesced synthetic fence wrappers", async () => {
    const { sent, pipeline } = capturePipeline({ coalescing: { ...coalescing, idleMs: 1000 } });
    const first = "```ts\nconst x = \n```";
    const second = "```ts\n1;\n```";
    const final = setReplyPayloadMetadata(
      { text: "```ts\nconst x = 1;\n```" },
      { assistantMessageIndex: 7 },
    );
    pipeline.enqueue(
      sourceReply(first, { assistantMessageIndex: 7, blockSourceText: "```ts\nconst x = " }),
    );
    pipeline.enqueue(sourceReply(second, { assistantMessageIndex: 7, blockSourceText: "1;\n```" }));
    expect(pipeline.hasSentPayload(final)).toBe(false);

    await pipeline.flush({ force: true });

    expect(sent.map((payload) => payload.text)).toEqual([`${first}\n\n${second}`]);
    expect(sent.map((payload) => getReplyPayloadMetadata(payload)?.assistantMessageIndex)).toEqual([
      7,
    ]);
    expect(pipeline.hasSentPayload(final)).toBe(true);
    expect(pipeline.hasSentExactPayload?.(final)).toBe(false);
    expect(
      pipeline.hasSentPayload(setReplyPayloadMetadata({ ...final }, { assistantMessageIndex: 8 })),
    ).toBe(false);
    expect(pipeline.hasSentPayload({ text: "```ts\nconst x = 2;\n```" })).toBe(false);
  });

  it("merges source coverage through ordinary text and a media continuation", async () => {
    const { sent, pipeline } = capturePipeline({ coalescing });
    pipeline.enqueue({ text: "Example:" });
    pipeline.enqueue({ text: "Snippet:" });
    pipeline.enqueue(
      sourceReply("```ts\nconst x = \n```", { blockSourceText: "```ts\nconst x = " }),
    );
    pipeline.enqueue(
      sourceReply(
        "```ts\n1;\n```",
        { blockSourceText: "1;\n```" },
        { mediaUrl: "file:///example.png" },
      ),
    );
    await pipeline.flush({ force: true });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      text: "Example:\n\nSnippet:\n\n```ts\nconst x = \n```\n\n```ts\n1;\n```",
      mediaUrl: "file:///example.png",
    });
    expect(pipeline.hasSentPayload({ text: "Example:\nSnippet:\n```ts\nconst x = 1;\n```" })).toBe(
      true,
    );
    expect(pipeline.getSentMediaUrls()).toEqual(["file:///example.png"]);
  });

  it("does not credit removed source text when merging a media-only reply", async () => {
    const { pipeline } = capturePipeline({ coalescing });
    pipeline.enqueue(
      sourceReply("```ts\nconst x = 1;\n```", { blockSourceText: "```ts\nconst x = 1;\n```" }),
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

  it("keeps commentary out of visible final-content accounting", async () => {
    const { pipeline } = capturePipeline();
    const payload = { text: "Same answer", isCommentary: true };

    pipeline.enqueue(payload);
    await pipeline.flush({ force: true });

    expect(pipeline.didStream()).toBe(true);
    expect(pipeline.didStreamTerminalReply?.()).toBe(false);
    expect(pipeline.hasSentPayload({ text: "Same answer" })).toBe(false);
    expect(pipeline.hasSentExactPayload?.({ text: "Same answer" })).toBe(false);
  });

  it("does not let a status notice de-dupe later matching assistant content", async () => {
    const { sent, pipeline } = capturePipeline();

    pipeline.enqueue({ text: "same text", isStatusNotice: true });
    pipeline.enqueue({ text: "same text" });
    await pipeline.flush({ force: true });

    expect(sent.map(({ text, isStatusNotice }) => ({ text, isStatusNotice }))).toEqual([
      { text: "same text", isStatusNotice: true },
      { text: "same text" },
    ]);
    expect(pipeline.didStream()).toBe(true);
    expect(pipeline.hasSentPayload({ text: "same text" })).toBe(true);
  });

  it("does not suppress media payloads through streamed text coverage", async () => {
    const { pipeline } = capturePipeline();

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
