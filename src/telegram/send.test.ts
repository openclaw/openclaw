import type { Bot } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTelegramSendTestMocks,
  importTelegramSendModule,
  installTelegramSendTestHooks,
} from "./send.test-harness.js";
import { clearSentMessageCache, recordSentMessage, wasSentByBot } from "./sent-message-cache.js";

installTelegramSendTestHooks();

const { botApi, botCtorSpy, loadConfig, loadWebMedia } = getTelegramSendTestMocks();
const {
  buildInlineKeyboard,
  createForumTopicTelegram,
  editMessageTelegram,
  reactMessageTelegram,
  sendMessageTelegram,
  sendPollTelegram,
  sendStickerTelegram,
} = await importTelegramSendModule();

async function expectChatNotFoundWithChatId(
  action: Promise<unknown>,
  expectedChatId: string,
): Promise<void> {
  try {
    await action;
    throw new Error("Expected action to reject with chat-not-found context");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Expected action to reject with chat-not-found context"
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/chat not found/i);
    expect(message).toMatch(new RegExp(`chat_id=${expectedChatId}`));
  }
}

describe("sent-message-cache", () => {
  afterEach(() => {
    clearSentMessageCache();
  });

  it("records and retrieves sent messages", () => {
    recordSentMessage(123, 1);
    recordSentMessage(123, 2);
    recordSentMessage(456, 10);

    expect(wasSentByBot(123, 1)).toBe(true);
    expect(wasSentByBot(123, 2)).toBe(true);
    expect(wasSentByBot(456, 10)).toBe(true);
    expect(wasSentByBot(123, 3)).toBe(false);
    expect(wasSentByBot(789, 1)).toBe(false);
  });

  it("handles string chat IDs", () => {
    recordSentMessage("123", 1);
    expect(wasSentByBot("123", 1)).toBe(true);
    expect(wasSentByBot(123, 1)).toBe(true);
  });

  it("clears cache", () => {
    recordSentMessage(123, 1);
    expect(wasSentByBot(123, 1)).toBe(true);

    clearSentMessageCache();
    expect(wasSentByBot(123, 1)).toBe(false);
  });
});

describe("buildInlineKeyboard", () => {
  it("normalizes keyboard inputs", () => {
    const cases: Array<{
      name: string;
      input: Parameters<typeof buildInlineKeyboard>[0];
      expected: ReturnType<typeof buildInlineKeyboard>;
    }> = [
      {
        name: "empty input",
        input: undefined,
        expected: undefined,
      },
      {
        name: "empty rows",
        input: [],
        expected: undefined,
      },
      {
        name: "valid rows",
        input: [
          [{ text: "Option A", callback_data: "cmd:a" }],
          [
            { text: "Option B", callback_data: "cmd:b" },
            { text: "Option C", callback_data: "cmd:c" },
          ],
        ],
        expected: {
          inline_keyboard: [
            [{ text: "Option A", callback_data: "cmd:a" }],
            [
              { text: "Option B", callback_data: "cmd:b" },
              { text: "Option C", callback_data: "cmd:c" },
            ],
          ],
        },
      },
      {
        name: "keeps button style fields",
        input: [
          [
            {
              text: "Option A",
              callback_data: "cmd:a",
              style: "primary",
            },
          ],
        ],
        expected: {
          inline_keyboard: [
            [
              {
                text: "Option A",
                callback_data: "cmd:a",
                style: "primary",
              },
            ],
          ],
        },
      },
      {
        name: "filters invalid buttons and empty rows",
        input: [
          [
            { text: "", callback_data: "cmd:skip" },
            { text: "Ok", callback_data: "cmd:ok" },
          ],
          [{ text: "Missing data", callback_data: "" }],
          [],
        ],
        expected: {
          inline_keyboard: [[{ text: "Ok", callback_data: "cmd:ok" }]],
        },
      },
    ];
    for (const testCase of cases) {
      const input = testCase.input?.map((row) => row.map((button) => ({ ...button })));
      expect(buildInlineKeyboard(input), testCase.name).toEqual(testCase.expected);
    }
  });
});

describe("sendMessageTelegram", () => {
  it("applies timeoutSeconds config precedence", async () => {
    const cases = [
      {
        name: "global telegram timeout",
        cfg: { channels: { telegram: { timeoutSeconds: 60 } } },
        opts: { token: "tok" },
        expectedTimeout: 60,
      },
      {
        name: "per-account timeout override",
        cfg: {
          channels: {
            telegram: {
              timeoutSeconds: 60,
              accounts: { foo: { timeoutSeconds: 61 } },
            },
          },
        },
        opts: { token: "tok", accountId: "foo" },
        expectedTimeout: 61,
      },
    ] as const;
    for (const testCase of cases) {
      botCtorSpy.mockClear();
      loadConfig.mockReturnValue(testCase.cfg);
      await sendMessageTelegram("123", "hi", testCase.opts);
      expect(botCtorSpy, testCase.name).toHaveBeenCalledWith(
        "tok",
        expect.objectContaining({
          client: expect.objectContaining({ timeoutSeconds: testCase.expectedTimeout }),
        }),
      );
    }
  });

  it("falls back to plain text when Telegram rejects HTML", async () => {
    const chatId = "123";
    const parseErr = new Error(
      "400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 9",
    );
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(parseErr)
      .mockResolvedValueOnce({
        message_id: 42,
        chat: { id: chatId },
      });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    const res = await sendMessageTelegram(chatId, "_oops_", {
      token: "tok",
      api,
      verbose: true,
    });

    expect(sendMessage).toHaveBeenNthCalledWith(1, chatId, "<i>oops</i>", {
      parse_mode: "HTML",
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, chatId, "_oops_");
    expect(res.chatId).toBe(chatId);
    expect(res.messageId).toBe("42");
  });

  it("keeps link_preview_options disabled for both html and plain-text fallback", async () => {
    const parseErr = new Error(
      "400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 9",
    );
    const cases = [
      {
        name: "html send succeeds",
        text: "hi",
        sendMessage: vi.fn().mockResolvedValue({ message_id: 7, chat: { id: "123" } }),
        expectedCalls: [
          ["123", "hi", { parse_mode: "HTML", link_preview_options: { is_disabled: true } }],
        ],
      },
      {
        name: "html parse fails then plain-text fallback",
        text: "_oops_",
        sendMessage: vi
          .fn()
          .mockRejectedValueOnce(parseErr)
          .mockResolvedValueOnce({ message_id: 42, chat: { id: "123" } }),
        expectedCalls: [
          [
            "123",
            "<i>oops</i>",
            { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
          ],
          ["123", "_oops_", { link_preview_options: { is_disabled: true } }],
        ],
      },
    ] as const;
    for (const testCase of cases) {
      loadConfig.mockReturnValue({
        channels: { telegram: { linkPreview: false } },
      });
      const api = { sendMessage: testCase.sendMessage } as unknown as {
        sendMessage: typeof testCase.sendMessage;
      };
      await sendMessageTelegram("123", testCase.text, { token: "tok", api });
      expect(testCase.sendMessage.mock.calls, testCase.name).toEqual(testCase.expectedCalls);
    }
  });

  it("uses native fetch for BAN compatibility when api is omitted", async () => {
    const originalFetch = globalThis.fetch;
    const originalBun = (globalThis as { Bun?: unknown }).Bun;
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    (globalThis as { Bun?: unknown }).Bun = {};
    botApi.sendMessage.mockResolvedValue({
      message_id: 1,
      chat: { id: "123" },
    });
    try {
      await sendMessageTelegram("123", "hi", { token: "tok" });
      const clientFetch = (botCtorSpy.mock.calls[0]?.[1] as { client?: { fetch?: unknown } })
        ?.client?.fetch;
      expect(clientFetch).toBeTypeOf("function");
      expect(clientFetch).not.toBe(fetchSpy);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBun === undefined) {
        delete (globalThis as { Bun?: unknown }).Bun;
      } else {
        (globalThis as { Bun?: unknown }).Bun = originalBun;
      }
    }
  });

  it("normalizes chat ids with internal prefixes", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 1,
      chat: { id: "123" },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram("telegram:123", "hi", {
      token: "tok",
      api,
    });

    expect(sendMessage).toHaveBeenCalledWith("123", "hi", {
      parse_mode: "HTML",
    });
  });

  it("preserves thread params in plain text fallback", async () => {
    const chatId = "-1001234567890";
    const parseErr = new Error(
      "400: Bad Request: can't parse entities: Can't find end of the entity",
    );
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(parseErr)
      .mockResolvedValueOnce({
        message_id: 60,
        chat: { id: chatId },
      });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    const res = await sendMessageTelegram(chatId, "_bad markdown_", {
      token: "tok",
      api,
      messageThreadId: 271,
      replyToMessageId: 100,
    });

    expect(sendMessage).toHaveBeenNthCalledWith(1, chatId, "<i>bad markdown</i>", {
      parse_mode: "HTML",
      message_thread_id: 271,
      reply_to_message_id: 100,
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, chatId, "_bad markdown_", {
      message_thread_id: 271,
      reply_to_message_id: 100,
    });
    expect(res.messageId).toBe("60");
  });

  it("includes thread params in media messages", async () => {
    const chatId = "-1001234567890";
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 58,
      chat: { id: chatId },
    });
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram(chatId, "photo in topic", {
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
      messageThreadId: 99,
    });

    expect(sendPhoto).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: "photo in topic",
      parse_mode: "HTML",
      message_thread_id: 99,
    });
  });

  it("splits long captions into media + text messages when text exceeds 1024 chars", async () => {
    const chatId = "123";
    const longText = "A".repeat(1100);

    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 70,
      chat: { id: chatId },
    });
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 71,
      chat: { id: chatId },
    });
    const api = { sendPhoto, sendMessage } as unknown as {
      sendPhoto: typeof sendPhoto;
      sendMessage: typeof sendMessage;
    };

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    const res = await sendMessageTelegram(chatId, longText, {
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
    });

    expect(sendPhoto).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: undefined,
    });
    expect(sendMessage).toHaveBeenCalledWith(chatId, longText, {
      parse_mode: "HTML",
    });
    expect(res.messageId).toBe("71");
  });

  it("uses caption when text is within 1024 char limit", async () => {
    const chatId = "123";
    const shortText = "B".repeat(1024);

    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 72,
      chat: { id: chatId },
    });
    const sendMessage = vi.fn();
    const api = { sendPhoto, sendMessage } as unknown as {
      sendPhoto: typeof sendPhoto;
      sendMessage: typeof sendMessage;
    };

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    const res = await sendMessageTelegram(chatId, shortText, {
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
    });

    expect(sendPhoto).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: shortText,
      parse_mode: "HTML",
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(res.messageId).toBe("72");
  });

  it("renders markdown in media captions", async () => {
    const chatId = "123";
    const caption = "hi **boss**";

    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 90,
      chat: { id: chatId },
    });
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram(chatId, caption, {
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
    });

    expect(sendPhoto).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: "hi <b>boss</b>",
      parse_mode: "HTML",
    });
  });

  it("sends video notes when requested and regular videos otherwise", async () => {
    const chatId = "123";

    {
      const text = "ignored caption context";
      const sendVideoNote = vi.fn().mockResolvedValue({
        message_id: 101,
        chat: { id: chatId },
      });
      const sendMessage = vi.fn().mockResolvedValue({
        message_id: 102,
        chat: { id: chatId },
      });
      const api = { sendVideoNote, sendMessage } as unknown as {
        sendVideoNote: typeof sendVideoNote;
        sendMessage: typeof sendMessage;
      };

      loadWebMedia.mockResolvedValueOnce({
        buffer: Buffer.from("fake-video"),
        contentType: "video/mp4",
        fileName: "video.mp4",
      });

      const res = await sendMessageTelegram(chatId, text, {
        token: "tok",
        api,
        mediaUrl: "https://example.com/video.mp4",
        asVideoNote: true,
      });

      expect(sendVideoNote).toHaveBeenCalledWith(chatId, expect.anything(), {});
      expect(sendMessage).toHaveBeenCalledWith(chatId, text, {
        parse_mode: "HTML",
      });
      expect(res.messageId).toBe("102");
    }

    {
      const text = "my caption";
      const sendVideo = vi.fn().mockResolvedValue({
        message_id: 201,
        chat: { id: chatId },
      });
      const api = { sendVideo } as unknown as {
        sendVideo: typeof sendVideo;
      };

      loadWebMedia.mockResolvedValueOnce({
        buffer: Buffer.from("fake-video"),
        contentType: "video/mp4",
        fileName: "video.mp4",
      });

      const res = await sendMessageTelegram(chatId, text, {
        token: "tok",
        api,
        mediaUrl: "https://example.com/video.mp4",
        asVideoNote: false,
      });

      expect(sendVideo).toHaveBeenCalledWith(chatId, expect.anything(), {
        caption: expect.any(String),
        parse_mode: "HTML",
      });
      expect(res.messageId).toBe("201");
    }
  });

  it("applies reply markup and thread options to split video-note sends", async () => {
    const chatId = "123";
    const cases: Array<{
      text: string;
      options: Partial<NonNullable<Parameters<typeof sendMessageTelegram>[2]>>;
      expectedVideoNote: Record<string, unknown>;
      expectedMessage: Record<string, unknown>;
    }> = [
      {
        text: "Check this out",
        options: {
          buttons: [[{ text: "Btn", callback_data: "dat" }]],
        },
        expectedVideoNote: {},
        expectedMessage: {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: "Btn", callback_data: "dat" }]],
          },
        },
      },
      {
        text: "Threaded reply",
        options: {
          replyToMessageId: 999,
        },
        expectedVideoNote: { reply_to_message_id: 999 },
        expectedMessage: {
          parse_mode: "HTML",
          reply_to_message_id: 999,
        },
      },
    ];

    for (const testCase of cases) {
      const sendVideoNote = vi.fn().mockResolvedValue({
        message_id: 301,
        chat: { id: chatId },
      });
      const sendMessage = vi.fn().mockResolvedValue({
        message_id: 302,
        chat: { id: chatId },
      });
      const api = { sendVideoNote, sendMessage } as unknown as {
        sendVideoNote: typeof sendVideoNote;
        sendMessage: typeof sendMessage;
      };

      loadWebMedia.mockResolvedValueOnce({
        buffer: Buffer.from("fake-video"),
        contentType: "video/mp4",
        fileName: "video.mp4",
      });

      const sendOptions: NonNullable<Parameters<typeof sendMessageTelegram>[2]> = {
        token: "tok",
        api,
        mediaUrl: "https://example.com/video.mp4",
        asVideoNote: true,
      };
      if (
        "replyToMessageId" in testCase.options &&
        testCase.options.replyToMessageId !== undefined
      ) {
        sendOptions.replyToMessageId = testCase.options.replyToMessageId;
      }
      if ("buttons" in testCase.options && testCase.options.buttons) {
        sendOptions.buttons = testCase.options.buttons;
      }
      await sendMessageTelegram(chatId, testCase.text, sendOptions);

      expect(sendVideoNote).toHaveBeenCalledWith(
        chatId,
        expect.anything(),
        testCase.expectedVideoNote,
      );
      expect(sendMessage).toHaveBeenCalledWith(chatId, testCase.text, testCase.expectedMessage);
    }
  });

  it("retries on transient errors with retry_after", async () => {
    vi.useFakeTimers();
    const chatId = "123";
    const err = Object.assign(new Error("429"), {
      parameters: { retry_after: 0.5 },
    });
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({
        message_id: 1,
        chat: { id: chatId },
      });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    const promise = sendMessageTelegram(chatId, "hi", {
      token: "tok",
      api,
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 1000, jitter: 0 },
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ messageId: "1", chatId });
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(500);
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it("does not retry on non-transient errors", async () => {
    const chatId = "123";
    const sendMessage = vi.fn().mockRejectedValue(new Error("400: Bad Request"));
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await expect(
      sendMessageTelegram(chatId, "hi", {
        token: "tok",
        api,
        retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toThrow(/Bad Request/);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("sends GIF media as animation", async () => {
    const chatId = "123";
    const sendAnimation = vi.fn().mockResolvedValue({
      message_id: 9,
      chat: { id: chatId },
    });
    const api = { sendAnimation } as unknown as {
      sendAnimation: typeof sendAnimation;
    };

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("GIF89a"),
      fileName: "fun.gif",
    });

    const res = await sendMessageTelegram(chatId, "caption", {
      token: "tok",
      api,
      mediaUrl: "https://example.com/fun",
    });

    expect(sendAnimation).toHaveBeenCalledTimes(1);
    expect(sendAnimation).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: "caption",
      parse_mode: "HTML",
    });
    expect(res.messageId).toBe("9");
  });

  it("routes audio media to sendAudio/sendVoice based on voice compatibility", async () => {
    const cases: Array<{
      name: string;
      chatId: string;
      text: string;
      mediaUrl: string;
      contentType: string;
      fileName: string;
      asVoice?: boolean;
      messageThreadId?: number;
      replyToMessageId?: number;
      expectedMethod: "sendAudio" | "sendVoice";
      expectedOptions: Record<string, unknown>;
    }> = [
      {
        name: "default audio send",
        chatId: "123",
        text: "caption",
        mediaUrl: "https://example.com/clip.mp3",
        contentType: "audio/mpeg",
        fileName: "clip.mp3",
        expectedMethod: "sendAudio" as const,
        expectedOptions: { caption: "caption", parse_mode: "HTML" },
      },
      {
        name: "voice-compatible media with thread params",
        chatId: "-1001234567890",
        text: "voice note",
        mediaUrl: "https://example.com/note.ogg",
        contentType: "audio/ogg",
        fileName: "note.ogg",
        asVoice: true,
        messageThreadId: 271,
        replyToMessageId: 500,
        expectedMethod: "sendVoice" as const,
        expectedOptions: {
          caption: "voice note",
          parse_mode: "HTML",
          message_thread_id: 271,
          reply_to_message_id: 500,
        },
      },
      {
        name: "asVoice fallback for non-voice media",
        chatId: "123",
        text: "caption",
        mediaUrl: "https://example.com/clip.wav",
        contentType: "audio/wav",
        fileName: "clip.wav",
        asVoice: true,
        expectedMethod: "sendAudio" as const,
        expectedOptions: { caption: "caption", parse_mode: "HTML" },
      },
      {
        name: "asVoice accepts mp3",
        chatId: "123",
        text: "caption",
        mediaUrl: "https://example.com/clip.mp3",
        contentType: "audio/mpeg",
        fileName: "clip.mp3",
        asVoice: true,
        expectedMethod: "sendVoice" as const,
        expectedOptions: { caption: "caption", parse_mode: "HTML" },
      },
    ];

    for (const testCase of cases) {
      const sendAudio = vi.fn().mockResolvedValue({
        message_id: 10,
        chat: { id: testCase.chatId },
      });
      const sendVoice = vi.fn().mockResolvedValue({
        message_id: 11,
        chat: { id: testCase.chatId },
      });
      const api = { sendAudio, sendVoice } as unknown as {
        sendAudio: typeof sendAudio;
        sendVoice: typeof sendVoice;
      };

      loadWebMedia.mockResolvedValueOnce({
        buffer: Buffer.from("audio"),
        contentType: testCase.contentType,
        fileName: testCase.fileName,
      });

      await sendMessageTelegram(testCase.chatId, testCase.text, {
        token: "tok",
        api,
        mediaUrl: testCase.mediaUrl,
        ...("asVoice" in testCase && testCase.asVoice ? { asVoice: true } : {}),
        ...("messageThreadId" in testCase && testCase.messageThreadId !== undefined
          ? { messageThreadId: testCase.messageThreadId }
          : {}),
        ...("replyToMessageId" in testCase && testCase.replyToMessageId !== undefined
          ? { replyToMessageId: testCase.replyToMessageId }
          : {}),
      });

      const called = testCase.expectedMethod === "sendVoice" ? sendVoice : sendAudio;
      const notCalled = testCase.expectedMethod === "sendVoice" ? sendAudio : sendVoice;
      expect(called, testCase.name).toHaveBeenCalledWith(
        testCase.chatId,
        expect.anything(),
        testCase.expectedOptions,
      );
      expect(notCalled, testCase.name).not.toHaveBeenCalled();
    }
  });

  it("keeps message_thread_id for forum/private/group sends", async () => {
    const cases = [
      {
        name: "forum topic",
        chatId: "-1001234567890",
        text: "hello forum",
        messageId: 55,
      },
      {
        name: "private chat topic (#18974)",
        chatId: "123456789",
        text: "hello private",
        messageId: 56,
      },
      {
        // Group/supergroup chats have negative IDs.
        name: "group chat (#17242)",
        chatId: "-1001234567890",
        text: "hello group",
        messageId: 57,
      },
    ] as const;

    for (const testCase of cases) {
      const sendMessage = vi.fn().mockResolvedValue({
        message_id: testCase.messageId,
        chat: { id: testCase.chatId },
      });
      const api = { sendMessage } as unknown as {
        sendMessage: typeof sendMessage;
      };

      await sendMessageTelegram(testCase.chatId, testCase.text, {
        token: "tok",
        api,
        messageThreadId: 271,
      });

      expect(sendMessage, testCase.name).toHaveBeenCalledWith(testCase.chatId, testCase.text, {
        parse_mode: "HTML",
        message_thread_id: 271,
      });
    }
  });

  it("retries sends without message_thread_id on thread-not-found", async () => {
    const cases = [
      { name: "forum", chatId: "-100123", text: "hello forum", messageId: 58 },
      { name: "private", chatId: "123456789", text: "hello private", messageId: 59 },
    ] as const;
    const threadErr = new Error("400: Bad Request: message thread not found");

    for (const testCase of cases) {
      const sendMessage = vi
        .fn()
        .mockRejectedValueOnce(threadErr)
        .mockResolvedValueOnce({
          message_id: testCase.messageId,
          chat: { id: testCase.chatId },
        });
      const api = { sendMessage } as unknown as {
        sendMessage: typeof sendMessage;
      };

      const res = await sendMessageTelegram(testCase.chatId, testCase.text, {
        token: "tok",
        api,
        messageThreadId: 271,
      });

      expect(sendMessage, testCase.name).toHaveBeenNthCalledWith(
        1,
        testCase.chatId,
        testCase.text,
        {
          parse_mode: "HTML",
          message_thread_id: 271,
        },
      );
      expect(sendMessage, testCase.name).toHaveBeenNthCalledWith(
        2,
        testCase.chatId,
        testCase.text,
        {
          parse_mode: "HTML",
        },
      );
      expect(res.messageId, testCase.name).toBe(String(testCase.messageId));
    }
  });

  it("does not retry on non-retriable thread/chat errors", async () => {
    const cases: Array<{
      chatId: string;
      text: string;
      error: Error;
      opts?: { messageThreadId?: number };
      expectedError: RegExp | string;
      expectedCallArgs: [string, string, { parse_mode: "HTML"; message_thread_id?: number }];
    }> = [
      {
        chatId: "123",
        text: "hello forum",
        error: new Error("400: Bad Request: message thread not found"),
        expectedError: "message thread not found",
        expectedCallArgs: ["123", "hello forum", { parse_mode: "HTML" }],
      },
      {
        chatId: "123456789",
        text: "hello private",
        error: new Error("400: Bad Request: chat not found"),
        opts: { messageThreadId: 271 },
        expectedError: /chat not found/i,
        expectedCallArgs: [
          "123456789",
          "hello private",
          { parse_mode: "HTML", message_thread_id: 271 },
        ],
      },
    ];

    for (const testCase of cases) {
      const sendMessage = vi.fn().mockRejectedValueOnce(testCase.error);
      const api = { sendMessage } as unknown as {
        sendMessage: typeof sendMessage;
      };

      await expect(
        sendMessageTelegram(testCase.chatId, testCase.text, {
          token: "tok",
          api,
          ...testCase.opts,
        }),
      ).rejects.toThrow(testCase.expectedError);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(...testCase.expectedCallArgs);
    }
  });

  it("sets disable_notification when silent is true", async () => {
    const chatId = "123";
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 1,
      chat: { id: chatId },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram(chatId, "hi", {
      token: "tok",
      api,
      silent: true,
    });

    expect(sendMessage).toHaveBeenCalledWith(chatId, "hi", {
      parse_mode: "HTML",
      disable_notification: true,
    });
  });

  it("parses message_thread_id from recipient string (telegram:group:...:topic:...)", async () => {
    const chatId = "-1001234567890";
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 55,
      chat: { id: chatId },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram(`telegram:group:${chatId}:topic:271`, "hello forum", {
      token: "tok",
      api,
    });

    expect(sendMessage).toHaveBeenCalledWith(chatId, "hello forum", {
      parse_mode: "HTML",
      message_thread_id: 271,
    });
  });

  it("retries media sends without message_thread_id when thread is missing", async () => {
    const chatId = "-100123";
    const threadErr = new Error("400: Bad Request: message thread not found");
    const sendPhoto = vi
      .fn()
      .mockRejectedValueOnce(threadErr)
      .mockResolvedValueOnce({
        message_id: 59,
        chat: { id: chatId },
      });
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    const res = await sendMessageTelegram(chatId, "photo", {
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
      messageThreadId: 271,
    });

    expect(sendPhoto).toHaveBeenNthCalledWith(1, chatId, expect.anything(), {
      caption: "photo",
      parse_mode: "HTML",
      message_thread_id: 271,
    });
    expect(sendPhoto).toHaveBeenNthCalledWith(2, chatId, expect.anything(), {
      caption: "photo",
      parse_mode: "HTML",
    });
    expect(res.messageId).toBe("59");
  });
});

describe("reactMessageTelegram", () => {
  it.each([
    {
      testName: "sends emoji reactions",
      target: "telegram:123",
      messageId: "456",
      emoji: "✅",
      remove: false,
      expected: [{ type: "emoji", emoji: "✅" }],
    },
    {
      testName: "removes reactions when emoji is empty",
      target: "123",
      messageId: 456,
      emoji: "",
      remove: false,
      expected: [],
    },
    {
      testName: "removes reactions when remove flag is set",
      target: "123",
      messageId: 456,
      emoji: "✅",
      remove: true,
      expected: [],
    },
  ] as const)("$testName", async (testCase) => {
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const api = { setMessageReaction } as unknown as {
      setMessageReaction: typeof setMessageReaction;
    };

    await reactMessageTelegram(testCase.target, testCase.messageId, testCase.emoji, {
      token: "tok",
      api,
      ...(testCase.remove ? { remove: true } : {}),
    });

    expect(setMessageReaction).toHaveBeenCalledWith("123", 456, testCase.expected);
  });
});

describe("sendStickerTelegram", () => {
  beforeEach(() => {
    loadConfig.mockReturnValue({});
    botApi.sendSticker.mockReset();
    botCtorSpy.mockReset();
  });

  const positiveSendCases = [
    {
      name: "sends a sticker by file_id",
      fileId: "CAACAgIAAxkBAAI...sticker_file_id",
      expectedFileId: "CAACAgIAAxkBAAI...sticker_file_id",
      expectedMessageId: 100,
      assertResult: true,
    },
    {
      name: "trims whitespace from fileId",
      fileId: "  fileId123  ",
      expectedFileId: "fileId123",
      expectedMessageId: 106,
      assertResult: false,
    },
  ] as const;

  for (const testCase of positiveSendCases) {
    it(testCase.name, async () => {
      const chatId = "123";
      const sendSticker = vi.fn().mockResolvedValue({
        message_id: testCase.expectedMessageId,
        chat: { id: chatId },
      });
      const api = { sendSticker } as unknown as {
        sendSticker: typeof sendSticker;
      };

      const res = await sendStickerTelegram(chatId, testCase.fileId, {
        token: "tok",
        api,
      });

      expect(sendSticker).toHaveBeenCalledWith(chatId, testCase.expectedFileId, undefined);
      if (testCase.assertResult) {
        expect(res.messageId).toBe(String(testCase.expectedMessageId));
        expect(res.chatId).toBe(chatId);
      }
    });
  }

  it("throws error when fileId is blank", async () => {
    for (const fileId of ["", "   "]) {
      await expect(sendStickerTelegram("123", fileId, { token: "tok" })).rejects.toThrow(
        /file_id is required/i,
      );
    }
  });

  it("retries sticker sends without message_thread_id when thread is missing", async () => {
    const chatId = "-100123";
    const threadErr = new Error("400: Bad Request: message thread not found");
    const sendSticker = vi
      .fn()
      .mockRejectedValueOnce(threadErr)
      .mockResolvedValueOnce({
        message_id: 109,
        chat: { id: chatId },
      });
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    const res = await sendStickerTelegram(chatId, "fileId123", {
      token: "tok",
      api,
      messageThreadId: 271,
    });

    expect(sendSticker).toHaveBeenNthCalledWith(1, chatId, "fileId123", {
      message_thread_id: 271,
    });
    expect(sendSticker).toHaveBeenNthCalledWith(2, chatId, "fileId123", undefined);
    expect(res.messageId).toBe("109");
  });
});

describe("shared send behaviors", () => {
  it("includes reply_to_message_id for threaded replies", async () => {
    const cases = [
      {
        name: "message send",
        run: async () => {
          const chatId = "123";
          const sendMessage = vi.fn().mockResolvedValue({
            message_id: 56,
            chat: { id: chatId },
          });
          const api = { sendMessage } as unknown as {
            sendMessage: typeof sendMessage;
          };
          await sendMessageTelegram(chatId, "reply text", {
            token: "tok",
            api,
            replyToMessageId: 100,
          });
          expect(sendMessage).toHaveBeenCalledWith(chatId, "reply text", {
            parse_mode: "HTML",
            reply_to_message_id: 100,
          });
        },
      },
      {
        name: "sticker send",
        run: async () => {
          const chatId = "123";
          const fileId = "CAACAgIAAxkBAAI...sticker_file_id";
          const sendSticker = vi.fn().mockResolvedValue({
            message_id: 102,
            chat: { id: chatId },
          });
          const api = { sendSticker } as unknown as {
            sendSticker: typeof sendSticker;
          };
          await sendStickerTelegram(chatId, fileId, {
            token: "tok",
            api,
            replyToMessageId: 500,
          });
          expect(sendSticker).toHaveBeenCalledWith(chatId, fileId, {
            reply_to_message_id: 500,
          });
        },
      },
    ] as const;

    for (const testCase of cases) {
      await testCase.run();
    }
  });

  it("wraps chat-not-found with actionable context", async () => {
    const cases = [
      {
        name: "message send",
        run: async () => {
          const chatId = "123";
          const err = new Error("400: Bad Request: chat not found");
          const sendMessage = vi.fn().mockRejectedValue(err);
          const api = { sendMessage } as unknown as {
            sendMessage: typeof sendMessage;
          };
          await expectChatNotFoundWithChatId(
            sendMessageTelegram(chatId, "hi", { token: "tok", api }),
            chatId,
          );
        },
      },
      {
        name: "sticker send",
        run: async () => {
          const chatId = "123";
          const err = new Error("400: Bad Request: chat not found");
          const sendSticker = vi.fn().mockRejectedValue(err);
          const api = { sendSticker } as unknown as {
            sendSticker: typeof sendSticker;
          };
          await expectChatNotFoundWithChatId(
            sendStickerTelegram(chatId, "fileId123", { token: "tok", api }),
            chatId,
          );
        },
      },
    ] as const;

    for (const testCase of cases) {
      await testCase.run();
    }
  });
});

describe("editMessageTelegram", () => {
  beforeEach(() => {
    botApi.editMessageText.mockReset();
    botCtorSpy.mockReset();
  });

  it("handles button payload + parse fallback behavior", async () => {
    const cases: Array<{
      name: string;
      setup: () => {
        text: string;
        buttons: Parameters<typeof buildInlineKeyboard>[0];
      };
      expectedCalls: number;
      firstExpectNoReplyMarkup?: boolean;
      firstExpectReplyMarkup?: Record<string, unknown>;
      secondExpectReplyMarkup?: Record<string, unknown>;
    }> = [
      {
        name: "buttons undefined keeps existing keyboard",
        setup: () => {
          botApi.editMessageText.mockResolvedValue({ message_id: 1, chat: { id: "123" } });
          return { text: "hi", buttons: undefined };
        },
        expectedCalls: 1,
        firstExpectNoReplyMarkup: true,
      },
      {
        name: "buttons empty clears keyboard",
        setup: () => {
          botApi.editMessageText.mockResolvedValue({ message_id: 1, chat: { id: "123" } });
          return { text: "hi", buttons: [] };
        },
        expectedCalls: 1,
        firstExpectReplyMarkup: { inline_keyboard: [] },
      },
      {
        name: "parse error fallback preserves cleared keyboard",
        setup: () => {
          botApi.editMessageText
            .mockRejectedValueOnce(new Error("400: Bad Request: can't parse entities"))
            .mockResolvedValueOnce({ message_id: 1, chat: { id: "123" } });
          return { text: "<bad> html", buttons: [] };
        },
        expectedCalls: 2,
        firstExpectReplyMarkup: { inline_keyboard: [] },
        secondExpectReplyMarkup: { inline_keyboard: [] },
      },
    ];

    for (const testCase of cases) {
      botApi.editMessageText.mockReset();
      botCtorSpy.mockReset();
      const input = testCase.setup();

      await editMessageTelegram("123", 1, input.text, {
        token: "tok",
        cfg: {},
        buttons: input.buttons ? input.buttons.map((row) => [...row]) : input.buttons,
      });

      expect(botCtorSpy, testCase.name).toHaveBeenCalledTimes(1);
      expect(botCtorSpy.mock.calls[0]?.[0], testCase.name).toBe("tok");
      expect(botApi.editMessageText, testCase.name).toHaveBeenCalledTimes(testCase.expectedCalls);

      const firstParams = (botApi.editMessageText.mock.calls[0] ?? [])[3] as Record<
        string,
        unknown
      >;
      expect(firstParams, testCase.name).toEqual(expect.objectContaining({ parse_mode: "HTML" }));
      if ("firstExpectNoReplyMarkup" in testCase && testCase.firstExpectNoReplyMarkup) {
        expect(firstParams, testCase.name).not.toHaveProperty("reply_markup");
      }
      if ("firstExpectReplyMarkup" in testCase && testCase.firstExpectReplyMarkup) {
        expect(firstParams, testCase.name).toEqual(
          expect.objectContaining({ reply_markup: testCase.firstExpectReplyMarkup }),
        );
      }

      if ("secondExpectReplyMarkup" in testCase && testCase.secondExpectReplyMarkup) {
        const secondParams = (botApi.editMessageText.mock.calls[1] ?? [])[3] as Record<
          string,
          unknown
        >;
        expect(secondParams, testCase.name).toEqual(
          expect.objectContaining({ reply_markup: testCase.secondExpectReplyMarkup }),
        );
      }
    }
  });

  it("treats 'message is not modified' as success", async () => {
    botApi.editMessageText.mockRejectedValueOnce(
      new Error(
        "400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      ),
    );

    await expect(
      editMessageTelegram("123", 1, "hi", {
        token: "tok",
        cfg: {},
      }),
    ).resolves.toEqual({ ok: true, messageId: "1", chatId: "123" });
    expect(botApi.editMessageText).toHaveBeenCalledTimes(1);
  });

  it("disables link previews when linkPreview is false", async () => {
    botApi.editMessageText.mockResolvedValue({ message_id: 1, chat: { id: "123" } });

    await editMessageTelegram("123", 1, "https://example.com", {
      token: "tok",
      cfg: {},
      linkPreview: false,
    });

    expect(botApi.editMessageText).toHaveBeenCalledTimes(1);
    const params = (botApi.editMessageText.mock.calls[0] ?? [])[3] as Record<string, unknown>;
    expect(params).toEqual(
      expect.objectContaining({
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }),
    );
  });
});

describe("sendPollTelegram", () => {
  it("maps durationSeconds to open_period", async () => {
    const api = {
      sendPoll: vi.fn(async () => ({ message_id: 123, chat: { id: 555 }, poll: { id: "p1" } })),
    };

    const res = await sendPollTelegram(
      "123",
      { question: " Q ", options: [" A ", "B "], durationSeconds: 60 },
      { token: "t", api: api as unknown as Bot["api"] },
    );

    expect(res).toEqual({ messageId: "123", chatId: "555", pollId: "p1" });
    expect(api.sendPoll).toHaveBeenCalledTimes(1);
    const sendPollMock = api.sendPoll as ReturnType<typeof vi.fn>;
    expect(sendPollMock.mock.calls[0]?.[0]).toBe("123");
    expect(sendPollMock.mock.calls[0]?.[1]).toBe("Q");
    expect(sendPollMock.mock.calls[0]?.[2]).toEqual(["A", "B"]);
    expect(sendPollMock.mock.calls[0]?.[3]).toMatchObject({ open_period: 60 });
  });

  it("retries without message_thread_id on thread-not-found", async () => {
    const api = {
      sendPoll: vi.fn(
        async (_chatId: string, _question: string, _options: string[], params: unknown) => {
          const p = params as { message_thread_id?: unknown } | undefined;
          if (p?.message_thread_id) {
            throw new Error("400: Bad Request: message thread not found");
          }
          return { message_id: 1, chat: { id: 2 }, poll: { id: "p2" } };
        },
      ),
    };

    const res = await sendPollTelegram(
      "-100123",
      { question: "Q", options: ["A", "B"] },
      { token: "t", api: api as unknown as Bot["api"], messageThreadId: 99 },
    );

    expect(res).toEqual({ messageId: "1", chatId: "2", pollId: "p2" });
    expect(api.sendPoll).toHaveBeenCalledTimes(2);
    expect(api.sendPoll.mock.calls[0]?.[3]).toMatchObject({ message_thread_id: 99 });
    expect(
      (api.sendPoll.mock.calls[1]?.[3] as { message_thread_id?: unknown } | undefined)
        ?.message_thread_id,
    ).toBeUndefined();
  });

  it("rejects durationHours for Telegram polls", async () => {
    const api = { sendPoll: vi.fn() };

    await expect(
      sendPollTelegram(
        "123",
        { question: "Q", options: ["A", "B"], durationHours: 1 },
        { token: "t", api: api as unknown as Bot["api"] },
      ),
    ).rejects.toThrow(/durationHours is not supported/i);

    expect(api.sendPoll).not.toHaveBeenCalled();
  });
});

describe("createForumTopicTelegram", () => {
  const cases = [
    {
      name: "uses base chat id when target includes topic suffix",
      target: "telegram:group:-1001234567890:topic:271",
      title: "x",
      response: { message_thread_id: 272, name: "Build Updates" },
      expectedCall: ["-1001234567890", "x", undefined] as const,
      expectedResult: {
        topicId: 272,
        name: "Build Updates",
        chatId: "-1001234567890",
      },
    },
    {
      name: "forwards optional icon fields",
      target: "-1001234567890",
      title: "Roadmap",
      response: { message_thread_id: 300, name: "Roadmap" },
      options: {
        iconColor: 0x6fb9f0,
        iconCustomEmojiId: "  1234567890  ",
      },
      expectedCall: [
        "-1001234567890",
        "Roadmap",
        { icon_color: 0x6fb9f0, icon_custom_emoji_id: "1234567890" },
      ] as const,
      expectedResult: {
        topicId: 300,
        name: "Roadmap",
        chatId: "-1001234567890",
      },
    },
  ] as const;

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const createForumTopic = vi.fn().mockResolvedValue(testCase.response);
      const api = { createForumTopic } as unknown as Bot["api"];

      const result = await createForumTopicTelegram(testCase.target, testCase.title, {
        token: "tok",
        api,
        ...testCase.options,
      });

      expect(createForumTopic).toHaveBeenCalledWith(...testCase.expectedCall);
      expect(result).toEqual(testCase.expectedResult);
    });
  }
});
