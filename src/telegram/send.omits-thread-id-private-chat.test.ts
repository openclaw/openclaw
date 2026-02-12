import { describe, expect, it, vi } from "vitest";

const { loadWebMedia } = vi.hoisted(() => ({
  loadWebMedia: vi.fn(),
}));

vi.mock("../web/media.js", () => ({
  loadWebMedia,
}));

vi.mock("grammy", () => ({
  Bot: class {
    api = {};
    catch = vi.fn();
    constructor(
      public token: string,
      public options?: { client?: { fetch?: typeof fetch } },
    ) {}
  },
  InputFile: class {},
}));

import { sendMessageTelegram, sendStickerTelegram } from "./send.js";

describe("sendMessageTelegram: private chat thread ID handling (#14742)", () => {
  it("omits message_thread_id when target is a private chat (positive numeric ID)", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 1,
      chat: { id: 123456789 },
    });
    const api = { sendMessage } as unknown as { sendMessage: typeof sendMessage };

    await sendMessageTelegram("123456789", "Hello", {
      token: "tok",
      api,
      messageThreadId: 42,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const callArgs = sendMessage.mock.calls[0];
    expect(callArgs[2]).not.toHaveProperty("message_thread_id");
  });

  it("omits message_thread_id for private chat even when target uses telegram: prefix", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 2,
      chat: { id: 987654321 },
    });
    const api = { sendMessage } as unknown as { sendMessage: typeof sendMessage };

    await sendMessageTelegram("telegram:987654321", "Hello", {
      token: "tok",
      api,
      messageThreadId: 99,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const callArgs = sendMessage.mock.calls[0];
    expect(callArgs[2]).not.toHaveProperty("message_thread_id");
  });

  it("includes message_thread_id when target is a group chat (negative numeric ID)", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 3,
      chat: { id: -1001234567890 },
    });
    const api = { sendMessage } as unknown as { sendMessage: typeof sendMessage };

    await sendMessageTelegram("-1001234567890", "Hello group", {
      token: "tok",
      api,
      messageThreadId: 271,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const callArgs = sendMessage.mock.calls[0];
    expect(callArgs[2]).toHaveProperty("message_thread_id", 271);
  });

  it("includes message_thread_id for group from target string with topic suffix", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 4,
      chat: { id: -1001234567890 },
    });
    const api = { sendMessage } as unknown as { sendMessage: typeof sendMessage };

    // Target format: chatId:topic:topicId
    await sendMessageTelegram("-1001234567890:topic:55", "Hello topic", {
      token: "tok",
      api,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const callArgs = sendMessage.mock.calls[0];
    expect(callArgs[2]).toHaveProperty("message_thread_id", 55);
  });

  it("omits message_thread_id for media sends to private chats", async () => {
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 5,
      chat: { id: 123456789 },
    });
    const api = { sendPhoto } as unknown as { sendPhoto: typeof sendPhoto };

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram("123456789", "photo caption", {
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
      messageThreadId: 42,
    });

    expect(sendPhoto).toHaveBeenCalledTimes(1);
    const callArgs = sendPhoto.mock.calls[0];
    expect(callArgs[2]).not.toHaveProperty("message_thread_id");
  });
});

describe("sendStickerTelegram: private chat thread ID handling (#14742)", () => {
  it("omits message_thread_id when target is a private chat", async () => {
    const sendSticker = vi.fn().mockResolvedValue({
      message_id: 10,
      chat: { id: 123456789 },
    });
    const api = { sendSticker } as unknown as { sendSticker: typeof sendSticker };

    await sendStickerTelegram("123456789", "file_id_123", {
      token: "tok",
      api,
      messageThreadId: 42,
    });

    expect(sendSticker).toHaveBeenCalledTimes(1);
    const callArgs = sendSticker.mock.calls[0];
    // Third arg is params; should be undefined or not contain message_thread_id
    const params = callArgs[2] as Record<string, unknown> | undefined;
    if (params) {
      expect(params).not.toHaveProperty("message_thread_id");
    }
  });

  it("includes message_thread_id when target is a group chat", async () => {
    const sendSticker = vi.fn().mockResolvedValue({
      message_id: 11,
      chat: { id: -1001234567890 },
    });
    const api = { sendSticker } as unknown as { sendSticker: typeof sendSticker };

    await sendStickerTelegram("-1001234567890", "file_id_123", {
      token: "tok",
      api,
      messageThreadId: 99,
    });

    expect(sendSticker).toHaveBeenCalledTimes(1);
    const callArgs = sendSticker.mock.calls[0];
    expect(callArgs[2]).toHaveProperty("message_thread_id", 99);
  });
});
