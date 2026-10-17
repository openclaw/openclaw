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
    const sendText = vi.fn(async ({ text }: { text: string }) => ({
      channel: "test",
      messageId: text,
    }));
    const sendMedia = vi.fn(async ({ mediaUrl }: { text: string; mediaUrl: string }) => ({
      channel: "test",
      messageId: mediaUrl,
    }));
    const onResult = vi.fn();
    const result = await sendPayloadWithChunkedTextAndMedia({
      ctx: { payload },
      textChunkLimit: 64,
      chunker: () => [],
      sendText,
      sendMedia,
      emptyResult: { channel: "test", messageId: "" },
      ...(kind === "empty chunker" ? { onResult } : {}),
    });
    expect(result).toEqual({ channel: "test", messageId: lastId });
    expect(sendText.mock.calls.map(([ctx]) => ctx.text)).toEqual(texts);
    expect(
      sendMedia.mock.calls.map(([ctx]) => ({ text: ctx.text, mediaUrl: ctx.mediaUrl })),
    ).toEqual(media);
    if (kind === "empty chunker") {
      expect(onResult).toHaveBeenCalledWith({ channel: "test", messageId: "visible reply" });
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
  const calls: Array<[string, number, boolean]> = [];
  const results: string[] = [];
  const result = await sendPayloadTextChunkSequence({
    chunks,
    send: async ({ text, index, isFirst }) => {
      calls.push([text, index, isFirst]);
      return text;
    },
    onResult: (value) => {
      results.push(value);
    },
  });

  expect(calls).toEqual([
    ["one", 0, true],
    ["two", 1, false],
  ]);
  expect(results).toEqual(chunks);
  expect(result).toBe("two");
});

it("treats the first non-empty URL as the first media send", async () => {
  const calls: Array<{ text: string; mediaUrl: string; index: number; isFirst: boolean }> = [];

  const result = await sendPayloadMediaSequence({
    text: "caption",
    mediaUrls: ["", "https://example.com/image.png"],
    send: async (input) => {
      calls.push(input);
      return input.mediaUrl;
    },
  });

  expect(calls).toEqual([
    {
      text: "caption",
      mediaUrl: "https://example.com/image.png",
      index: 1,
      isFirst: true,
    },
  ]);
  expect(result).toBe("https://example.com/image.png");
});

it.each([false, true])("separates fallback from media sends (hasMedia=%s)", async (hasMedia) => {
  const result = hasMedia ? undefined : "text-result";
  const send = vi.fn(async () => undefined);
  const sendNoMedia = vi.fn(async () => result);
  await expect(
    sendPayloadMediaSequenceOrFallback({
      text: "caption",
      mediaUrls: hasMedia ? ["https://example.com/image.png"] : ["", ""],
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
    sendPayload(
      { text: "caption", mediaUrl: "https://example.com/image.png" },
      { sendMedia, sendText },
      { text: "caption" },
    ),
  ).resolves.toBeUndefined();
  expect(sendMediaMock).toHaveBeenCalledOnce();
  expect(sendText).not.toHaveBeenCalled();
});

it("falls back to text when every media URL is empty", async () => {
  const sendMedia = vi.fn();
  const sendText = vi.fn(async ({ text }) => ({ channel: "test", messageId: text }));

  const result = await sendPayload(
    { text: "caption", mediaUrls: ["", ""] },
    { sendMedia, sendText },
    { text: "caption" },
  );

  expect(sendMedia).not.toHaveBeenCalled();
  expect(sendText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: "caption" }));
  expect(result).toEqual({ channel: "test", messageId: "caption" });
});

it("sends the full text when the adapter chunker returns no chunks", async () => {
  const sendText = vi.fn(async ({ text }) => ({ channel: "test", messageId: text }));
  const onDeliveryResult = vi.fn();

  const result = await sendPayload(
    { text: "visible reply" },
    { textChunkLimit: 64, chunker: () => [], sendText },
    { onDeliveryResult },
  );

  expect(sendText).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ text: "visible reply" }),
  );
  expect(onDeliveryResult).toHaveBeenCalledWith({
    channel: "test",
    messageId: "visible reply",
  });
  expect(result).toEqual({ channel: "test", messageId: "visible reply" });
});

it("reports each completed text chunk before a later chunk fails", async () => {
  const sendText = vi
    .fn()
    .mockResolvedValueOnce({ channel: "test", messageId: "ab" })
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

  expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith({ channel: "test", messageId: "ab" });
  expect(sendText.mock.calls.map((call) => call[0].replyToId)).toEqual(["reply-1", undefined]);
});

it("does not report callback-aware media sends twice", async () => {
  const onDeliveryResult = vi.fn();
  const result = { channel: "test", messageId: "m1" };

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
  const sendMedia = vi.fn<
    NonNullable<Parameters<typeof sendTextMediaPayload>[0]["adapter"]["sendMedia"]>
  >(async () => ({ channel: "test", messageId: "media" }));

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
  const explicitTtsCommandPayload = {
    mediaUrl: "file:///tmp/tts.mp3",
    spokenText: "read this",
  };

  expect(getReplyPayloadTtsSupplement(explicitTtsCommandPayload)).toBeUndefined();

  const marked = markReplyPayloadAsTtsSupplement(explicitTtsCommandPayload, "read this");

  expect(getReplyPayloadTtsSupplement(marked)).toEqual({ spokenText: "read this" });
  expect(
    getReplyPayloadTtsSupplement(
      markReplyPayloadAsTtsSupplement(explicitTtsCommandPayload, "read this", {
        visibleTextAlreadyDelivered: true,
      }),
    ),
  ).toEqual({ spokenText: "read this", visibleTextAlreadyDelivered: true });
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
      mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      caption: "hello",
      send,
      onError,
    }),
  ).resolves.toBe(true);

  expect(onError).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      mediaUrl: "https://example.com/a.png",
      caption: "hello",
      index: 0,
      isFirst: true,
    }),
  );
  expect(send).toHaveBeenNthCalledWith(2, {
    mediaUrl: "https://example.com/b.png",
    caption: undefined,
  });
});

it("combines attachment links and forwards replyToId", async () => {
  const send = vi.fn(async () => undefined);

  await expect(
    deliverFormattedTextWithAttachments({
      payload: {
        text: "hello",
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
        replyToId: "r1",
      },
      send,
    }),
  ).resolves.toBe(true);

  expect(send).toHaveBeenCalledWith({
    text: "hello\n\nAttachment: https://example.com/a.png\nAttachment: https://example.com/b.png",
    replyToId: "r1",
  });
});
