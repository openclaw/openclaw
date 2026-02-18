import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { telegramMessageActions } from "./telegram.js";

const handleTelegramAction = vi.fn<
  (params: Record<string, unknown>, cfg: OpenClawConfig) => Promise<{ ok: true }>
>(async () => ({ ok: true }));

vi.mock("../../../agents/tools/telegram-actions.js", () => ({
  handleTelegramAction: (...args: Parameters<typeof handleTelegramAction>) =>
    handleTelegramAction(...args),
}));

describe("telegramMessageActions", () => {
  it("includes poll action when telegram account is configured", () => {
    const cfg = { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig;
    const actions = telegramMessageActions.listActions?.({ cfg }) ?? [];
    expect(actions).toContain("poll");
  });

  it("excludes sticker actions when not enabled", () => {
    const cfg = { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig;
    const actions = telegramMessageActions.listActions?.({ cfg }) ?? [];
    expect(actions).not.toContain("sticker");
    expect(actions).not.toContain("sticker-search");
  });

  it("allows media-only sends and passes asVoice", async () => {
    handleTelegramAction.mockClear();
    const cfg = { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig;

    expect(telegramMessageActions.handleAction).toBeDefined();
    await telegramMessageActions.handleAction!({
      channel: "telegram",
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

  it("maps poll action params into sendPoll", async () => {
    handleTelegramAction.mockClear();
    const cfg = { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig;

    expect(telegramMessageActions.handleAction).toBeDefined();
    await telegramMessageActions.handleAction!({
      channel: "telegram",
      action: "poll",
      params: {
        to: "123",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi"],
        pollMulti: true,
        pollDurationSeconds: 120,
        pollPublic: true,
        silent: true,
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendPoll",
        to: "123",
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
        maxSelections: 2,
        durationSeconds: 120,
        isAnonymous: false,
        silent: true,
      }),
      cfg,
    );
  });

  it("passes silent flag for silent sends", async () => {
    handleTelegramAction.mockClear();
    const cfg = { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig;

    expect(telegramMessageActions.handleAction).toBeDefined();
    await telegramMessageActions.handleAction!({
      channel: "telegram",
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

    expect(telegramMessageActions.handleAction).toBeDefined();
    await telegramMessageActions.handleAction!({
      channel: "telegram",
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
      telegramMessageActions.handleAction!({
        channel: "telegram",
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

    expect(telegramMessageActions.handleAction).toBeDefined();
    await telegramMessageActions.handleAction!({
      channel: "telegram",
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
    const firstCall = handleTelegramAction.mock.calls[0];
    expect(firstCall).toBeDefined();
    const call = firstCall?.[0];
    expect(call).toBeDefined();
    if (!call) {
      return;
    }
    expect(call.action).toBe("react");
    expect(String(call.chatId)).toBe("123");
    expect(String(call.messageId)).toBe("456");
    expect(call.emoji).toBe("ok");
  });
});
