import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const { sendMessageTelegram } = vi.hoisted(() => ({
  sendMessageTelegram: vi.fn(async () => ({
    messageId: "789",
    chatId: "123",
  })),
}));

vi.mock("@mariozechner/pi-ai", async () => ({
  ...((await vi.importActual<object>("@mariozechner/pi-ai").catch(() => ({}))) as object),
  getOAuthProviders: () => [],
  getOAuthApiKey: vi.fn(),
  loginOpenAICodex: vi.fn(),
  getEnvApiKey: vi.fn(),
}));

vi.mock("../../telegram/send.js", () => ({
  sendMessageTelegram: (...args: Parameters<typeof sendMessageTelegram>) =>
    sendMessageTelegram(...args),
  reactMessageTelegram: vi.fn(),
  sendStickerTelegram: vi.fn(),
  deleteMessageTelegram: vi.fn(),
}));

const { handleTelegramAction } = await import("./telegram-actions.js");

describe("handleTelegramAction", () => {
  beforeEach(() => {
    sendMessageTelegram.mockClear();
  });

  it("forwards inline attachment buffers", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok" } },
    } as OpenClawConfig;

    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "123456",
        buffer: "QUJD",
        filename: "note.txt",
        contentType: "text/plain",
      },
      cfg,
    );

    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123456",
      "",
      expect.objectContaining({
        token: "tok",
        buffer: "QUJD",
        filename: "note.txt",
        contentType: "text/plain",
      }),
    );
  });
});
