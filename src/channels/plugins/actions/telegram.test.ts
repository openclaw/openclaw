import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { telegramMessageActions } from "./telegram.js";

const handleTelegramAction = vi.fn(async () => ({ ok: true }));
const sendPollTelegram = vi.fn(async () => ({
  messageId: "99",
  chatId: "123",
  pollId: "p1",
}));

vi.mock("../../../agents/tools/telegram-actions.js", () => ({
  handleTelegramAction: (...args: unknown[]) => handleTelegramAction(...args),
}));

vi.mock("../../../telegram/send.js", () => ({
  sendPollTelegram: (...args: unknown[]) => sendPollTelegram(...args),
}));

describe("telegramMessageActions", () => {
  it("excludes sticker actions when not enabled", () => {
    const cfg = { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig;
    const actions = telegramMessageActions.listActions({ cfg });
    expect(actions).not.toContain("sticker");
    expect(actions).not.toContain("sticker-search");
  });

  it("allows media-only sends and passes asVoice", async () => {
    handleTelegramAction.mockClear();
    const cfg = { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig;

    await telegramMessageActions.handleAction({
      action: "send",
      params: {
        to: "123",
        media: "https://example.com/voice.ogg",
        asVoice: true,
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        to: "123",
        content: "",
        mediaUrl: "https://example.com/voice.ogg",
        asVoice: true,
      }),
      cfg,
    );
  });

  it("passes silent flag for silent sends", async () => {
    handleTelegramAction.mockClear();
    const cfg = { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig;

    await telegramMessageActions.handleAction({
      action: "send",
      params: {
        to: "456",
        message: "Silent notification test",
        silent: true,
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        to: "456",
        content: "Silent notification test",
        silent: true,
      }),
      cfg,
    );
  });

  it("maps edit action params into editMessage", async () => {
    handleTelegramAction.mockClear();
    const cfg = { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig;

    await telegramMessageActions.handleAction({
      action: "edit",
      params: {
        chatId: "123",
        messageId: 42,
        message: "Updated",
        buttons: [],
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledWith(
      {
        action: "editMessage",
        chatId: "123",
        messageId: 42,
        content: "Updated",
        buttons: [],
        accountId: undefined,
      },
      cfg,
    );
  });

  it("rejects non-integer messageId for edit before reaching telegram-actions", async () => {
    handleTelegramAction.mockClear();
    const cfg = { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig;

    await expect(
      telegramMessageActions.handleAction({
        action: "edit",
        params: {
          chatId: "123",
          messageId: "nope",
          message: "Updated",
        },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow();

    expect(handleTelegramAction).not.toHaveBeenCalled();
  });

  it("accepts numeric messageId and channelId for reactions", async () => {
    handleTelegramAction.mockClear();
    const cfg = { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig;

    await telegramMessageActions.handleAction({
      action: "react",
      params: {
        channelId: 123,
        messageId: 456,
        emoji: "ok",
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledTimes(1);
    const call = handleTelegramAction.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.action).toBe("react");
    expect(String(call.chatId)).toBe("123");
    expect(String(call.messageId)).toBe("456");
    expect(call.emoji).toBe("ok");
  });

  it("lists poll action when polls gate is enabled (#16977)", () => {
    const cfg = {
      channels: { telegram: { botToken: "tok", actions: { polls: true } } },
    } as OpenClawConfig;
    const actions = telegramMessageActions.listActions({ cfg });
    expect(actions).toContain("poll");
  });

  it("handles poll action and calls sendPollTelegram (#16977)", async () => {
    sendPollTelegram.mockClear();
    const cfg = { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig;

    const result = await telegramMessageActions.handleAction({
      action: "poll",
      params: {
        to: "123",
        pollQuestion: "Favorite color?",
        pollOption: ["Red", "Blue", "Green"],
        pollMulti: true,
        pollDurationSeconds: 120,
        pollAnonymous: false,
        silent: true,
      },
      cfg,
      accountId: "acct-1",
    });

    expect(sendPollTelegram).toHaveBeenCalledTimes(1);
    const [to, poll, opts] = sendPollTelegram.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(to).toBe("123");
    expect(poll.question).toBe("Favorite color?");
    expect(poll.options).toEqual(["Red", "Blue", "Green"]);
    expect(poll.maxSelections).toBe(3);
    expect(poll.durationSeconds).toBe(120);
    expect(opts.accountId).toBe("acct-1");
    expect(opts.isAnonymous).toBe(false);
    expect(opts.silent).toBe(true);
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ messageId: "99", chatId: "123", pollId: "p1" }, null, 2),
        },
      ],
      details: { messageId: "99", chatId: "123", pollId: "p1" },
    });
  });
});
