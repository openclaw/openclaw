import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { telegramMessageActions } from "./telegram.js";

const handleTelegramAction = vi.fn(async () => ({ ok: true }));

vi.mock("../../../agents/tools/telegram-actions.js", () => ({
  handleTelegramAction: (...args: unknown[]) => handleTelegramAction(...args),
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

  it("excludes thread-create when threads action not enabled", () => {
    const cfg = { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig;
    const actions = telegramMessageActions.listActions({ cfg });
    expect(actions).not.toContain("thread-create");
  });

  it("includes thread-create when threads action is enabled", () => {
    const cfg = {
      channels: { telegram: { botToken: "tok", actions: { threads: true } } },
    } as OpenClawConfig;
    const actions = telegramMessageActions.listActions({ cfg });
    expect(actions).toContain("thread-create");
  });

  it("maps thread-create action params to createForumTopic", async () => {
    handleTelegramAction.mockClear();
    const cfg = {
      channels: { telegram: { botToken: "tok", actions: { threads: true } } },
    } as OpenClawConfig;

    await telegramMessageActions.handleAction({
      action: "thread-create",
      params: {
        to: "-1001234567890",
        threadName: "My Topic",
        iconColor: 0x6fb9f0,
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledWith(
      {
        action: "createForumTopic",
        chatId: "-1001234567890",
        name: "My Topic",
        iconColor: 0x6fb9f0,
        iconCustomEmojiId: undefined,
        accountId: undefined,
      },
      cfg,
    );
  });

  it("rejects thread-create without required threadName", async () => {
    handleTelegramAction.mockClear();
    const cfg = {
      channels: { telegram: { botToken: "tok", actions: { threads: true } } },
    } as OpenClawConfig;

    await expect(
      telegramMessageActions.handleAction({
        action: "thread-create",
        params: {
          to: "-1001234567890",
        },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow();

    expect(handleTelegramAction).not.toHaveBeenCalled();
  });
});
