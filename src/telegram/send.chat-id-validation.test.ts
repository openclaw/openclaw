import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendMessageTelegram } from "./send.js";

// Mock grammy
const { botApi, botCtorSpy } = vi.hoisted(() => ({
  botApi: {
    sendMessage: vi.fn(),
  },
  botCtorSpy: vi.fn(),
}));

vi.mock("grammy", () => ({
  Bot: class {
    api = botApi;
    catch = vi.fn();
    constructor(token: string, options?: any) {
      botCtorSpy(token, options);
    }
  },
  InputFile: class {},
  HttpError: class extends Error {},
}));

// Mock config
const { loadConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
}));
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, loadConfig };
});

describe("Telegram Chat ID Validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfig.mockReturnValue({ channels: { telegram: {} } });
  });

  it("sends to @username which fails for private users", async () => {
    // Simulate Telegram API rejection for @user
    botApi.sendMessage.mockImplementation(async (chatId: string | number) => {
      if (typeof chatId === "string" && chatId.startsWith("@")) {
        throw new Error("400: Bad Request: chat not found");
      }
      return { message_id: 1, chat: { id: 123 } };
    });

    const username = "@someuser";

    // This is what happens if the system tries to reply to a username
    await expect(sendMessageTelegram(username, "hello", { token: "tok" })).rejects.toThrow(
      /Telegram Bot API does NOT support sending messages to private users by @username/,
    );

    expect(botApi.sendMessage).toHaveBeenCalledWith(username, expect.anything(), expect.anything());

    // Also fails for 'telegram:@username' (internal prefix should be stripped but error still caught)
    await expect(
      sendMessageTelegram(`telegram:${username}`, "hello", { token: "tok" }),
    ).rejects.toThrow(
      /Telegram Bot API does NOT support sending messages to private users by @username/,
    );
  });

  it("normalizes 'telegram:123' to number 123", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 1, chat: { id: 123 } });

    await sendMessageTelegram("telegram:123", "hello", { token: "tok" });

    // Should convert string "123" to something Telegram accepts (string or number)
    // normalizeChatId returns string "123".
    expect(botApi.sendMessage).toHaveBeenCalledWith("123", expect.anything(), expect.anything());
  });
});
