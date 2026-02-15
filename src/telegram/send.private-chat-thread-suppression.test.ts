import { describe, expect, it, vi } from "vitest";

vi.mock("../web/media.js", () => ({
  loadWebMedia: vi.fn(),
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

import { sendMessageTelegram, sendStickerTelegram, sendPollTelegram } from "./send.js";

describe("private chat message_thread_id suppression (#17242)", () => {
  it("sendMessageTelegram omits message_thread_id for private chats", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 1,
      chat: { id: 12345 },
    });
    const api = { sendMessage } as unknown as { sendMessage: typeof sendMessage };

    await sendMessageTelegram("12345", "hello", {
      token: "tok",
      api,
      messageThreadId: 999,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, , params] = sendMessage.mock.calls[0];
    expect(params).not.toHaveProperty("message_thread_id");
  });

  it("sendMessageTelegram preserves message_thread_id for group chats", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 1,
      chat: { id: -1001234567890 },
    });
    const api = { sendMessage } as unknown as { sendMessage: typeof sendMessage };

    await sendMessageTelegram("-1001234567890", "hello", {
      token: "tok",
      api,
      messageThreadId: 999,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, , params] = sendMessage.mock.calls[0];
    expect(params?.message_thread_id).toBe(999);
  });

  it("sendStickerTelegram omits message_thread_id for private chats", async () => {
    const sendSticker = vi.fn().mockResolvedValue({
      message_id: 2,
      chat: { id: 67890 },
    });
    const api = { sendSticker } as unknown as { sendSticker: typeof sendSticker };

    await sendStickerTelegram("67890", "sticker_file_id", {
      token: "tok",
      api,
      messageThreadId: 888,
    });

    expect(sendSticker).toHaveBeenCalledTimes(1);
    const [, , params] = sendSticker.mock.calls[0];
    // When thread is suppressed for private chats, params is undefined
    // (no thread params to pass) or an object without message_thread_id.
    if (params != null) {
      expect(params).not.toHaveProperty("message_thread_id");
    }
  });

  it("sendPollTelegram omits message_thread_id for private chats", async () => {
    const sendPoll = vi.fn().mockResolvedValue({
      message_id: 3,
      chat: { id: 11111 },
      poll: { id: "poll_1" },
    });
    const api = { sendPoll } as unknown as { sendPoll: typeof sendPoll };

    await sendPollTelegram(
      "11111",
      { question: "Test?", options: ["A", "B"], maxSelections: 1 },
      {
        token: "tok",
        api,
        messageThreadId: 777,
      },
    );

    expect(sendPoll).toHaveBeenCalledTimes(1);
    const [, , , params] = sendPoll.mock.calls[0];
    expect(params).not.toHaveProperty("message_thread_id");
  });
});
