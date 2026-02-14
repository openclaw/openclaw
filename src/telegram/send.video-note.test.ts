import { describe, expect, it, vi } from "vitest";
import {
  getTelegramSendTestMocks,
  importTelegramSendModule,
  installTelegramSendTestHooks,
} from "./send.test-harness.js";

installTelegramSendTestHooks();

const { loadWebMedia } = getTelegramSendTestMocks();
const { sendMessageTelegram } = await importTelegramSendModule();

describe("sendMessageTelegram video notes", () => {
  it("sends video as video note when asVideoNote is true", async () => {
    const chatId = "123";
    const text = "ignored caption context"; // Should be sent separately

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

    // Video note sent WITHOUT caption (video notes cannot have captions)
    expect(sendVideoNote).toHaveBeenCalledWith(chatId, expect.anything(), {});

    // Text sent as separate message
    expect(sendMessage).toHaveBeenCalledWith(chatId, text, {
      parse_mode: "HTML",
    });

    // Returns the text message ID as it is the "main" content with text
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

    // Regular video sent WITH caption
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

    // Video note sent WITHOUT reply_markup (it goes to text)
    expect(sendVideoNote).toHaveBeenCalledWith(chatId, expect.anything(), {});

    // Text message gets reply markup
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

    // Video note threaded
    expect(sendVideoNote).toHaveBeenCalledWith(chatId, expect.anything(), {
      reply_to_message_id: 999,
    });

    // Text threaded
    expect(sendMessage).toHaveBeenCalledWith(chatId, text, {
      parse_mode: "HTML",
      reply_to_message_id: 999,
    });
  });
});
