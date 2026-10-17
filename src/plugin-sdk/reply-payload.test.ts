import { describe, expect, it, vi } from "vitest";
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

describe("ask_user question option indices", () => {
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
});

describe("isReasoningReplyPayload", () => {
  it.each([
    ["flagged", { text: "Visible", isReasoning: true }, true],
    ["prefix", { text: "  \n Thinking\n_hidden_" }, true],
    ["blockquote", { text: "> Thinking\n> _hidden_" }, true],
    ["missing text", {}, false],
  ])("%s", (_name, payload, expected) => {
    expect(isReasoningReplyPayload(payload)).toBe(expected);
  });
});

describe("sendPayloadWithChunkedTextAndMedia", () => {
  const defaults = {
    sendText: async () => ({ channel: "test", messageId: "text" }),
    sendMedia: async () => ({ channel: "test", messageId: "media" }),
    emptyResult: { channel: "test", messageId: "" },
  };
  it("returns empty result when payload has no text and no media", async () => {
    const result = await sendPayloadWithChunkedTextAndMedia({
      ...defaults,
      ctx: { payload: {} },
    });
    expect(result).toEqual({ channel: "test", messageId: "" });
  });

  it("sends first media with text and remaining media without text", async () => {
    const calls: Array<{ text: string; mediaUrl: string }> = [];
    const result = await sendPayloadWithChunkedTextAndMedia({
      ...defaults,
      ctx: {
        payload: { text: "hello", mediaUrls: ["https://a", "https://b"] },
      },
      sendMedia: async (ctx) => {
        calls.push({ text: ctx.text, mediaUrl: ctx.mediaUrl });
        return { channel: "test", messageId: ctx.mediaUrl };
      },
    });
    expect(calls).toEqual([
      { text: "hello", mediaUrl: "https://a" },
      { text: "", mediaUrl: "https://b" },
    ]);
    expect(result).toEqual({ channel: "test", messageId: "https://b" });
  });

  it("sends the full text when the chunker returns no chunks", async () => {
    const sendText = vi.fn(async (ctx: { text: string }) => ({
      channel: "test",
      messageId: ctx.text,
    }));
    const onResult = vi.fn();

    const result = await sendPayloadWithChunkedTextAndMedia({
      ...defaults,
      ctx: { payload: { text: "visible reply" } },
      textChunkLimit: 64,
      chunker: () => [],
      sendText,
      onResult,
    });

    expect(sendText).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "visible reply" }),
    );
    expect(onResult).toHaveBeenCalledWith({ channel: "test", messageId: "visible reply" });
    expect(result).toEqual({ channel: "test", messageId: "visible reply" });
  });

  it("detects numeric target IDs", () => {
    expect(isNumericTargetId("12345")).toBe(true);
    expect(isNumericTargetId("  987  ")).toBe(true);
    expect(isNumericTargetId("ab12")).toBe(false);
    expect(isNumericTargetId("")).toBe(false);
  });
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

describe("sendPayloadMediaSequence", () => {
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

  it("uses the no-media fallback when every media URL is empty", async () => {
    const send = vi.fn();
    const sendNoMedia = vi.fn(async () => "text-result");

    await expect(
      sendPayloadMediaSequenceOrFallback({
        text: "caption",
        mediaUrls: ["", ""],
        send,
        sendNoMedia,
        fallbackResult: "fallback-result",
      }),
    ).resolves.toBe("text-result");
    expect(send).not.toHaveBeenCalled();
    expect(sendNoMedia).toHaveBeenCalledOnce();
  });

  it("does not use the no-media fallback when a media send returns undefined", async () => {
    const send = vi.fn(async () => undefined);
    const sendNoMedia = vi.fn(async () => undefined);

    await expect(
      sendPayloadMediaSequenceOrFallback({
        text: "caption",
        mediaUrls: ["https://example.com/image.png"],
        send,
        sendNoMedia,
        fallbackResult: undefined,
      }),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
    expect(sendNoMedia).not.toHaveBeenCalled();
  });
});

describe("sendTextMediaPayload", () => {
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
});

describe("normalizeOutboundReplyPayload", () => {
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
});

describe("TTS supplement payload helpers", () => {
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
});

it("still reports content when trimmed text is blank but media exists", () => {
  expect(
    hasOutboundReplyContent(
      { text: "   ", mediaUrls: ["https://example.com/a.png"] },
      { trimText: true },
    ),
  ).toBe(true);
});

describe("deliverTextOrMediaReply", () => {
  function senders() {
    return { sendMedia: vi.fn(async () => undefined), sendText: vi.fn(async () => undefined) };
  }
  it("sends media first with caption only on the first attachment", async () => {
    const { sendMedia, sendText } = senders();

    await expect(
      deliverTextOrMediaReply({
        payload: { text: "hello", mediaUrls: ["https://a", "https://b"] },
        text: "hello",
        sendText,
        sendMedia,
      }),
    ).resolves.toBe("media");

    expect(sendMedia).toHaveBeenNthCalledWith(1, {
      mediaUrl: "https://a",
      caption: "hello",
    });
    expect(sendMedia).toHaveBeenNthCalledWith(2, {
      mediaUrl: "https://b",
      caption: undefined,
    });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("preserves non-empty text when the reply chunker returns no chunks", async () => {
    const { sendMedia, sendText } = senders();

    await expect(
      deliverTextOrMediaReply({
        payload: { text: "visible reply" },
        text: "visible reply",
        chunkText: () => [],
        sendText,
        sendMedia,
      }),
    ).resolves.toBe("text");

    expect(sendText).toHaveBeenCalledExactlyOnceWith("visible reply");
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it("returns empty when chunking produces no sendable text", async () => {
    const { sendMedia, sendText } = senders();

    await expect(
      deliverTextOrMediaReply({
        payload: { text: "   " },
        text: "   ",
        chunkText: () => [],
        sendText,
        sendMedia,
      }),
    ).resolves.toBe("empty");

    expect(sendText).not.toHaveBeenCalled();
    expect(sendMedia).not.toHaveBeenCalled();
  });
});

describe("sendMediaWithLeadingCaption", () => {
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
});

describe("deliverFormattedTextWithAttachments", () => {
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
});
