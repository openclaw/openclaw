import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { sendMessageTelegram } from "./send.js";

const originalEnv = process.env.TELEGRAM_BOT_TOKEN;
const loadWebMediaMock = vi.fn();

const apiMock = {
  sendMessage: vi.fn(),
  sendPhoto: vi.fn(),
  sendVideo: vi.fn(),
  sendAudio: vi.fn(),
  sendDocument: vi.fn(),
};

vi.mock("grammy", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    Bot: vi.fn().mockImplementation(() => ({ api: apiMock })),
    InputFile: actual.InputFile,
  };
});

vi.mock("../web/media.js", () => ({
  loadWebMedia: (...args: unknown[]) => loadWebMediaMock(...args),
}));

describe("sendMessageTelegram", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = "token123";
  });

  afterAll(() => {
    process.env.TELEGRAM_BOT_TOKEN = originalEnv;
  });

  it("sends text and returns ids", async () => {
    apiMock.sendMessage.mockResolvedValueOnce({
      message_id: 42,
      chat: { id: 999 },
    });

    const res = await sendMessageTelegram("12345", "hello", {
      verbose: false,
      api: apiMock as never,
    });
    expect(res).toEqual({ messageId: "42", chatId: "999" });
    expect(apiMock.sendMessage).toHaveBeenCalled();
  });

  it("throws when token missing", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "";
    await expect(sendMessageTelegram("1", "hi")).rejects.toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
  });

  it("throws on api error", async () => {
    apiMock.sendMessage.mockRejectedValueOnce(new Error("bad token"));

    await expect(
      sendMessageTelegram("1", "hi", { api: apiMock as never }),
    ).rejects.toThrow(/bad token/i);
  });

  it("sends media via appropriate method", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from([1, 2, 3]),
      contentType: "image/jpeg",
      kind: "image",
      fileName: "pic.jpg",
    });
    apiMock.sendPhoto.mockResolvedValueOnce({
      message_id: 99,
      chat: { id: 123 },
    });
    const res = await sendMessageTelegram("123", "hello", {
      mediaUrl: "http://example.com/pic.jpg",
      api: apiMock as never,
    });
    expect(res).toEqual({ messageId: "99", chatId: "123" });
    expect(loadWebMediaMock).toHaveBeenCalled();
    expect(apiMock.sendPhoto).toHaveBeenCalled();
  });
});
