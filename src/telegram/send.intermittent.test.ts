import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { botApi, botCtorSpy } = vi.hoisted(() => ({
  botApi: {
    sendMessage: vi.fn(),
    editMessageText: vi.fn(),
  },
  botCtorSpy: vi.fn(),
}));

vi.mock("grammy", () => ({
  Bot: class {
    api = botApi;
    constructor(
      public token: string,
      public options?: {
        client?: { fetch?: typeof fetch; timeoutSeconds?: number };
      },
    ) {
      botCtorSpy(token, options);
    }
  },
  InputFile: class {},
}));

const { loadConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
}));
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig,
  };
});

const { getLastSentMessage, recordSentMessage, getLastStatusMessage, recordStatusMessage } =
  vi.hoisted(() => ({
    getLastSentMessage: vi.fn(),
    recordSentMessage: vi.fn(),
    getLastStatusMessage: vi.fn(),
    recordStatusMessage: vi.fn(),
  }));

vi.mock("./sent-message-cache.js", () => ({
  getLastSentMessage,
  recordSentMessage,
  getLastStatusMessage,
  recordStatusMessage,
}));

import { sendMessageTelegram } from "./send.js";

describe("sendMessageTelegram status message editing", () => {
  beforeEach(() => {
    loadConfig.mockReturnValue({});
    botApi.sendMessage.mockReset();
    botApi.editMessageText.mockReset();
    getLastSentMessage.mockReset();
    recordSentMessage.mockReset();
    getLastStatusMessage.mockReset();
    recordStatusMessage.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends new message if isStatusMessage is false (reversion check)", async () => {
    const chatId = "123";
    const text = "Hello";

    botApi.sendMessage.mockResolvedValue({
      message_id: 100,
      chat: { id: chatId },
    });
    // Even if we have a recent status message, it should be ignored if isStatusMessage is false
    const now = 100000;
    vi.setSystemTime(now);
    getLastStatusMessage.mockReturnValue({
      messageId: 99,
      timestamp: now - 1000,
    });

    await sendMessageTelegram(chatId, text, { token: "tok" });

    expect(botApi.sendMessage).toHaveBeenCalledWith(chatId, text, expect.anything());
    expect(botApi.editMessageText).not.toHaveBeenCalled();
    expect(recordSentMessage).toHaveBeenCalledWith(chatId, 100);
    expect(recordStatusMessage).not.toHaveBeenCalled();
  });

  it("sends new message if no previous status message", async () => {
    const chatId = "123";
    const text = "Status update";

    botApi.sendMessage.mockResolvedValue({
      message_id: 100,
      chat: { id: chatId },
    });
    getLastStatusMessage.mockReturnValue(undefined);

    await sendMessageTelegram(chatId, text, { token: "tok", isStatusMessage: true });

    expect(botApi.sendMessage).toHaveBeenCalledWith(chatId, text, expect.anything());
    expect(botApi.editMessageText).not.toHaveBeenCalled();
    expect(recordStatusMessage).toHaveBeenCalledWith(chatId, 100);
  });

  it("edits previous status message if sent < 10s ago", async () => {
    const chatId = "123";
    const text = "Updated status";
    const lastMsgId = 100;

    // Setup last sent message 5s ago
    const now = 100000;
    vi.setSystemTime(now);
    getLastStatusMessage.mockReturnValue({
      messageId: lastMsgId,
      timestamp: now - 5000,
    });

    botApi.editMessageText.mockResolvedValue(true);

    const res = await sendMessageTelegram(chatId, text, { token: "tok", isStatusMessage: true });

    expect(botApi.editMessageText).toHaveBeenCalledWith(
      chatId,
      lastMsgId,
      text,
      expect.objectContaining({ parse_mode: "HTML" }),
    );
    expect(botApi.sendMessage).not.toHaveBeenCalled();
    expect(res.messageId).toBe("100");
    // Should update timestamp for same messageId
    expect(recordStatusMessage).toHaveBeenCalledWith(chatId, lastMsgId);
  });

  it("sends new message if status sent > 10s ago", async () => {
    const chatId = "123";
    const text = "New status";
    const lastMsgId = 100;

    // Setup last sent message 11s ago
    const now = 100000;
    vi.setSystemTime(now);
    getLastStatusMessage.mockReturnValue({
      messageId: lastMsgId,
      timestamp: now - 11000,
    });

    botApi.sendMessage.mockResolvedValue({
      message_id: 101,
      chat: { id: chatId },
    });

    await sendMessageTelegram(chatId, text, { token: "tok", isStatusMessage: true });

    expect(botApi.sendMessage).toHaveBeenCalled();
    expect(botApi.editMessageText).not.toHaveBeenCalled();
    expect(recordStatusMessage).toHaveBeenCalledWith(chatId, 101);
  });

  it("falls back to send if edit fails", async () => {
    const chatId = "123";
    const text = "Updated status";
    const lastMsgId = 100;

    const now = 100000;
    vi.setSystemTime(now);
    getLastStatusMessage.mockReturnValue({
      messageId: lastMsgId,
      timestamp: now - 5000,
    });

    botApi.editMessageText.mockRejectedValue(new Error("Message not found"));
    botApi.sendMessage.mockResolvedValue({
      message_id: 102,
      chat: { id: chatId },
    });

    await sendMessageTelegram(chatId, text, { token: "tok", isStatusMessage: true });

    expect(botApi.editMessageText).toHaveBeenCalled();
    expect(botApi.sendMessage).toHaveBeenCalled(); // Fallback
    expect(recordStatusMessage).toHaveBeenCalledWith(chatId, 102);
  });

  it("treats 'message is not modified' error as success", async () => {
    const chatId = "123";
    const text = "Same status";
    const lastMsgId = 100;

    const now = 100000;
    vi.setSystemTime(now);
    getLastStatusMessage.mockReturnValue({
      messageId: lastMsgId,
      timestamp: now - 5000,
    });

    botApi.editMessageText.mockRejectedValue(
      new Error(
        "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      ),
    );

    const res = await sendMessageTelegram(chatId, text, { token: "tok", isStatusMessage: true });

    expect(botApi.editMessageText).toHaveBeenCalled();
    expect(botApi.sendMessage).not.toHaveBeenCalled();
    expect(res.messageId).toBe("100");
    // Should still update timestamp (treated as success)
    expect(recordStatusMessage).toHaveBeenCalledWith(chatId, lastMsgId);
  });

  it("includes buttons when editing status", async () => {
    const chatId = "123";
    const text = "Status with buttons";
    const lastMsgId = 100;
    const buttons = [[{ text: "Btn", callback_data: "data" }]];

    const now = 100000;
    vi.setSystemTime(now);
    getLastStatusMessage.mockReturnValue({
      messageId: lastMsgId,
      timestamp: now - 5000,
    });

    botApi.editMessageText.mockResolvedValue(true);

    await sendMessageTelegram(chatId, text, { token: "tok", buttons, isStatusMessage: true });

    expect(botApi.editMessageText).toHaveBeenCalledWith(
      chatId,
      lastMsgId,
      text,
      expect.objectContaining({
        reply_markup: { inline_keyboard: buttons },
      }),
    );
  });
});
