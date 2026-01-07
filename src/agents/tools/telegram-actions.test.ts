import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import { handleTelegramAction } from "./telegram-actions.js";

const reactMessageTelegram = vi.fn(async () => ({ ok: true }));
const originalToken = process.env.TELEGRAM_BOT_TOKEN;

vi.mock("../../telegram/send.js", () => ({
  reactMessageTelegram: (...args: unknown[]) => reactMessageTelegram(...args),
}));

describe("handleTelegramAction", () => {
  beforeEach(() => {
    reactMessageTelegram.mockClear();
    process.env.TELEGRAM_BOT_TOKEN = "tok";
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = originalToken;
    }
  });

  it("adds reactions", async () => {
    const cfg = { telegram: { botToken: "tok" } } as ClawdbotConfig;
    await handleTelegramAction(
      {
        action: "react",
        chatId: "123",
        messageId: "456",
        emoji: "✅",
      },
      cfg,
    );
    expect(reactMessageTelegram).toHaveBeenCalledWith("123", 456, "✅", {
      token: "tok",
      remove: false,
    });
  });

  it("removes reactions on empty emoji", async () => {
    const cfg = { telegram: { botToken: "tok" } } as ClawdbotConfig;
    await handleTelegramAction(
      {
        action: "react",
        chatId: "123",
        messageId: "456",
        emoji: "",
      },
      cfg,
    );
    expect(reactMessageTelegram).toHaveBeenCalledWith("123", 456, "", {
      token: "tok",
      remove: false,
    });
  });

  it("removes reactions when remove flag set", async () => {
    const cfg = { telegram: { botToken: "tok" } } as ClawdbotConfig;
    await handleTelegramAction(
      {
        action: "react",
        chatId: "123",
        messageId: "456",
        emoji: "✅",
        remove: true,
      },
      cfg,
    );
    expect(reactMessageTelegram).toHaveBeenCalledWith("123", 456, "✅", {
      token: "tok",
      remove: true,
    });
  });

  it("respects reaction gating", async () => {
    const cfg = {
      telegram: { botToken: "tok", actions: { reactions: false } },
    } as ClawdbotConfig;
    await expect(
      handleTelegramAction(
        {
          action: "react",
          chatId: "123",
          messageId: "456",
          emoji: "✅",
        },
        cfg,
      ),
    ).rejects.toThrow(/Telegram reactions are disabled/);
  });
});
