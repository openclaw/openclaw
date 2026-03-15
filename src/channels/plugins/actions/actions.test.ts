import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";

const handleDiscordAction = vi.fn(async (..._args: unknown[]) => ({ details: { ok: true } }));
const handleTelegramAction = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
const sendReactionSignal = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
const removeReactionSignal = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
const handleSlackAction = vi.fn(async (..._args: unknown[]) => ({ details: { ok: true } }));

vi.mock("../../../agents/tools/discord-actions.js", () => ({
  handleDiscordAction,
}));

vi.mock("../../../agents/tools/telegram-actions.js", () => ({
  handleTelegramAction,
}));

vi.mock("../../../../extensions/signal/src/send-reactions.js", () => ({
  sendReactionSignal,
  removeReactionSignal,
}));

vi.mock("../../../agents/tools/slack-actions.js", () => ({
  handleSlackAction,
}));

const { discordMessageActions } = await import("./discord.js");
const { handleDiscordMessageAction } = await import("./discord/handle-action.js");
const { telegramMessageActions } = await import("./telegram.js");
const { signalMessageActions } = await import("./signal.js");
const { createSlackActions } = await import("../slack.actions.js");

function telegramCfg(): OpenClawConfig {
  return { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig;
}

type TelegramActionInput = Parameters<NonNullable<typeof telegramMessageActions.handleAction>>[0];

async function runTelegramAction(
  action: TelegramActionInput["action"],
  params: TelegramActionInput["params"],
  options?: { cfg?: OpenClawConfig; accountId?: string },
) {
  const cfg = options?.cfg ?? telegramCfg();
  const handleAction = telegramMessageActions.handleAction;
  if (!handleAction) {
    throw new Error("telegram handleAction unavailable");
  }
  await handleAction({
    channel: "telegram",
    action,
    params,
    cfg,
    accountId: options?.accountId,
  });
  return { cfg };
}

type SignalActionInput = Parameters<NonNullable<typeof signalMessageActions.handleAction>>[0];

async function runSignalAction(
  action: SignalActionInput["action"],
  params: SignalActionInput["params"],
  options?: {
    cfg?: OpenClawConfig;
    accountId?: string;
    toolContext?: SignalActionInput["toolContext"];
  },
) {
  const cfg =
    options?.cfg ?? ({ channels: { signal: { account: "+15550001111" } } } as OpenClawConfig);
  const handleAction = signalMessageActions.handleAction;
  if (!handleAction) {
    throw new Error("signal handleAction unavailable");
  }
  await handleAction({
    channel: "signal",
    action,
    params,
    cfg,
    accountId: options?.accountId,
    toolContext: options?.toolContext,
  });
  return { cfg };
}

function slackHarness() {
  const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
  const actions = createSlackActions("slack");
  return { cfg, actions };
}

type SlackActionInput = Parameters<
  NonNullable<ReturnType<typeof createSlackActions>["handleAction"]>
>[0];

async function runSlackAction(
  action: SlackActionInput["action"],
  params: SlackActionInput["params"],
) {
  const { cfg, actions } = slackHarness();
  await actions.handleAction?.({
    channel: "slack",
    action,
    cfg,
    params,
  });
  return { cfg, actions };
}

function expectFirstSlackAction(expected: Record<string, unknown>) {
  const [params] = handleSlackAction.mock.calls[0] ?? [];
  expect(params).toMatchObject(expected);
}

function expectModerationActions(actions: string[]) {
  expect(actions).toContain("timeout");
  expect(actions).toContain("kick");
  expect(actions).toContain("ban");
}

function expectChannelCreateAction(actions: string[], expected: boolean) {
  if (expected) {
    expect(actions).toContain("channel-create");
    return;
  }
  expect(actions).not.toContain("channel-create");
}

function createSignalAccountOverrideCfg(): OpenClawConfig {
  return {
    channels: {
      signal: {
        actions: { reactions: false },
        accounts: {
          work: { account: "+15550001111", actions: { reactions: true } },
        },
      },
    },
  } as OpenClawConfig;
}

function createDiscordModerationOverrideCfg(params?: {
  channelsEnabled?: boolean;
}): OpenClawConfig {
  const accountActions = params?.channelsEnabled
    ? { moderation: true, channels: true }
    : { moderation: true };
  return {
    channels: {
      discord: {
        actions: { channels: false },
        accounts: {
          vime: { token: "d1", actions: accountActions },
        },
      },
    },
  } as OpenClawConfig;
}

async function expectSignalActionRejected(
  params: Record<string, unknown>,
  error: RegExp,
  cfg: OpenClawConfig,
) {
  const handleAction = signalMessageActions.handleAction;
  if (!handleAction) {
    throw new Error("signal handleAction unavailable");
  }
  await expect(
    handleAction({
      channel: "signal",
      action: "react",
      params,
      cfg,
      accountId: undefined,
    }),
  ).rejects.toThrow(error);
}

async function expectSlackSendRejected(params: Record<string, unknown>, error: RegExp) {
  const { cfg, actions } = slackHarness();
  await expect(
    actions.handleAction?.({
      channel: "slack",
      action: "send",
      cfg,
      params,
    }),
  ).rejects.toThrow(error);
  expect(handleSlackAction).not.toHaveBeenCalled();
}

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

  it("lists moderation when at least one account enables it", () => {
    const cases = [
      {
        channels: {
          discord: {
            accounts: {
              vime: { token: "d1", actions: { moderation: true } },
            },
          },
        },
      },
      {
        channels: {
          discord: {
            accounts: {
              ops: { token: "d1", actions: { moderation: true } },
              chat: { token: "d2" },
            },
          },
        },
      },
    ] as const;

    for (const channelConfig of cases) {
      const cfg = channelConfig as unknown as OpenClawConfig;
      const actions = discordMessageActions.listActions?.({ cfg }) ?? [];
      expectModerationActions(actions);
    }
  });

  it("omits moderation when all accounts omit it", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            ops: { token: "d1" },
            chat: { token: "d2" },
          },
        },
      },
    } as OpenClawConfig;
    const actions = discordMessageActions.listActions?.({ cfg }) ?? [];

    // moderation defaults to false, so without explicit true it stays hidden
    expect(actions).not.toContain("timeout");
    expect(actions).not.toContain("kick");
    expect(actions).not.toContain("ban");
  });

  it("inherits top-level channel gate when account overrides moderation only", () => {
    const cfg = createDiscordModerationOverrideCfg();
    const actions = discordMessageActions.listActions?.({ cfg }) ?? [];

    expect(actions).toContain("timeout");
    expectChannelCreateAction(actions, false);
  });

  it("allows account to explicitly re-enable top-level disabled channels", () => {
    const cfg = createDiscordModerationOverrideCfg({ channelsEnabled: true });
    const actions = discordMessageActions.listActions?.({ cfg }) ?? [];

    expect(actions).toContain("timeout");
    expectChannelCreateAction(actions, true);
  });
});

describe("handleDiscordMessageAction", () => {
  const embeds = [{ title: "Legacy", description: "Use components v2." }];
  const forwardingCases = [
    {
      name: "forwards context accountId for send",
      input: {
        action: "send" as const,
        params: { to: "channel:123", message: "hi" },
        accountId: "ops",
      },
      expected: {
        action: "sendMessage",
        accountId: "ops",
        to: "channel:123",
        content: "hi",
      },
    },
    {
      name: "forwards legacy embeds for send",
      input: {
        action: "send" as const,
        params: { to: "channel:123", message: "hi", embeds },
      },
      expected: {
        action: "sendMessage",
        to: "channel:123",
        content: "hi",
        embeds,
      },
    },
    {
      name: "falls back to params accountId when context missing",
      input: {
        action: "poll" as const,
        params: {
          to: "channel:123",
          pollQuestion: "Ready?",
          pollOption: ["Yes", "No"],
          accountId: "marve",
        },
      },
      expected: {
        action: "poll",
        accountId: "marve",
        to: "channel:123",
        question: "Ready?",
        answers: ["Yes", "No"],
      },
    },
    {
      name: "parses string booleans for discord poll adapter params",
      input: {
        action: "poll" as const,
        params: {
          to: "channel:123",
          pollQuestion: "Ready?",
          pollOption: ["Yes", "No"],
          pollMulti: "true",
        },
      },
      expected: {
        action: "poll",
        to: "channel:123",
        question: "Ready?",
        answers: ["Yes", "No"],
        allowMultiselect: true,
      },
    },
    {
      name: "rejects partially numeric poll duration for discord poll adapter params",
      input: {
        action: "poll" as const,
        params: {
          to: "channel:123",
          pollQuestion: "Ready?",
          pollOption: ["Yes", "No"],
          pollDurationHours: "24h",
        },
      },
      expected: {
        action: "poll",
        to: "channel:123",
        question: "Ready?",
        answers: ["Yes", "No"],
        durationHours: undefined,
      },
    },
    {
      name: "forwards accountId for thread replies",
      input: {
        action: "thread-reply" as const,
        params: { channelId: "123", message: "hi" },
        accountId: "ops",
      },
      expected: {
        action: "threadReply",
        accountId: "ops",
        channelId: "123",
        content: "hi",
      },
    },
    {
      name: "accepts threadId for thread replies (tool compatibility)",
      input: {
        action: "thread-reply" as const,
        params: {
          threadId: "999",
          channelId: "123",
          message: "hi",
        },
        accountId: "ops",
      },
      expected: {
        action: "threadReply",
        accountId: "ops",
        channelId: "999",
        content: "hi",
      },
    },
    {
      name: "forwards thread-create message as content",
      input: {
        action: "thread-create" as const,
        params: {
          to: "channel:123456789",
          threadName: "Forum thread",
          message: "Initial forum post body",
        },
      },
      expected: {
        action: "threadCreate",
        channelId: "123456789",
        name: "Forum thread",
        content: "Initial forum post body",
      },
    },
    {
      name: "forwards thread edit fields for channel-edit",
      input: {
        action: "channel-edit" as const,
        params: {
          channelId: "123456789",
          archived: true,
          locked: false,
          autoArchiveDuration: 1440,
        },
      },
      expected: {
        action: "channelEdit",
        channelId: "123456789",
        archived: true,
        locked: false,
        autoArchiveDuration: 1440,
      },
    },
  ] as const;

  for (const testCase of forwardingCases) {
    it(testCase.name, async () => {
      await handleDiscordMessageAction({
        ...testCase.input,
        cfg: {} as OpenClawConfig,
      });

      const call = handleDiscordAction.mock.calls.at(-1);
      expect(call?.[0]).toEqual(expect.objectContaining(testCase.expected));
      expect(call?.[1]).toEqual(expect.any(Object));
    });
  }

  it("uses trusted requesterSenderId for moderation and ignores params senderUserId", async () => {
    await handleDiscordMessageAction({
      action: "timeout",
      params: {
        guildId: "guild-1",
        userId: "user-2",
        durationMin: 5,
        senderUserId: "spoofed-admin-id",
      },
      cfg: {} as OpenClawConfig,
      requesterSenderId: "trusted-sender-id",
      toolContext: { currentChannelProvider: "discord" },
    });

    const call = handleDiscordAction.mock.calls.at(-1);
    expect(call?.[0]).toEqual(
      expect.objectContaining({
        action: "timeout",
        guildId: "guild-1",
        userId: "user-2",
        durationMinutes: 5,
        senderUserId: "trusted-sender-id",
      }),
    );
    expect(call?.[1]).toEqual(expect.any(Object));
  });

  it("forwards trusted mediaLocalRoots for send actions", async () => {
    await handleDiscordMessageAction({
      action: "send",
      params: { to: "channel:123", message: "hi", media: "/tmp/file.png" },
      cfg: {} as OpenClawConfig,
      mediaLocalRoots: ["/tmp/agent-root"],
    });

    expect(handleDiscordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        mediaUrl: "/tmp/file.png",
      }),
      expect.any(Object),
      expect.objectContaining({ mediaLocalRoots: ["/tmp/agent-root"] }),
    );
  });

  it("falls back to toolContext.currentMessageId for reactions when messageId is omitted", async () => {
    await handleDiscordMessageAction({
      action: "react",
      params: {
        channelId: "123",
        emoji: "ok",
      },
      cfg: {} as OpenClawConfig,
      toolContext: { currentMessageId: "9001" },
    });

    const call = handleDiscordAction.mock.calls.at(-1);
    expect(call?.[0]).toEqual(
      expect.objectContaining({
        action: "react",
        channelId: "123",
        messageId: "9001",
        emoji: "ok",
      }),
    );
  });

  it("rejects reactions when neither messageId nor toolContext.currentMessageId is provided", async () => {
    await expect(
      handleDiscordMessageAction({
        action: "react",
        params: {
          channelId: "123",
          emoji: "ok",
        },
        cfg: {} as OpenClawConfig,
      }),
    ).rejects.toThrow(/messageId required/i);

    expect(handleDiscordAction).not.toHaveBeenCalled();
  });
});

describe("telegramMessageActions", () => {
  it("lists poll when telegram is configured", () => {
    const actions = telegramMessageActions.listActions?.({ cfg: telegramCfg() }) ?? [];

    expect(actions).toContain("poll");
  });

  it("omits poll when sendMessage is disabled", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "tok",
          actions: { sendMessage: false },
        },
      },
    } as OpenClawConfig;

    const actions = telegramMessageActions.listActions?.({ cfg }) ?? [];

    expect(actions).not.toContain("poll");
  });

  it("omits poll when poll actions are disabled", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "tok",
          actions: { poll: false },
        },
      },
    } as OpenClawConfig;

    const actions = telegramMessageActions.listActions?.({ cfg }) ?? [];

    expect(actions).not.toContain("poll");
  });

  it("omits poll when sendMessage and poll are split across accounts", () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            senderOnly: {
              botToken: "tok-send",
              actions: {
                sendMessage: true,
                poll: false,
              },
            },
            pollOnly: {
              botToken: "tok-poll",
              actions: {
                sendMessage: false,
                poll: true,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const actions = telegramMessageActions.listActions?.({ cfg }) ?? [];

    expect(actions).not.toContain("poll");
  });

  it("lists sticker actions only when enabled by config", () => {
    const cases = [
      {
        name: "default config",
        cfg: telegramCfg(),
        expectSticker: false,
      },
      {
        name: "per-account sticker enabled",
        cfg: {
          channels: {
            telegram: {
              accounts: {
                media: { botToken: "tok", actions: { sticker: true } },
              },
            },
          },
        } as OpenClawConfig,
        expectSticker: true,
      },
      {
        name: "all accounts omit sticker",
        cfg: {
          channels: {
            telegram: {
              accounts: {
                a: { botToken: "tok1" },
                b: { botToken: "tok2" },
              },
            },
          },
        } as OpenClawConfig,
        expectSticker: false,
      },
    ] as const;

    for (const testCase of cases) {
      const actions = telegramMessageActions.listActions?.({ cfg: testCase.cfg }) ?? [];
      if (testCase.expectSticker) {
        expect(actions, testCase.name).toContain("sticker");
        expect(actions, testCase.name).toContain("sticker-search");
      } else {
        expect(actions, testCase.name).not.toContain("sticker");
        expect(actions, testCase.name).not.toContain("sticker-search");
      }
    }
  });

  it("maps action params into telegram actions", async () => {
    const cases = [
      {
        name: "media-only send preserves asVoice",
        action: "send" as const,
        params: {
          to: "123",
          media: "https://example.com/voice.ogg",
          asVoice: true,
        },
        expectedPayload: expect.objectContaining({
          action: "sendMessage",
          to: "123",
          content: "",
          mediaUrl: "https://example.com/voice.ogg",
          asVoice: true,
        }),
      },
      {
        name: "silent send forwards silent flag",
        action: "send" as const,
        params: {
          to: "456",
          message: "Silent notification test",
          silent: true,
        },
        expectedPayload: expect.objectContaining({
          action: "sendMessage",
          to: "456",
          content: "Silent notification test",
          silent: true,
        }),
      },
      {
        name: "edit maps to editMessage",
        action: "edit" as const,
        params: {
          chatId: "123",
          messageId: 42,
          message: "Updated",
          buttons: [],
        },
        expectedPayload: {
          action: "editMessage",
          chatId: "123",
          messageId: 42,
          content: "Updated",
          buttons: [],
          accountId: undefined,
        },
      },
      {
        name: "poll maps to telegram poll action",
        action: "poll" as const,
        params: {
          to: "123",
          pollQuestion: "Ready?",
          pollOption: ["Yes", "No"],
          pollMulti: true,
          pollDurationSeconds: 60,
          pollPublic: true,
          replyTo: 55,
          threadId: 77,
          silent: true,
        },
        expectedPayload: {
          action: "poll",
          to: "123",
          question: "Ready?",
          answers: ["Yes", "No"],
          allowMultiselect: true,
          durationHours: undefined,
          durationSeconds: 60,
          replyToMessageId: 55,
          messageThreadId: 77,
          isAnonymous: false,
          silent: true,
          accountId: undefined,
        },
      },
      {
        name: "poll parses string booleans before telegram action handoff",
        action: "poll" as const,
        params: {
          to: "123",
          pollQuestion: "Ready?",
          pollOption: ["Yes", "No"],
          pollMulti: "true",
          pollPublic: "true",
          silent: "true",
        },
        expectedPayload: {
          action: "poll",
          to: "123",
          question: "Ready?",
          answers: ["Yes", "No"],
          allowMultiselect: true,
          durationHours: undefined,
          durationSeconds: undefined,
          replyToMessageId: undefined,
          messageThreadId: undefined,
          isAnonymous: false,
          silent: true,
          accountId: undefined,
        },
      },
      {
        name: "poll rejects partially numeric duration strings before telegram action handoff",
        action: "poll" as const,
        params: {
          to: "123",
          pollQuestion: "Ready?",
          pollOption: ["Yes", "No"],
          pollDurationSeconds: "60s",
        },
        expectedPayload: {
          action: "poll",
          to: "123",
          question: "Ready?",
          answers: ["Yes", "No"],
          allowMultiselect: undefined,
          durationHours: undefined,
          durationSeconds: undefined,
          replyToMessageId: undefined,
          messageThreadId: undefined,
          isAnonymous: undefined,
          silent: undefined,
          accountId: undefined,
        },
      },
      {
        name: "topic-create maps to createForumTopic",
        action: "topic-create" as const,
        params: {
          to: "telegram:group:-1001234567890:topic:271",
          name: "Build Updates",
        },
        expectedPayload: {
          action: "createForumTopic",
          chatId: "telegram:group:-1001234567890:topic:271",
          name: "Build Updates",
          iconColor: undefined,
          iconCustomEmojiId: undefined,
          accountId: undefined,
        },
      },
    ] as const;

    for (const testCase of cases) {
      handleTelegramAction.mockClear();
      const { cfg } = await runTelegramAction(testCase.action, testCase.params);
      expect(handleTelegramAction, testCase.name).toHaveBeenCalledWith(
        testCase.expectedPayload,
        cfg,
        expect.objectContaining({ mediaLocalRoots: undefined }),
      );
    }
  });

  it("forwards trusted mediaLocalRoots for send", async () => {
    const cfg = telegramCfg();
    await telegramMessageActions.handleAction?.({
      channel: "telegram",
      action: "send",
      params: {
        to: "123",
        media: "/tmp/voice.ogg",
      },
      cfg,
      mediaLocalRoots: ["/tmp/agent-root"],
    });

    expect(handleTelegramAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        mediaUrl: "/tmp/voice.ogg",
      }),
      cfg,
      expect.objectContaining({ mediaLocalRoots: ["/tmp/agent-root"] }),
    );
  });

  it("rejects non-integer messageId for edit before reaching telegram-actions", async () => {
    const cfg = telegramCfg();
    const handleAction = telegramMessageActions.handleAction;
    if (!handleAction) {
      throw new Error("telegram handleAction unavailable");
    }

    await expect(
      handleAction({
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

  it("inherits top-level reaction gate when account overrides sticker only", () => {
    const cfg = {
      channels: {
        telegram: {
          actions: { reactions: false },
          accounts: {
            media: { botToken: "tok", actions: { sticker: true } },
          },
        },
      },
    } as OpenClawConfig;
    const actions = telegramMessageActions.listActions?.({ cfg }) ?? [];

    expect(actions).toContain("sticker");
    expect(actions).toContain("sticker-search");
    expect(actions).not.toContain("react");
  });

  it("accepts numeric messageId and channelId for reactions", async () => {
    const cfg = telegramCfg();

    await telegramMessageActions.handleAction?.({
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
    const call = handleTelegramAction.mock.calls[0]?.[0];
    if (!call) {
      throw new Error("missing telegram action call");
    }
    const callPayload = call as Record<string, unknown>;
    expect(callPayload.action).toBe("react");
    expect(String(callPayload.chatId)).toBe("123");
    expect(String(callPayload.messageId)).toBe("456");
    expect(callPayload.emoji).toBe("ok");
  });

  it("accepts snake_case message_id for reactions", async () => {
    const cfg = telegramCfg();

    await telegramMessageActions.handleAction?.({
      channel: "telegram",
      action: "react",
      params: {
        channelId: 123,
        message_id: "456",
        emoji: "ok",
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledTimes(1);
    const call = handleTelegramAction.mock.calls[0]?.[0];
    if (!call) {
      throw new Error("missing telegram action call");
    }
    const callPayload = call as Record<string, unknown>;
    expect(callPayload.action).toBe("react");
    expect(String(callPayload.chatId)).toBe("123");
    expect(String(callPayload.messageId)).toBe("456");
  });

  it("falls back to toolContext.currentMessageId for reactions when messageId is omitted", async () => {
    const cfg = telegramCfg();

    await telegramMessageActions.handleAction?.({
      channel: "telegram",
      action: "react",
      params: {
        chatId: "123",
        emoji: "ok",
      },
      cfg,
      accountId: undefined,
      toolContext: { currentMessageId: "9001" },
    });

    expect(handleTelegramAction).toHaveBeenCalledTimes(1);
    const call = handleTelegramAction.mock.calls[0]?.[0];
    if (!call) {
      throw new Error("missing telegram action call");
    }
    const callPayload = call as Record<string, unknown>;
    expect(callPayload.action).toBe("react");
    expect(String(callPayload.messageId)).toBe("9001");
  });

  it("forwards missing reaction messageId to telegram-actions for soft-fail handling", async () => {
    const cfg = telegramCfg();

    await expect(
      telegramMessageActions.handleAction?.({
        channel: "telegram",
        action: "react",
        params: {
          chatId: "123",
          emoji: "ok",
        },
        cfg,
        accountId: undefined,
      }),
    ).resolves.toBeDefined();

    expect(handleTelegramAction).toHaveBeenCalledTimes(1);
    const call = handleTelegramAction.mock.calls[0]?.[0];
    if (!call) {
      throw new Error("missing telegram action call");
    }
    const callPayload = call as Record<string, unknown>;
    expect(callPayload.action).toBe("react");
    expect(callPayload.messageId).toBeUndefined();
  });
});

describe("signalMessageActions", () => {
  it("lists actions based on account presence and reaction gates", () => {
    const cases = [
      {
        name: "no configured accounts",
        cfg: {} as OpenClawConfig,
        expected: [],
      },
      {
        name: "reactions disabled",
        cfg: {
          channels: { signal: { account: "+15550001111", actions: { reactions: false } } },
        } as OpenClawConfig,
        expected: ["send"],
      },
      {
        name: "account-level reactions enabled",
        cfg: createSignalAccountOverrideCfg(),
        expected: ["send", "react"],
      },
    ] as const;

    for (const testCase of cases) {
      expect(
        signalMessageActions.listActions?.({ cfg: testCase.cfg }) ?? [],
        testCase.name,
      ).toEqual(testCase.expected);
    }
  });

  it("skips send for plugin dispatch", () => {
    expect(signalMessageActions.supportsAction?.({ action: "send" })).toBe(false);
    expect(signalMessageActions.supportsAction?.({ action: "react" })).toBe(true);
  });

  it("blocks reactions when action gate is disabled", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111", actions: { reactions: false } } },
    } as OpenClawConfig;
    await expectSignalActionRejected(
      { to: "+15550001111", messageId: "123", emoji: "✅" },
      /actions\.reactions/,
      cfg,
    );
  });

  it("maps reaction targets into signal sendReaction calls", async () => {
    const cases = [
      {
        name: "uses account-level actions when enabled",
        cfg: createSignalAccountOverrideCfg(),
        accountId: "work",
        params: { to: "+15550001111", messageId: "123", emoji: "👍" },
        expectedRecipient: "+15550001111",
        expectedTimestamp: 123,
        expectedEmoji: "👍",
        expectedOptions: { accountId: "work" },
      },
      {
        name: "normalizes uuid recipients",
        cfg: { channels: { signal: { account: "+15550001111" } } } as OpenClawConfig,
        accountId: undefined,
        params: {
          recipient: "uuid:123e4567-e89b-12d3-a456-426614174000",
          messageId: "123",
          emoji: "🔥",
        },
        expectedRecipient: "123e4567-e89b-12d3-a456-426614174000",
        expectedTimestamp: 123,
        expectedEmoji: "🔥",
        expectedOptions: {},
      },
      {
        name: "passes groupId and targetAuthor for group reactions",
        cfg: { channels: { signal: { account: "+15550001111" } } } as OpenClawConfig,
        accountId: undefined,
        params: {
          to: "signal:group:group-id",
          targetAuthor: "uuid:123e4567-e89b-12d3-a456-426614174000",
          messageId: "123",
          emoji: "✅",
        },
        expectedRecipient: "",
        expectedTimestamp: 123,
        expectedEmoji: "✅",
        expectedOptions: {
          groupId: "group-id",
          targetAuthor: "uuid:123e4567-e89b-12d3-a456-426614174000",
        },
      },
    ] as const;

    for (const testCase of cases) {
      sendReactionSignal.mockClear();
      await runSignalAction("react", testCase.params, {
        cfg: testCase.cfg,
        accountId: testCase.accountId,
      });
      expect(sendReactionSignal, testCase.name).toHaveBeenCalledWith(
        testCase.expectedRecipient,
        testCase.expectedTimestamp,
        testCase.expectedEmoji,
        expect.objectContaining({
          cfg: testCase.cfg,
          ...testCase.expectedOptions,
        }),
      );
    }
  });

  it("falls back to toolContext.currentMessageId for reactions when messageId is omitted", async () => {
    sendReactionSignal.mockClear();
    await runSignalAction(
      "react",
      { to: "+15559999999", emoji: "🔥" },
      { toolContext: { currentMessageId: "1737630212345" } },
    );
    expect(sendReactionSignal).toHaveBeenCalledTimes(1);
    expect(sendReactionSignal).toHaveBeenCalledWith(
      "+15559999999",
      1737630212345,
      "🔥",
      expect.objectContaining({}),
    );
  });

  it("rejects reaction when neither messageId nor toolContext.currentMessageId is provided", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;
    await expectSignalActionRejected(
      { to: "+15559999999", emoji: "✅" },
      /messageId.*required/,
      cfg,
    );
  });

  it("requires targetAuthor for group reactions", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;
    await expectSignalActionRejected(
      { to: "signal:group:group-id", messageId: "123", emoji: "✅" },
      /targetAuthor/,
      cfg,
    );
  });
});

describe("slack actions adapter", () => {
  it("forwards threadId for read", async () => {
    await runSlackAction("read", {
      channelId: "C1",
      threadId: "171234.567",
    });

    expectFirstSlackAction({
      action: "readMessages",
      channelId: "C1",
      threadId: "171234.567",
    });
  });

  it("forwards normalized limit for emoji-list", async () => {
    await runSlackAction("emoji-list", {
      limit: "2.9",
    });

    expectFirstSlackAction({
      action: "emojiList",
      limit: 2,
    });
  });

  it("forwards blocks for send/edit actions", async () => {
    const cases = [
      {
        action: "send" as const,
        params: {
          to: "channel:C1",
          message: "",
          blocks: JSON.stringify([{ type: "divider" }]),
        },
        expected: {
          action: "sendMessage",
          to: "channel:C1",
          content: "",
          blocks: [{ type: "divider" }],
        },
      },
      {
        action: "send" as const,
        params: {
          to: "channel:C1",
          message: "",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "hi" } }],
        },
        expected: {
          action: "sendMessage",
          to: "channel:C1",
          content: "",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "hi" } }],
        },
      },
      {
        action: "edit" as const,
        params: {
          channelId: "C1",
          messageId: "171234.567",
          message: "",
          blocks: JSON.stringify([{ type: "divider" }]),
        },
        expected: {
          action: "editMessage",
          channelId: "C1",
          messageId: "171234.567",
          content: "",
          blocks: [{ type: "divider" }],
        },
      },
      {
        action: "edit" as const,
        params: {
          channelId: "C1",
          messageId: "171234.567",
          message: "",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "updated" } }],
        },
        expected: {
          action: "editMessage",
          channelId: "C1",
          messageId: "171234.567",
          content: "",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "updated" } }],
        },
      },
    ] as const;

    for (const testCase of cases) {
      handleSlackAction.mockClear();
      await runSlackAction(testCase.action, testCase.params);
      expectFirstSlackAction(testCase.expected);
    }
  });

  it("rejects invalid send block combinations before dispatch", async () => {
    const cases = [
      {
        name: "invalid JSON",
        params: {
          to: "channel:C1",
          message: "",
          blocks: "{bad-json",
        },
        error: /blocks must be valid JSON/i,
      },
      {
        name: "empty blocks",
        params: {
          to: "channel:C1",
          message: "",
          blocks: "[]",
        },
        error: /at least one block/i,
      },
      {
        name: "blocks with media",
        params: {
          to: "channel:C1",
          message: "",
          media: "https://example.com/image.png",
          blocks: JSON.stringify([{ type: "divider" }]),
        },
        error: /does not support blocks with media/i,
      },
    ] as const;

    for (const testCase of cases) {
      handleSlackAction.mockClear();
      await expectSlackSendRejected(testCase.params, testCase.error);
    }
  });

  it("rejects edit when both message and blocks are missing", async () => {
    const { cfg, actions } = slackHarness();

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
