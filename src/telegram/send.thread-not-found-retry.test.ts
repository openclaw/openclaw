import { describe, expect, it, vi } from "vitest";

const { botApi, botCtorSpy } = vi.hoisted(() => ({
  botApi: {
    sendMessage: vi.fn(),
    sendPhoto: vi.fn(),
    setMessageReaction: vi.fn(),
  },
  botCtorSpy: vi.fn(),
}));

const { loadWebMedia } = vi.hoisted(() => ({
  loadWebMedia: vi.fn(),
}));

vi.mock("../web/media.js", () => ({
  loadWebMedia,
}));

vi.mock("grammy", () => ({
  Bot: class {
    api = botApi;
    catch = vi.fn();
    constructor(
      public token: string,
      public options?: { client?: { fetch?: typeof fetch } },
    ) {
      botCtorSpy(token, options);
    }
  },
  InputFile: class {},
}));

import { sendMessageTelegram } from "./send.js";

describe("sendMessageTelegram thread-not-found retry", () => {
  it("retries without message_thread_id when Telegram returns 'message thread not found'", async () => {
    const chatId = "123456789";
    const threadNotFoundErr = new Error("400: Bad Request: message thread not found");
    const sendMessage = vi
      .fn()
      // First call: fails with thread not found
      .mockRejectedValueOnce(threadNotFoundErr)
      // Second call (retry without thread): succeeds
      .mockResolvedValueOnce({
        message_id: 42,
        chat: { id: chatId },
      });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    const res = await sendMessageTelegram(chatId, "Hello!", {
      token: "tok",
      api,
      messageThreadId: 271,
    });

    // First call: with message_thread_id
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      chatId,
      expect.any(String),
      expect.objectContaining({ message_thread_id: 271 }),
    );
    // Second call: without message_thread_id
    const secondCallArgs = sendMessage.mock.calls[1];
    expect(secondCallArgs[0]).toBe(chatId);
    // The retry should NOT include message_thread_id
    const secondParams = secondCallArgs[2];
    expect(secondParams?.message_thread_id).toBeUndefined();

    expect(res.messageId).toBe("42");
  });

  it("does not retry for other 400 errors", async () => {
    const chatId = "123456789";
    const chatNotFoundErr = new Error("400: Bad Request: chat not found");
    const sendMessage = vi.fn().mockRejectedValue(chatNotFoundErr);
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await expect(
      sendMessageTelegram(chatId, "Hello!", {
        token: "tok",
        api,
        messageThreadId: 271,
      }),
    ).rejects.toThrow();

    // Should only be called once (no retry)
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not retry when no message_thread_id was set", async () => {
    const chatId = "123456789";
    const threadNotFoundErr = new Error("400: Bad Request: message thread not found");
    const sendMessage = vi.fn().mockRejectedValue(threadNotFoundErr);
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await expect(
      sendMessageTelegram(chatId, "Hello!", {
        token: "tok",
        api,
        // No messageThreadId set
      }),
    ).rejects.toThrow("message thread not found");

    // Should only be called once (no retry since no thread id was set)
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("retries media sends without message_thread_id on thread-not-found", async () => {
    const chatId = "-1001234567890";
    const threadNotFoundErr = new Error("400: Bad Request: message thread not found");
    const sendPhoto = vi
      .fn()
      .mockRejectedValueOnce(threadNotFoundErr)
      .mockResolvedValueOnce({
        message_id: 99,
        chat: { id: chatId },
      });

    loadWebMedia.mockResolvedValue({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    const api = {
      sendPhoto,
      sendMessage: vi.fn(),
    } as unknown as {
      sendPhoto: typeof sendPhoto;
      sendMessage: (typeof botApi)["sendMessage"];
    };

    const res = await sendMessageTelegram(chatId, "Check this out", {
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
      messageThreadId: 55,
    });

    // First call: with message_thread_id
    expect(sendPhoto).toHaveBeenNthCalledWith(
      1,
      chatId,
      expect.anything(),
      expect.objectContaining({ message_thread_id: 55 }),
    );
    // Second call (retry): without message_thread_id
    const secondCallArgs = sendPhoto.mock.calls[1];
    expect(secondCallArgs[2]?.message_thread_id).toBeUndefined();

    expect(res.messageId).toBe("99");
  });
});
