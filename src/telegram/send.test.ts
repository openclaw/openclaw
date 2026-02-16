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
  editMessageTelegram,
  reactMessageTelegram,
  sendMessageTelegram,
  sendPollTelegram,
  sendStickerTelegram,
} = await importTelegramSendModule();

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
  it("returns undefined for empty input", () => {
    expect(buildInlineKeyboard()).toBeUndefined();
    expect(buildInlineKeyboard([])).toBeUndefined();
  });

  it("builds inline keyboards for valid input", () => {
    const result = buildInlineKeyboard([
      [{ text: "Option A", callback_data: "cmd:a" }],
      [
        { text: "Option B", callback_data: "cmd:b" },
        { text: "Option C", callback_data: "cmd:c" },
      ],
    ]);
    expect(result).toEqual({
      inline_keyboard: [
        [{ text: "Option A", callback_data: "cmd:a" }],
        [
          { text: "Option B", callback_data: "cmd:b" },
          { text: "Option C", callback_data: "cmd:c" },
        ],
      ],
    });
  });

  it("filters invalid buttons and empty rows", () => {
    const result = buildInlineKeyboard([
      [
        { text: "", callback_data: "cmd:skip" },
        { text: "Ok", callback_data: "cmd:ok" },
      ],
      [{ text: "Missing data", callback_data: "" }],
      [],
    ]);
    expect(result).toEqual({
      inline_keyboard: [[{ text: "Ok", callback_data: "cmd:ok" }]],
    });
  });
});

describe("sendMessageTelegram", () => {
  it("passes timeoutSeconds to grammY client when configured", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { timeoutSeconds: 60 } },
    });
    await sendMessageTelegram("123", "hi", { token: "tok" });
    expect(botCtorSpy).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ timeoutSeconds: 60 }),
      }),
    );
  });
  it("prefers per-account timeoutSeconds overrides", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          timeoutSeconds: 60,
          accounts: { foo: { timeoutSeconds: 61 } },
        },
      },
    });
    await sendMessageTelegram("123", "hi", { token: "tok", accountId: "foo" });
    expect(botCtorSpy).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ timeoutSeconds: 61 }),
      }),
    );
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

  it("adds link_preview_options when previews are disabled in config", async () => {
    const chatId = "123";
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 7,
      chat: { id: chatId },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    loadConfig.mockReturnValue({
      channels: { telegram: { linkPreview: false } },
    });

    await sendMessageTelegram(chatId, "hi", { token: "tok", api });

    expect(sendMessage).toHaveBeenCalledWith(chatId, "hi", {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  it("keeps link_preview_options on plain-text fallback when disabled", async () => {
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

    loadConfig.mockReturnValue({
      channels: { telegram: { linkPreview: false } },
    });

    await sendMessageTelegram(chatId, "_oops_", {
      token: "tok",
      api,
    });

    expect(sendMessage).toHaveBeenNthCalledWith(1, chatId, "<i>oops</i>", {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, chatId, "_oops_", {
      link_preview_options: { is_disabled: true },
    });
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

  it("wraps chat-not-found with actionable context", async () => {
    const chatId = "123";
    const err = new Error("400: Bad Request: chat not found");
    const sendMessage = vi.fn().mockRejectedValue(err);
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await expect(sendMessageTelegram(chatId, "hi", { token: "tok", api })).rejects.toThrow(
      /chat not found/i,
    );
    await expect(sendMessageTelegram(chatId, "hi", { token: "tok", api })).rejects.toThrow(
      /chat_id=123/,
    );
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

  it("sends video as video note when asVideoNote is true", async () => {
    const chatId = "123";
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
  });

  it("sends regular video when asVideoNote is false", async () => {
    const chatId = "123";
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
  });

  it("adds reply_markup to separate text message for video notes", async () => {
    const chatId = "123";
    const text = "Check this out";

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

    await sendMessageTelegram(chatId, text, {
      token: "tok",
      api,
      mediaUrl: "https://example.com/video.mp4",
      asVideoNote: true,
      buttons: [[{ text: "Btn", callback_data: "dat" }]],
    });

    expect(sendVideoNote).toHaveBeenCalledWith(chatId, expect.anything(), {});
    expect(sendMessage).toHaveBeenCalledWith(chatId, text, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "Btn", callback_data: "dat" }]],
      },
    });
  });

  it("threads video note and text message correctly", async () => {
    const chatId = "123";
    const text = "Threaded reply";

    const sendVideoNote = vi.fn().mockResolvedValue({
      message_id: 401,
      chat: { id: chatId },
    });
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 402,
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

    await sendMessageTelegram(chatId, text, {
      token: "tok",
      api,
      mediaUrl: "https://example.com/video.mp4",
      asVideoNote: true,
      replyToMessageId: 999,
    });

    expect(sendVideoNote).toHaveBeenCalledWith(chatId, expect.anything(), {
      reply_to_message_id: 999,
    });
    expect(sendMessage).toHaveBeenCalledWith(chatId, text, {
      parse_mode: "HTML",
      reply_to_message_id: 999,
    });
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

  it("sends audio media as files by default", async () => {
    const chatId = "123";
    const sendAudio = vi.fn().mockResolvedValue({
      message_id: 10,
      chat: { id: chatId },
    });
    const sendVoice = vi.fn().mockResolvedValue({
      message_id: 11,
      chat: { id: chatId },
    });
    const api = { sendAudio, sendVoice } as unknown as {
      sendAudio: typeof sendAudio;
      sendVoice: typeof sendVoice;
    };

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("audio"),
      contentType: "audio/mpeg",
      fileName: "clip.mp3",
    });

    await sendMessageTelegram(chatId, "caption", {
      token: "tok",
      api,
      mediaUrl: "https://example.com/clip.mp3",
    });

    expect(sendAudio).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: "caption",
      parse_mode: "HTML",
    });
    expect(sendVoice).not.toHaveBeenCalled();
  });

  it("sends voice messages when asVoice is true and preserves thread params", async () => {
    const chatId = "-1001234567890";
    const sendAudio = vi.fn().mockResolvedValue({
      message_id: 12,
      chat: { id: chatId },
    });
    const sendVoice = vi.fn().mockResolvedValue({
      message_id: 13,
      chat: { id: chatId },
    });
    const api = { sendAudio, sendVoice } as unknown as {
      sendAudio: typeof sendAudio;
      sendVoice: typeof sendVoice;
    };

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      fileName: "note.ogg",
    });

    await sendMessageTelegram(chatId, "voice note", {
      token: "tok",
      api,
      mediaUrl: "https://example.com/note.ogg",
      asVoice: true,
      messageThreadId: 271,
      replyToMessageId: 500,
    });

    expect(sendVoice).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: "voice note",
      parse_mode: "HTML",
      message_thread_id: 271,
      reply_to_message_id: 500,
    });
    expect(sendAudio).not.toHaveBeenCalled();
  });

  it("falls back to audio when asVoice is true but media is not voice compatible", async () => {
    const chatId = "123";
    const sendAudio = vi.fn().mockResolvedValue({
      message_id: 14,
      chat: { id: chatId },
    });
    const sendVoice = vi.fn().mockResolvedValue({
      message_id: 15,
      chat: { id: chatId },
    });
    const api = { sendAudio, sendVoice } as unknown as {
      sendAudio: typeof sendAudio;
      sendVoice: typeof sendVoice;
    };

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("audio"),
      contentType: "audio/wav",
      fileName: "clip.wav",
    });

    await sendMessageTelegram(chatId, "caption", {
      token: "tok",
      api,
      mediaUrl: "https://example.com/clip.wav",
      asVoice: true,
    });

    expect(sendAudio).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: "caption",
      parse_mode: "HTML",
    });
    expect(sendVoice).not.toHaveBeenCalled();
  });

  it("sends MP3 as voice when asVoice is true", async () => {
    const chatId = "123";
    const sendAudio = vi.fn().mockResolvedValue({
      message_id: 16,
      chat: { id: chatId },
    });
    const sendVoice = vi.fn().mockResolvedValue({
      message_id: 17,
      chat: { id: chatId },
    });
    const api = { sendAudio, sendVoice } as unknown as {
      sendAudio: typeof sendAudio;
      sendVoice: typeof sendVoice;
    };

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("audio"),
      contentType: "audio/mpeg",
      fileName: "clip.mp3",
    });

    await sendMessageTelegram(chatId, "caption", {
      token: "tok",
      api,
      mediaUrl: "https://example.com/clip.mp3",
      asVoice: true,
    });

    expect(sendVoice).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: "caption",
      parse_mode: "HTML",
    });
    expect(sendAudio).not.toHaveBeenCalled();
  });

  it("includes message_thread_id for forum topic messages", async () => {
    const chatId = "-1001234567890";
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 55,
      chat: { id: chatId },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram(chatId, "hello forum", {
      token: "tok",
      api,
      messageThreadId: 271,
    });

    expect(sendMessage).toHaveBeenCalledWith(chatId, "hello forum", {
      parse_mode: "HTML",
      message_thread_id: 271,
    });
  });

  it("retries without message_thread_id when Telegram reports missing thread", async () => {
    const chatId = "123";
    const threadErr = new Error("400: Bad Request: message thread not found");
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(threadErr)
      .mockResolvedValueOnce({
        message_id: 58,
        chat: { id: chatId },
      });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    const res = await sendMessageTelegram(chatId, "hello forum", {
      token: "tok",
      api,
      messageThreadId: 271,
    });

    expect(sendMessage).toHaveBeenNthCalledWith(1, chatId, "hello forum", {
      parse_mode: "HTML",
      message_thread_id: 271,
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, chatId, "hello forum", {
      parse_mode: "HTML",
    });
    expect(res.messageId).toBe("58");
  });

  it("does not retry thread-not-found when no message_thread_id was provided", async () => {
    const chatId = "123";
    const threadErr = new Error("400: Bad Request: message thread not found");
    const sendMessage = vi.fn().mockRejectedValueOnce(threadErr);
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await expect(
      sendMessageTelegram(chatId, "hello forum", {
        token: "tok",
        api,
      }),
    ).rejects.toThrow("message thread not found");
    expect(sendMessage).toHaveBeenCalledTimes(1);
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

  it("includes reply_to_message_id for threaded replies", async () => {
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
  });

  it("includes both thread and reply params for forum topic replies", async () => {
    const chatId = "-1001234567890";
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 57,
      chat: { id: chatId },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram(chatId, "forum reply", {
      token: "tok",
      api,
      messageThreadId: 271,
      replyToMessageId: 500,
    });

    expect(sendMessage).toHaveBeenCalledWith(chatId, "forum reply", {
      parse_mode: "HTML",
      message_thread_id: 271,
      reply_to_message_id: 500,
    });
  });

  it("retries media sends without message_thread_id when thread is missing", async () => {
    const chatId = "123";
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
  it("sends emoji reactions", async () => {
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const api = { setMessageReaction } as unknown as {
      setMessageReaction: typeof setMessageReaction;
    };

    await reactMessageTelegram("telegram:123", "456", "✅", {
      token: "tok",
      api,
    });

    expect(setMessageReaction).toHaveBeenCalledWith("123", 456, [{ type: "emoji", emoji: "✅" }]);
  });

  it("removes reactions when emoji is empty", async () => {
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const api = { setMessageReaction } as unknown as {
      setMessageReaction: typeof setMessageReaction;
    };

    await reactMessageTelegram("123", 456, "", {
      token: "tok",
      api,
    });

    expect(setMessageReaction).toHaveBeenCalledWith("123", 456, []);
  });

  it("removes reactions when remove flag is set", async () => {
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const api = { setMessageReaction } as unknown as {
      setMessageReaction: typeof setMessageReaction;
    };

    await reactMessageTelegram("123", 456, "✅", {
      token: "tok",
      api,
      remove: true,
    });

    expect(setMessageReaction).toHaveBeenCalledWith("123", 456, []);
  });
});

describe("sendStickerTelegram", () => {
  beforeEach(() => {
    loadConfig.mockReturnValue({});
    botApi.sendSticker.mockReset();
    botCtorSpy.mockReset();
  });

  it("sends a sticker by file_id", async () => {
    const chatId = "123";
    const fileId = "CAACAgIAAxkBAAI...sticker_file_id";
    const sendSticker = vi.fn().mockResolvedValue({
      message_id: 100,
      chat: { id: chatId },
    });
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    const res = await sendStickerTelegram(chatId, fileId, {
      token: "tok",
      api,
    });

    expect(sendSticker).toHaveBeenCalledWith(chatId, fileId, undefined);
    expect(res.messageId).toBe("100");
    expect(res.chatId).toBe(chatId);
  });

  it("throws error when fileId is blank", async () => {
    for (const fileId of ["", "   "]) {
      await expect(sendStickerTelegram("123", fileId, { token: "tok" })).rejects.toThrow(
        /file_id is required/i,
      );
    }
  });

  it("includes message_thread_id for forum topic messages", async () => {
    const chatId = "-1001234567890";
    const fileId = "CAACAgIAAxkBAAI...sticker_file_id";
    const sendSticker = vi.fn().mockResolvedValue({
      message_id: 101,
      chat: { id: chatId },
    });
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    await sendStickerTelegram(chatId, fileId, {
      token: "tok",
      api,
      messageThreadId: 271,
    });

    expect(sendSticker).toHaveBeenCalledWith(chatId, fileId, {
      message_thread_id: 271,
    });
  });

  it("retries sticker sends without message_thread_id when thread is missing", async () => {
    const chatId = "123";
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

  it("includes reply_to_message_id for threaded replies", async () => {
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
  });

  it("includes both thread and reply params for forum topic replies", async () => {
    const chatId = "-1001234567890";
    const fileId = "CAACAgIAAxkBAAI...sticker_file_id";
    const sendSticker = vi.fn().mockResolvedValue({
      message_id: 103,
      chat: { id: chatId },
    });
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    await sendStickerTelegram(chatId, fileId, {
      token: "tok",
      api,
      messageThreadId: 271,
      replyToMessageId: 500,
    });

    expect(sendSticker).toHaveBeenCalledWith(chatId, fileId, {
      message_thread_id: 271,
      reply_to_message_id: 500,
    });
  });

  it("normalizes chat ids with internal prefixes", async () => {
    const sendSticker = vi.fn().mockResolvedValue({
      message_id: 104,
      chat: { id: "123" },
    });
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    await sendStickerTelegram("telegram:123", "fileId123", {
      token: "tok",
      api,
    });

    expect(sendSticker).toHaveBeenCalledWith("123", "fileId123", undefined);
  });

  it("parses message_thread_id from recipient string (telegram:group:...:topic:...)", async () => {
    const chatId = "-1001234567890";
    const sendSticker = vi.fn().mockResolvedValue({
      message_id: 105,
      chat: { id: chatId },
    });
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    await sendStickerTelegram(`telegram:group:${chatId}:topic:271`, "fileId123", {
      token: "tok",
      api,
    });

    expect(sendSticker).toHaveBeenCalledWith(chatId, "fileId123", {
      message_thread_id: 271,
    });
  });

  it("wraps chat-not-found with actionable context", async () => {
    const chatId = "123";
    const err = new Error("400: Bad Request: chat not found");
    const sendSticker = vi.fn().mockRejectedValue(err);
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    await expect(sendStickerTelegram(chatId, "fileId123", { token: "tok", api })).rejects.toThrow(
      /chat not found/i,
    );
    await expect(sendStickerTelegram(chatId, "fileId123", { token: "tok", api })).rejects.toThrow(
      /chat_id=123/,
    );
  });

  it("trims whitespace from fileId", async () => {
    const chatId = "123";
    const sendSticker = vi.fn().mockResolvedValue({
      message_id: 106,
      chat: { id: chatId },
    });
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    await sendStickerTelegram(chatId, "  fileId123  ", {
      token: "tok",
      api,
    });

    expect(sendSticker).toHaveBeenCalledWith(chatId, "fileId123", undefined);
  });
});

describe("editMessageTelegram", () => {
  beforeEach(() => {
    botApi.editMessageText.mockReset();
    botCtorSpy.mockReset();
  });

  it("keeps existing buttons when buttons is undefined (no reply_markup)", async () => {
    botApi.editMessageText.mockResolvedValue({ message_id: 1, chat: { id: "123" } });

    await editMessageTelegram("123", 1, "hi", {
      token: "tok",
      cfg: {},
    });

    expect(botCtorSpy).toHaveBeenCalledTimes(1);
    expect(botCtorSpy.mock.calls[0]?.[0]).toBe("tok");
    expect(botApi.editMessageText).toHaveBeenCalledTimes(1);
    const params = (botApi.editMessageText.mock.calls[0] ?? [])[3] as Record<string, unknown>;
    expect(params).toEqual(expect.objectContaining({ parse_mode: "HTML" }));
    expect(params).not.toHaveProperty("reply_markup");
  });

  it("removes buttons when buttons is empty (reply_markup.inline_keyboard = [])", async () => {
    botApi.editMessageText.mockResolvedValue({ message_id: 1, chat: { id: "123" } });

    await editMessageTelegram("123", 1, "hi", {
      token: "tok",
      cfg: {},
      buttons: [],
    });

    expect(botApi.editMessageText).toHaveBeenCalledTimes(1);
    const params = (botApi.editMessageText.mock.calls[0] ?? [])[3] as Record<string, unknown>;
    expect(params).toEqual(
      expect.objectContaining({
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      }),
    );
  });

  it("falls back to plain text when Telegram HTML parse fails (and preserves reply_markup)", async () => {
    botApi.editMessageText
      .mockRejectedValueOnce(new Error("400: Bad Request: can't parse entities"))
      .mockResolvedValueOnce({ message_id: 1, chat: { id: "123" } });

    await editMessageTelegram("123", 1, "<bad> html", {
      token: "tok",
      cfg: {},
      buttons: [],
    });

    expect(botApi.editMessageText).toHaveBeenCalledTimes(2);

    const firstParams = (botApi.editMessageText.mock.calls[0] ?? [])[3] as Record<string, unknown>;
    expect(firstParams).toEqual(
      expect.objectContaining({
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      }),
    );

    const secondParams = (botApi.editMessageText.mock.calls[1] ?? [])[3] as Record<string, unknown>;
    expect(secondParams).toEqual(
      expect.objectContaining({
        reply_markup: { inline_keyboard: [] },
      }),
    );
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
    expect(api.sendPoll.mock.calls[0]?.[0]).toBe("123");
    expect(api.sendPoll.mock.calls[0]?.[1]).toBe("Q");
    expect(api.sendPoll.mock.calls[0]?.[2]).toEqual(["A", "B"]);
    expect(api.sendPoll.mock.calls[0]?.[3]).toMatchObject({ open_period: 60 });
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
      "123",
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
