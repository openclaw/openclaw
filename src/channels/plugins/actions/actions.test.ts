import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";

const handleDiscordAction = vi.fn(async () => ({ details: { ok: true } }));
const handleTelegramAction = vi.fn(async () => ({ ok: true }));
const sendReactionSignal = vi.fn(async () => ({ ok: true }));
const removeReactionSignal = vi.fn(async () => ({ ok: true }));
const handleSlackAction = vi.fn(async () => ({ details: { ok: true } }));

vi.mock("../../../agents/tools/discord-actions.js", () => ({
  handleDiscordAction: (...args: unknown[]) => handleDiscordAction(...args),
}));

vi.mock("../../../agents/tools/telegram-actions.js", () => ({
  handleTelegramAction: (...args: unknown[]) => handleTelegramAction(...args),
}));

vi.mock("../../../signal/send-reactions.js", () => ({
  sendReactionSignal: (...args: unknown[]) => sendReactionSignal(...args),
  removeReactionSignal: (...args: unknown[]) => removeReactionSignal(...args),
}));

vi.mock("../../../agents/tools/slack-actions.js", () => ({
  handleSlackAction: (...args: unknown[]) => handleSlackAction(...args),
}));

const { discordMessageActions } = await import("./discord.js");
const { handleDiscordMessageAction } = await import("./discord/handle-action.js");
const { telegramMessageActions } = await import("./telegram.js");
const { signalMessageActions } = await import("./signal.js");
const { createSlackActions } = await import("../slack.actions.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("discord message actions", () => {
  it("lists channel and upload actions by default", async () => {
    const cfg = { channels: { discord: { token: "d0" } } } as OpenClawConfig;
    const actions = discordMessageActions.listActions?.({ cfg }) ?? [];

    expect(actions).toContain("emoji-upload");
    expect(actions).toContain("sticker-upload");
    expect(actions).toContain("channel-create");
  });

  it("respects disabled channel actions", async () => {
    const cfg = {
      channels: { discord: { token: "d0", actions: { channels: false } } },
    } as OpenClawConfig;
    const actions = discordMessageActions.listActions?.({ cfg }) ?? [];

    expect(actions).not.toContain("channel-create");
  });
});

describe("handleDiscordMessageAction", () => {
  it("forwards context accountId for send", async () => {
    await handleDiscordMessageAction({
      action: "send",
      params: {
        to: "channel:123",
        message: "hi",
      },
      cfg: {} as OpenClawConfig,
      accountId: "ops",
    });

    expect(handleDiscordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        accountId: "ops",
        to: "channel:123",
        content: "hi",
      }),
      expect.any(Object),
    );
  });

  it("forwards legacy embeds for send", async () => {
    const embeds = [{ title: "Legacy", description: "Use components v2." }];

    await handleDiscordMessageAction({
      action: "send",
      params: {
        to: "channel:123",
        message: "hi",
        embeds,
      },
      cfg: {} as OpenClawConfig,
    });

    expect(handleDiscordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        to: "channel:123",
        content: "hi",
        embeds,
      }),
      expect.any(Object),
    );
  });

  it("falls back to params accountId when context missing", async () => {
    await handleDiscordMessageAction({
      action: "poll",
      params: {
        to: "channel:123",
        pollQuestion: "Ready?",
        pollOption: ["Yes", "No"],
        accountId: "marve",
      },
      cfg: {} as OpenClawConfig,
    });

    expect(handleDiscordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "poll",
        accountId: "marve",
        to: "channel:123",
        question: "Ready?",
        answers: ["Yes", "No"],
      }),
      expect.any(Object),
    );
  });

  it("forwards accountId for thread replies", async () => {
    await handleDiscordMessageAction({
      action: "thread-reply",
      params: {
        channelId: "123",
        message: "hi",
      },
      cfg: {} as OpenClawConfig,
      accountId: "ops",
    });

    expect(handleDiscordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "threadReply",
        accountId: "ops",
        channelId: "123",
        content: "hi",
      }),
      expect.any(Object),
    );
  });

  it("accepts threadId for thread replies (tool compatibility)", async () => {
    await handleDiscordMessageAction({
      action: "thread-reply",
      params: {
        // The `message` tool uses `threadId`.
        threadId: "999",
        // Include a conflicting channelId to ensure threadId takes precedence.
        channelId: "123",
        message: "hi",
      },
      cfg: {} as OpenClawConfig,
      accountId: "ops",
    });

    expect(handleDiscordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "threadReply",
        accountId: "ops",
        channelId: "999",
        content: "hi",
      }),
      expect.any(Object),
    );
  });

  it("forwards thread-create message as content", async () => {
    await handleDiscordMessageAction({
      action: "thread-create",
      params: {
        to: "channel:123456789",
        threadName: "Forum thread",
        message: "Initial forum post body",
      },
      cfg: {} as OpenClawConfig,
    });

    expect(handleDiscordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "threadCreate",
        channelId: "123456789",
        name: "Forum thread",
        content: "Initial forum post body",
      }),
      expect.any(Object),
    );
  });

  it("forwards thread edit fields for channel-edit", async () => {
    await handleDiscordMessageAction({
      action: "channel-edit",
      params: {
        channelId: "123456789",
        archived: true,
        locked: false,
        autoArchiveDuration: 1440,
      },
      cfg: {} as OpenClawConfig,
    });

    expect(handleDiscordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channelEdit",
        channelId: "123456789",
        archived: true,
        locked: false,
        autoArchiveDuration: 1440,
      }),
      expect.any(Object),
    );
  });
});

describe("telegramMessageActions", () => {
  it("excludes sticker actions when not enabled", () => {
    const cfg = { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig;
    const actions = telegramMessageActions.listActions({ cfg });
    expect(actions).not.toContain("sticker");
    expect(actions).not.toContain("sticker-search");
  });

  it("allows media-only sends and passes asVoice", async () => {
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
});

describe("signalMessageActions", () => {
  it("returns no actions when no configured accounts exist", () => {
    const cfg = {} as OpenClawConfig;
    expect(signalMessageActions.listActions({ cfg })).toEqual([]);
  });

  it("hides react when reactions are disabled", () => {
    const cfg = {
      channels: { signal: { account: "+15550001111", actions: { reactions: false } } },
    } as OpenClawConfig;
    expect(signalMessageActions.listActions({ cfg })).toEqual(["send"]);
  });

  it("enables react when at least one account allows reactions", () => {
    const cfg = {
      channels: {
        signal: {
          actions: { reactions: false },
          accounts: {
            work: { account: "+15550001111", actions: { reactions: true } },
          },
        },
      },
    } as OpenClawConfig;
    expect(signalMessageActions.listActions({ cfg })).toEqual(["send", "react"]);
  });

  it("skips send for plugin dispatch", () => {
    expect(signalMessageActions.supportsAction?.({ action: "send" })).toBe(false);
    expect(signalMessageActions.supportsAction?.({ action: "react" })).toBe(true);
  });

  it("blocks reactions when action gate is disabled", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111", actions: { reactions: false } } },
    } as OpenClawConfig;

    await expect(
      signalMessageActions.handleAction({
        action: "react",
        params: { to: "+15550001111", messageId: "123", emoji: "✅" },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow(/actions\.reactions/);
  });

  it("uses account-level actions when enabled", async () => {
    const cfg = {
      channels: {
        signal: {
          actions: { reactions: false },
          accounts: {
            work: { account: "+15550001111", actions: { reactions: true } },
          },
        },
      },
    } as OpenClawConfig;

    await signalMessageActions.handleAction({
      action: "react",
      params: { to: "+15550001111", messageId: "123", emoji: "👍" },
      cfg,
      accountId: "work",
    });

    expect(sendReactionSignal).toHaveBeenCalledWith("+15550001111", 123, "👍", {
      accountId: "work",
    });
  });

  it("normalizes uuid recipients", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    await signalMessageActions.handleAction({
      action: "react",
      params: {
        recipient: "uuid:123e4567-e89b-12d3-a456-426614174000",
        messageId: "123",
        emoji: "🔥",
      },
      cfg,
      accountId: undefined,
    });

    expect(sendReactionSignal).toHaveBeenCalledWith(
      "123e4567-e89b-12d3-a456-426614174000",
      123,
      "🔥",
      { accountId: undefined },
    );
  });

  it("requires targetAuthor for group reactions", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    await expect(
      signalMessageActions.handleAction({
        action: "react",
        params: { to: "signal:group:group-id", messageId: "123", emoji: "✅" },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow(/targetAuthor/);
  });

  it("passes groupId and targetAuthor for group reactions", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    await signalMessageActions.handleAction({
      action: "react",
      params: {
        to: "signal:group:group-id",
        targetAuthor: "uuid:123e4567-e89b-12d3-a456-426614174000",
        messageId: "123",
        emoji: "✅",
      },
      cfg,
      accountId: undefined,
    });

    expect(sendReactionSignal).toHaveBeenCalledWith("", 123, "✅", {
      accountId: undefined,
      groupId: "group-id",
      targetAuthor: "uuid:123e4567-e89b-12d3-a456-426614174000",
      targetAuthorUuid: undefined,
    });
  });
});

describe("slack actions adapter", () => {
  it("forwards threadId for read", async () => {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    const actions = createSlackActions("slack");

    await actions.handleAction?.({
      channel: "slack",
      action: "read",
      cfg,
      params: {
        channelId: "C1",
        threadId: "171234.567",
      },
    });

    const [params] = handleSlackAction.mock.calls[0] ?? [];
    expect(params).toMatchObject({
      action: "readMessages",
      channelId: "C1",
      threadId: "171234.567",
    });
  });

  it("forwards normalized limit for emoji-list", async () => {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    const actions = createSlackActions("slack");

    await actions.handleAction?.({
      channel: "slack",
      action: "emoji-list",
      cfg,
      params: {
        limit: "2.9",
      },
    });

    const [params] = handleSlackAction.mock.calls[0] ?? [];
    expect(params).toMatchObject({
      action: "emojiList",
      limit: 2,
    });
  });

  it("forwards blocks JSON for send", async () => {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    const actions = createSlackActions("slack");

    await actions.handleAction?.({
      channel: "slack",
      action: "send",
      cfg,
      params: {
        to: "channel:C1",
        message: "",
        blocks: JSON.stringify([{ type: "divider" }]),
      },
    });

    const [params] = handleSlackAction.mock.calls[0] ?? [];
    expect(params).toMatchObject({
      action: "sendMessage",
      to: "channel:C1",
      content: "",
      blocks: [{ type: "divider" }],
    });
  });

  it("forwards blocks arrays for send", async () => {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    const actions = createSlackActions("slack");

    await actions.handleAction?.({
      channel: "slack",
      action: "send",
      cfg,
      params: {
        to: "channel:C1",
        message: "",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "hi" } }],
      },
    });

    const [params] = handleSlackAction.mock.calls[0] ?? [];
    expect(params).toMatchObject({
      action: "sendMessage",
      to: "channel:C1",
      content: "",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "hi" } }],
    });
  });

  it("rejects invalid blocks JSON for send", async () => {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    const actions = createSlackActions("slack");

    await expect(
      actions.handleAction?.({
        channel: "slack",
        action: "send",
        cfg,
        params: {
          to: "channel:C1",
          message: "",
          blocks: "{bad-json",
        },
      }),
    ).rejects.toThrow(/blocks must be valid JSON/i);
    expect(handleSlackAction).not.toHaveBeenCalled();
  });

  it("forwards blocks JSON for edit", async () => {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    const actions = createSlackActions("slack");

    await actions.handleAction?.({
      channel: "slack",
      action: "edit",
      cfg,
      params: {
        channelId: "C1",
        messageId: "171234.567",
        message: "",
        blocks: JSON.stringify([{ type: "divider" }]),
      },
    });

    const [params] = handleSlackAction.mock.calls[0] ?? [];
    expect(params).toMatchObject({
      action: "editMessage",
      channelId: "C1",
      messageId: "171234.567",
      content: "",
      blocks: [{ type: "divider" }],
    });
  });

  it("forwards blocks arrays for edit", async () => {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    const actions = createSlackActions("slack");

    await actions.handleAction?.({
      channel: "slack",
      action: "edit",
      cfg,
      params: {
        channelId: "C1",
        messageId: "171234.567",
        message: "",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "updated" } }],
      },
    });

    const [params] = handleSlackAction.mock.calls[0] ?? [];
    expect(params).toMatchObject({
      action: "editMessage",
      channelId: "C1",
      messageId: "171234.567",
      content: "",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "updated" } }],
    });
  });

  it("rejects edit when both message and blocks are missing", async () => {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    const actions = createSlackActions("slack");

    await expect(
      actions.handleAction?.({
        channel: "slack",
        action: "edit",
        cfg,
        params: {
          channelId: "C1",
          messageId: "171234.567",
          message: "",
        },
      }),
    ).rejects.toThrow(/edit requires message or blocks/i);
    expect(handleSlackAction).not.toHaveBeenCalled();
  });
});
