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
    constructor(token: string, options?: unknown) {
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

const { makeProxyFetch } = vi.hoisted(() => ({
  makeProxyFetch: vi.fn(),
}));

const { resolveTelegramFetch } = vi.hoisted(() => ({
  resolveTelegramFetch: vi.fn(),
}));

const { resolveTelegramAccount } = vi.hoisted(() => ({
  resolveTelegramAccount: vi.fn(() => ({
    accountId: "default",
    config: {},
  })),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, loadConfig };
});

vi.mock("./proxy.js", () => ({
  makeProxyFetch,
}));

vi.mock("./fetch.js", () => ({
  resolveTelegramFetch,
}));

vi.mock("./accounts.js", () => ({
  resolveTelegramAccount,
}));

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

  it("normalizes 'telegram:123' to string '123'", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 1, chat: { id: 123 } });

    await sendMessageTelegram("telegram:123", "hello", { token: "tok" });

    expect(botApi.sendMessage).toHaveBeenCalledWith("123", expect.anything(), expect.anything());
  });

  it("normalizes 'https://t.me/somechannel' to '@somechannel'", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 1, chat: { id: 123 } });

    await sendMessageTelegram("https://t.me/somechannel", "hello", { token: "tok" });

    expect(botApi.sendMessage).toHaveBeenCalledWith(
      "@somechannel",
      expect.anything(),
      expect.anything(),
    );
  });

  it("tightens username regex: '12345' remains '12345' (cannot start with digit)", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 1, chat: { id: 12345 } });

    await sendMessageTelegram("12345", "hello", { token: "tok" });

    // Should NOT be prefixed with @ because it starts with a digit
    expect(botApi.sendMessage).toHaveBeenCalledWith("12345", expect.anything(), expect.anything());
  });

  it("tightens username regex: 'user1' becomes '@user1' (starts with letter)", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 1, chat: { id: 123 } });

    await sendMessageTelegram("user1", "hello", { token: "tok" });

    expect(botApi.sendMessage).toHaveBeenCalledWith("@user1", expect.anything(), expect.anything());
  });

  it("handles negative numeric IDs (groups/supergroups)", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 1, chat: { id: -100123456 } });

    await sendMessageTelegram("-100123456", "hello", { token: "tok" });

    expect(botApi.sendMessage).toHaveBeenCalledWith(
      "-100123456",
      expect.anything(),
      expect.anything(),
    );
  });

  it("throws enhanced error for failed action with @username", async () => {
    botApi.sendMessage.mockRejectedValue(new Error("400: Bad Request: chat not found"));

    await expect(sendMessageTelegram("@someuser", "hello", { token: "tok" })).rejects.toThrow(
      /Telegram Bot API does NOT support sending messages to private users by @username/,
    );
  });

  it("provides consistent error wrapping for editMessageTelegram", async () => {
    // Mock editMessageText to fail
    botApi.editMessageText = vi
      .fn()
      .mockRejectedValue(new Error("400: Bad Request: chat not found"));

    await expect(
      import("./send.js").then((m) =>
        m.editMessageTelegram("@someuser", 1, "new text", { token: "tok" }),
      ),
    ).rejects.toThrow(/Telegram action failed: chat not found/);
  });

  it("throws error for empty recipient", async () => {
    await expect(sendMessageTelegram("", "hello", { token: "tok" })).rejects.toThrow(
      /Recipient is required/,
    );
  });

  it("does not wrap non-400 errors (passthrough)", async () => {
    const serverError = new Error("500: Internal Server Error");
    botApi.sendMessage.mockRejectedValue(serverError);

    try {
      await sendMessageTelegram("123", "hello", { token: "tok" });
    } catch (e: unknown) {
      // Should be the exact same error, not wrapped with hints
      expect((e as Error).message).toBe("500: Internal Server Error");
      expect((e as Error).message).not.toContain("Likely causes");
    }
  });

  it("preserves original error via 'cause'", async () => {
    const originalError = new Error("400: Bad Request: chat not found");
    botApi.sendMessage.mockRejectedValue(originalError);

    try {
      await sendMessageTelegram("@user", "hello", { token: "tok" });
    } catch (e: unknown) {
      expect((e as Error).message).toContain("Likely causes");
      expect((e as Error).cause).toBe(originalError);
    }
  });
});
