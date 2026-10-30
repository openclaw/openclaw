import { expect, it, vi } from "vitest";
import {
  buildTtsSupplementMediaPayload,
  createNormalizedOutboundDeliverer,
  deliverFormattedTextWithAttachments,
  deliverTextOrMediaReply,
  hasOutboundReplyContent,
  getReplyPayloadTtsSupplement,
  isReasoningReplyPayload,
  isNumericTargetId,
  markReplyPayloadAsTtsSupplement,
  resolveAskUserQuestionOptionIndex,
  resolveAskUserQuestionOptionIndices,
  sendPayloadMediaSequence,
  sendPayloadMediaSequenceOrFallback,
  sendTextMediaPayload,
  sendMediaWithLeadingCaption,
  sendPayloadTextChunkSequence,
  sendPayloadWithChunkedTextAndMedia,
} from "./reply-payload.js";

const sent = (messageId: string) => ({ channel: "test", messageId });
const sendTextResult = () => vi.fn(async ({ text }: { text: string }) => sent(text));
const image = "https://example.com/image.png";
const mediaPair = ["https://a", "https://b"];

it("reads bounded owner order and matches presented values case-insensitively", () => {
  const questionId = "ask_0123456789abcdef0123456789abcdef";
  const questionOptionIndices = resolveAskUserQuestionOptionIndices({
    channelData: { askUser: { questionId, optionValues: ["Staging", "Production"] } },
  });

  expect(
    resolveAskUserQuestionOptionIndex({
      questionOptionIndices,
      questionId,
      optionValue: " production ",
    }),
  ).toBe(1);
});

it.each([
  undefined,
  { questionId: "ask_1", optionValues: ["A", " a "] },
  { questionId: "ask_1", optionValues: ["A", "B", "C", "D", "E"] },
])("rejects missing or ambiguous owner context %#", (askUser) => {
  expect(resolveAskUserQuestionOptionIndices({ channelData: { askUser } })).toBeUndefined();
});

it.each([
  ["flagged", { text: "Visible", isReasoning: true }, true],
  ["prefix", { text: "  \n Thinking\n_hidden_" }, true],
  ["blockquote", { text: "> Thinking\n> _hidden_" }, true],
  ["missing text", {}, false],
])("%s", (_name, payload, expected) => {
  expect(isReasoningReplyPayload(payload)).toBe(expected);
});

it.each([
  ["empty", {}, "", [], []],
  [
    "media",
    { text: "hello", mediaUrls: ["https://a", "https://b"] },
    "https://b",
    [],
    [
      { text: "hello", mediaUrl: "https://a" },
      { text: "", mediaUrl: "https://b" },
    ],
  ],
  ["empty chunker", { text: "visible reply" }, "visible reply", ["visible reply"], []],
] as const)(
  "sendPayloadWithChunkedTextAndMedia: %s",
  async (kind, payload, lastId, texts, media) => {
    const sendText = sendTextResult();
    const sendMedia = vi.fn(async ({ mediaUrl }: { text: string; mediaUrl: string }) =>
      sent(mediaUrl),
    );
    const onResult = vi.fn();
    const result = await sendPayloadWithChunkedTextAndMedia({
      ctx: { payload },
      textChunkLimit: 64,
      chunker: () => [],
      sendText,
      sendMedia,
      emptyResult: sent(""),
      ...(kind === "empty chunker" ? { onResult } : {}),
    });
    expect(result).toEqual(sent(lastId));
    expect(sendText.mock.calls.map(([ctx]) => ctx.text)).toEqual(texts);
    expect(
      sendMedia.mock.calls.map(([ctx]) => ({ text: ctx.text, mediaUrl: ctx.mediaUrl })),
    ).toEqual(media);
    if (kind === "empty chunker") {
      expect(onResult).toHaveBeenCalledWith(sent("visible reply"));
    }
  },
);

it("detects numeric target IDs", () => {
  expect(isNumericTargetId("12345")).toBe(true);
  expect(isNumericTargetId("  987  ")).toBe(true);
  expect(isNumericTargetId("ab12")).toBe(false);
  expect(isNumericTargetId("")).toBe(false);
});

it("sends multiple text chunks in sequence", async () => {
  const chunks = ["one", "two"];
  const send = vi.fn(async ({ text }: { text: string; index: number; isFirst: boolean }) => text);
  const onResult = vi.fn();
  const result = await sendPayloadTextChunkSequence({
    chunks,
    send,
    onResult,
  });
  expect(send.mock.calls).toEqual([
    [{ text: "one", index: 0, isFirst: true }],
    [{ text: "two", index: 1, isFirst: false }],
  ]);
  expect(onResult.mock.calls).toEqual(chunks.map((chunk) => [chunk]));
  expect(result).toBe("two");
});

it("treats the first non-empty URL as the first media send", async () => {
  const send = vi.fn(async (input: { mediaUrl: string }) => input.mediaUrl);
  const result = await sendPayloadMediaSequence({
    text: "caption",
    mediaUrls: ["", image],
    send,
  });

  expect(send.mock.calls).toEqual([
    [{ text: "caption", mediaUrl: image, index: 1, isFirst: true }],
  ]);
  expect(result).toBe(image);
});

it.each([false, true])("separates fallback from media sends (hasMedia=%s)", async (hasMedia) => {
  const result = hasMedia ? undefined : "text-result";
  const send = vi.fn(async () => undefined);
  const sendNoMedia = vi.fn(async () => result);
  await expect(
    sendPayloadMediaSequenceOrFallback({
      text: "caption",
      mediaUrls: hasMedia ? [image] : ["", ""],
      send,
      sendNoMedia,
      fallbackResult: hasMedia ? undefined : "fallback-result",
    }),
  ).resolves.toBe(result);
  expect(send).toHaveBeenCalledTimes(hasMedia ? 1 : 0);
  expect(sendNoMedia).toHaveBeenCalledTimes(hasMedia ? 0 : 1);
});

type Options = Parameters<typeof sendTextMediaPayload>[0];
function sendPayload(
  payload: Options["ctx"]["payload"],
  adapter: Options["adapter"],
  context: Partial<Options["ctx"]> = {},
) {
  return sendTextMediaPayload({
    channel: "test",
    ctx: { cfg: {}, to: "target", text: "", ...context, payload },
    adapter,
  });
}

it("does not duplicate a caption when a media sender returns undefined", async () => {
  const sendMediaMock = vi.fn(async () => undefined);
  const sendText = vi.fn();
  const sendMedia = sendMediaMock as unknown as NonNullable<
    Parameters<typeof sendTextMediaPayload>[0]["adapter"]["sendMedia"]
  >;

  await expect(
    sendPayload({ text: "caption", mediaUrl: image }, { sendMedia, sendText }, { text: "caption" }),
  ).resolves.toBeUndefined();
  expect(sendMediaMock).toHaveBeenCalledOnce();
  expect(sendText).not.toHaveBeenCalled();
});

it.each([
  ["empty media URLs", { mediaUrls: ["", ""] }, {}],
  ["empty chunker", {}, { textChunkLimit: 64, chunker: () => [] }],
] satisfies Array<[string, Partial<Options["ctx"]["payload"]>, Partial<Options["adapter"]>]>)(
  "falls back to the full text with %s",
  async (_name, payload, adapter) => {
    const sendMedia = vi.fn();
    const sendText = sendTextResult();
    const onDeliveryResult = vi.fn();
    const result = await sendPayload(
      { text: "caption", ...payload },
      { sendMedia, sendText, ...adapter },
      { text: "caption", onDeliveryResult },
    );
    expect(sendMedia).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: "caption" }));
    expect(onDeliveryResult).toHaveBeenCalledWith(sent("caption"));
    expect(result).toEqual(sent("caption"));
  },
);

it("reports each completed text chunk before a later chunk fails", async () => {
  const sendText = vi
    .fn()
    .mockResolvedValueOnce(sent("ab"))
    .mockRejectedValueOnce(new Error("second chunk failed"));
  const onDeliveryResult = vi.fn();

  await expect(
    sendPayload(
      { text: "abcd" },
      { textChunkLimit: 2, chunker: () => ["ab", "cd"], sendText },
      {
        onDeliveryResult,
        replyToId: "reply-1",
        replyToIdSource: "implicit",
        replyToMode: "first",
      },
    ),
  ).rejects.toThrow("second chunk failed");

  expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(sent("ab"));
  expect(sendText.mock.calls.map((call) => call[0].replyToId)).toEqual(["reply-1", undefined]);
});

it("does not report callback-aware media sends twice", async () => {
  const onDeliveryResult = vi.fn();
  const result = sent("m1");

  await sendPayload(
    { mediaUrl: "https://example.com/a.png" },
    {
      sendMedia: async (ctx) => {
        await ctx.onDeliveryResult?.(result);
        return result;
      },
    },
    { onDeliveryResult },
  );

  expect(onDeliveryResult).toHaveBeenCalledTimes(1);
});

it("preserves audioAsVoice on media fallback sends", async () => {
  const sendMedia = vi.fn<NonNullable<Options["adapter"]["sendMedia"]>>(async () => sent("media"));

  await sendPayload(
    {
      text: "caption",
      mediaUrls: ["https://example.com/voice.ogg", "https://example.com/next.ogg"],
      audioAsVoice: true,
    },
    { sendMedia },
    {
      replyToId: "reply-1",
      replyToIdSource: "implicit",
      replyToMode: "batched",
    },
  );

  expect(sendMedia.mock.calls.map((call) => call[0].audioAsVoice)).toEqual([true, true]);
  expect(sendMedia.mock.calls.map((call) => call[0].replyToId)).toEqual(["reply-1", undefined]);
});

it("keeps the normalized deliverer from forwarding trustedLocalMedia", async () => {
  const handler = vi.fn(async () => {});
  const deliver = createNormalizedOutboundDeliverer(handler);

  await deliver({
    text: "hello",
    mediaUrl: "/tmp/reply.opus",
    trustedLocalMedia: true,
    sensitiveMedia: true,
    replyToId: "abc123",
  });

  expect(handler).toHaveBeenCalledWith({
    text: "hello",
    mediaUrl: "/tmp/reply.opus",
    sensitiveMedia: true,
    replyToId: "abc123",
    mediaUrls: undefined,
  });
});

it("marks media payloads as TTS supplements without treating spokenText alone as enough", () => {
  const payload = { mediaUrl: "file:///tmp/tts.mp3", spokenText: "read this" };
  const mark = (options?: { visibleTextAlreadyDelivered: boolean }) =>
    getReplyPayloadTtsSupplement(markReplyPayloadAsTtsSupplement(payload, "read this", options));
  expect(getReplyPayloadTtsSupplement(payload)).toBeUndefined();
  expect(mark()).toEqual({ spokenText: "read this" });
  expect(mark({ visibleTextAlreadyDelivered: true })).toEqual({
    spokenText: "read this",
    visibleTextAlreadyDelivered: true,
  });
});

it("strips visible content while keeping TTS supplement media fallback text", () => {
  expect(
    buildTtsSupplementMediaPayload(
      markReplyPayloadAsTtsSupplement({
        text: "visible",
        mediaUrl: "file:///tmp/tts.mp3",
        audioAsVoice: true,
        presentation: { title: "visible", blocks: [] },
        interactive: { blocks: [] },
        btw: { question: "side" },
      }),
    ),
  ).toEqual({
    mediaUrl: "file:///tmp/tts.mp3",
    audioAsVoice: true,
    spokenText: "visible",
    ttsSupplement: { spokenText: "visible" },
  });
});

it("still reports content when trimmed text is blank but media exists", () => {
  expect(
    hasOutboundReplyContent(
      { text: "   ", mediaUrls: ["https://example.com/a.png"] },
      { trimText: true },
    ),
  ).toBe(true);
});

it.each([
  ["media", "hello", ["https://a", "https://b"]],
  ["text", "visible reply", []],
  ["empty", "   ", []],
] as const)("deliverTextOrMediaReply: %s", async (result, text, mediaUrls) => {
  const sendMedia = vi.fn(async () => undefined);
  const sendText = vi.fn(async () => undefined);
  await expect(
    deliverTextOrMediaReply({
      payload: { text, mediaUrls: [...mediaUrls] },
      text,
      chunkText: () => [],
      sendText,
      sendMedia,
    }),
  ).resolves.toBe(result);
  expect(sendMedia.mock.calls).toEqual(
    result === "media"
      ? [
          [{ mediaUrl: "https://a", caption: "hello" }],
          [{ mediaUrl: "https://b", caption: undefined }],
        ]
      : [],
  );
  expect(sendText.mock.calls).toEqual(result === "text" ? [["visible reply"]] : []);
});

it("passes leading-caption metadata to async error handlers", async () => {
  const send = vi
    .fn<({ mediaUrl, caption }: { mediaUrl: string; caption?: string }) => Promise<void>>()
    .mockRejectedValueOnce(new Error("boom"))
    .mockResolvedValueOnce(undefined);
  const onError = vi.fn(async () => undefined);

  await expect(
    sendMediaWithLeadingCaption({
      mediaUrls: mediaPair,
      caption: "hello",
      send,
      onError,
    }),
  ).resolves.toBe(true);

  expect(onError).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      mediaUrl: mediaPair[0],
      caption: "hello",
      index: 0,
      isFirst: true,
    }),
  );
  expect(send).toHaveBeenNthCalledWith(2, {
    mediaUrl: mediaPair[1],
    caption: undefined,
  });
});

it("combines attachment links and forwards replyToId", async () => {
  const send = vi.fn(async () => undefined);

  await expect(
    deliverFormattedTextWithAttachments({
      payload: {
        text: "hello",
        mediaUrls: mediaPair,
        replyToId: "r1",
      },
      send,
    }),
  ).resolves.toBe(true);

  expect(send).toHaveBeenCalledWith({
    text: "hello\n\nAttachment: https://a\nAttachment: https://b",
    replyToId: "r1",
  });
});
