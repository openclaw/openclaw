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

let discordMessageActions: typeof import("./discord.js").discordMessageActions;
let handleDiscordMessageAction: typeof import("./discord/handle-action.js").handleDiscordMessageAction;
let telegramMessageActions: typeof import("./telegram.js").telegramMessageActions;
let signalMessageActions: typeof import("./signal.js").signalMessageActions;
let createSlackActions: typeof import("../slack.actions.js").createSlackActions;

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

beforeEach(async () => {
  vi.resetModules();
  ({ discordMessageActions } = await import("./discord.js"));
  ({ handleDiscordMessageAction } = await import("./discord/handle-action.js"));
  ({ telegramMessageActions } = await import("./telegram.js"));
  ({ signalMessageActions } = await import("./signal.js"));
  ({ createSlackActions } = await import("../slack.actions.js"));
  vi.clearAllMocks();
});

describe("discord message actions", () => {
  it("derives discord action listings from channel and moderation gates", () => {
    const cases = [
      {
        name: "defaults",
        cfg: { channels: { discord: { token: "d0" } } } as OpenClawConfig,
        expectUploads: true,
        expectChannelCreate: true,
        expectModeration: false,
      },
      {
        name: "disabled channel actions",
        cfg: {
          channels: { discord: { token: "d0", actions: { channels: false } } },
        } as OpenClawConfig,
        expectUploads: true,
        expectChannelCreate: false,
        expectModeration: false,
      },
      {
        name: "single account enables moderation",
        cfg: {
          channels: {
            discord: {
              accounts: {
                vime: { token: "d1", actions: { moderation: true } },
              },
            },
          },
        } as OpenClawConfig,
        expectUploads: true,
        expectChannelCreate: true,
        expectModeration: true,
      },
      {
        name: "one of many accounts enables moderation",
        cfg: {
          channels: {
            discord: {
              accounts: {
                ops: { token: "d1", actions: { moderation: true } },
                chat: { token: "d2" },
              },
            },
          },
        } as OpenClawConfig,
        expectUploads: true,
        expectChannelCreate: true,
        expectModeration: true,
      },
      {
        name: "all accounts omit moderation",
        cfg: {
          channels: {
            discord: {
              accounts: {
                ops: { token: "d1" },
                chat: { token: "d2" },
              },
            },
          },
        } as OpenClawConfig,
        expectUploads: true,
        expectChannelCreate: true,
        expectModeration: false,
      },
      {
        name: "account moderation override inherits disabled top-level channels",
        cfg: createDiscordModerationOverrideCfg(),
        expectUploads: true,
        expectChannelCreate: false,
        expectModeration: true,
      },
      {
        name: "account override re-enables top-level disabled channels",
        cfg: createDiscordModerationOverrideCfg({ channelsEnabled: true }),
        expectUploads: true,
        expectChannelCreate: true,
        expectModeration: true,
      },
    ] as const;

    for (const testCase of cases) {
      const actions = discordMessageActions.listActions?.({ cfg: testCase.cfg }) ?? [];
      if (testCase.expectUploads) {
        expect(actions, testCase.name).toContain("emoji-upload");
        expect(actions, testCase.name).toContain("sticker-upload");
      }
      expectChannelCreateAction(actions, testCase.expectChannelCreate);
      if (testCase.expectModeration) {
        expectModerationActions(actions);
      } else {
        expect(actions, testCase.name).not.toContain("timeout");
        expect(actions, testCase.name).not.toContain("kick");
        expect(actions, testCase.name).not.toContain("ban");
      }
    }
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

  it("handles discord reaction messageId resolution", async () => {
    const cases = [
      {
        name: "falls back to toolContext.currentMessageId",
        run: async () => {
          await handleDiscordMessageAction({
            action: "react",
            params: {
              channelId: "123",
              emoji: "ok",
            },
            cfg: {} as OpenClawConfig,
            toolContext: { currentMessageId: "9001" },
          });
        },
        assert: () => {
          const call = handleDiscordAction.mock.calls.at(-1);
          expect(call?.[0]).toEqual(
            expect.objectContaining({
              action: "react",
              channelId: "123",
              messageId: "9001",
              emoji: "ok",
            }),
          );
        },
      },
      {
        name: "rejects when no message id source is available",
        run: async () => {
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
        },
        assert: () => {
          expect(handleDiscordAction).not.toHaveBeenCalled();
        },
      },
    ] as const;

    for (const testCase of cases) {
      handleDiscordAction.mockClear();
      await testCase.run();
      testCase.assert();
    }
  });
});

describe("telegramMessageActions", () => {
  it("computes poll/topic action availability from telegram config gates", () => {
    for (const testCase of [
      {
        name: "configured telegram enables poll",
        cfg: telegramCfg(),
        expectPoll: true,
        expectTopicEdit: true,
      },
      {
        name: "topic edit gate enables topic-edit",
        cfg: {
          channels: {
            telegram: {
              botToken: "tok",
              actions: { editForumTopic: true },
            },
          },
        } as OpenClawConfig,
        expectPoll: true,
        expectTopicEdit: true,
      },
      {
        name: "sendMessage disabled hides poll",
        cfg: {
          channels: {
            telegram: {
              botToken: "tok",
              actions: { sendMessage: false },
            },
          },
        } as OpenClawConfig,
        expectPoll: false,
        expectTopicEdit: true,
      },
      {
        name: "poll gate disabled hides poll",
        cfg: {
          channels: {
            telegram: {
              botToken: "tok",
              actions: { poll: false },
            },
          },
        } as OpenClawConfig,
        expectPoll: false,
        expectTopicEdit: true,
      },
      {
        name: "split account gates do not expose poll",
        cfg: {
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
        } as OpenClawConfig,
        expectPoll: false,
        expectTopicEdit: true,
      },
    ]) {
      const actions = telegramMessageActions.listActions?.({ cfg: testCase.cfg }) ?? [];
      if (testCase.expectPoll) {
        expect(actions, testCase.name).toContain("poll");
      } else {
        expect(actions, testCase.name).not.toContain("poll");
      }
      if (testCase.expectTopicEdit) {
        expect(actions, testCase.name).toContain("topic-edit");
      } else {
        expect(actions, testCase.name).not.toContain("topic-edit");
      }
    }
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
      {
        name: "topic-edit maps to editForumTopic",
        action: "topic-edit" as const,
        params: {
          to: "telegram:group:-1001234567890:topic:271",
          threadId: 271,
          name: "Build Updates",
          iconCustomEmojiId: "emoji-123",
        },
        expectedPayload: {
          action: "editForumTopic",
          chatId: "telegram:group:-1001234567890:topic:271",
          messageThreadId: 271,
          name: "Build Updates",
          iconCustomEmojiId: "emoji-123",
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

  it("normalizes telegram reaction message identifiers before dispatch", async () => {
    const cfg = telegramCfg();
    for (const testCase of [
      {
        name: "numeric channelId/messageId",
        params: {
          channelId: 123,
          messageId: 456,
          emoji: "ok",
        },
        toolContext: undefined,
        expectedChatId: "123",
        expectedMessageId: "456",
      },
      {
        name: "snake_case message_id",
        params: {
          channelId: 123,
          message_id: "456",
          emoji: "ok",
        },
        toolContext: undefined,
        expectedChatId: "123",
        expectedMessageId: "456",
      },
      {
        name: "toolContext fallback",
        params: {
          chatId: "123",
          emoji: "ok",
        },
        toolContext: { currentMessageId: "9001" },
        expectedChatId: "123",
        expectedMessageId: "9001",
      },
      {
        name: "missing messageId soft-falls through to telegram-actions",
        params: {
          chatId: "123",
          emoji: "ok",
        },
        toolContext: undefined,
        expectedChatId: "123",
        expectedMessageId: undefined,
      },
    ] as const) {
      handleTelegramAction.mockClear();
      await expect(
        telegramMessageActions.handleAction?.({
          channel: "telegram",
          action: "react",
          params: testCase.params,
          cfg,
          accountId: undefined,
          toolContext: testCase.toolContext,
        }),
      ).resolves.toBeDefined();

      expect(handleTelegramAction, testCase.name).toHaveBeenCalledTimes(1);
      const call = handleTelegramAction.mock.calls[0]?.[0];
      if (!call) {
        throw new Error("missing telegram action call");
      }
      const callPayload = call as Record<string, unknown>;
      expect(callPayload.action, testCase.name).toBe("react");
      expect(String(callPayload.chatId), testCase.name).toBe(testCase.expectedChatId);
      if (testCase.expectedMessageId === undefined) {
        expect(callPayload.messageId, testCase.name).toBeUndefined();
      } else {
        expect(String(callPayload.messageId), testCase.name).toBe(testCase.expectedMessageId);
      }
    }
  });
});

it("forwards trusted mediaLocalRoots for send actions", async () => {
  const cases = [
    {
      name: "discord",
      run: async () => {
        await handleDiscordMessageAction({
          action: "send",
          params: { to: "channel:123", message: "hi", media: "/tmp/file.png" },
          cfg: {} as OpenClawConfig,
          mediaLocalRoots: ["/tmp/agent-root"],
        });
      },
      assert: () => {
        expect(handleDiscordAction).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "sendMessage",
            mediaUrl: "/tmp/file.png",
          }),
          expect.any(Object),
          expect.objectContaining({ mediaLocalRoots: ["/tmp/agent-root"] }),
        );
      },
      clear: () => handleDiscordAction.mockClear(),
    },
    {
      name: "telegram",
      run: async () => {
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
      },
      assert: () => {
        expect(handleTelegramAction).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "sendMessage",
            mediaUrl: "/tmp/voice.ogg",
          }),
          expect.any(Object),
          expect.objectContaining({ mediaLocalRoots: ["/tmp/agent-root"] }),
        );
      },
      clear: () => handleTelegramAction.mockClear(),
    },
  ] as const;

  for (const testCase of cases) {
    testCase.clear();
    await testCase.run();
    testCase.assert();
  }
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
        toolContext: undefined,
      },
      {
        name: "falls back to toolContext.currentMessageId when messageId is omitted",
        cfg: { channels: { signal: { account: "+15550001111" } } } as OpenClawConfig,
        accountId: undefined,
        params: { to: "+15559999999", emoji: "🔥" },
        expectedRecipient: "+15559999999",
        expectedTimestamp: 1737630212345,
        expectedEmoji: "🔥",
        expectedOptions: {},
        toolContext: { currentMessageId: "1737630212345" },
      },
    ] as const;

    for (const testCase of cases) {
      sendReactionSignal.mockClear();
      await runSignalAction("react", testCase.params, {
        cfg: testCase.cfg,
        accountId: testCase.accountId,
        toolContext: testCase.toolContext,
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

  it("rejects invalid signal reaction inputs before dispatch", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;
    for (const testCase of [
      {
        params: { to: "+15559999999", emoji: "✅" },
        error: /messageId.*required/,
      },
      {
        params: { to: "signal:group:group-id", messageId: "123", emoji: "✅" },
        error: /targetAuthor/,
      },
    ] as const) {
      await expectSignalActionRejected(testCase.params, testCase.error, cfg);
    }
  });
});

describe("slack actions adapter", () => {
  it("forwards slack action params", async () => {
    const cases = [
      {
        action: "read" as const,
        params: {
          channelId: "C1",
          threadId: "171234.567",
        },
        expected: {
          action: "readMessages",
          channelId: "C1",
          threadId: "171234.567",
        },
      },
      {
        action: "emoji-list" as const,
        params: {
          limit: "2.9",
        },
        expected: {
          action: "emojiList",
          limit: 2,
        },
      },
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
      {
        action: "send" as const,
        params: {
          to: "channel:C1",
          message: "",
          media: "https://example.com/image.png",
        },
        expected: {
          action: "sendMessage",
          to: "channel:C1",
          content: "",
          mediaUrl: "https://example.com/image.png",
        },
        absentKeys: ["blocks"],
      },
    ] as const;

    for (const testCase of cases) {
      handleSlackAction.mockClear();
      await runSlackAction(testCase.action, testCase.params);
      expectFirstSlackAction(testCase.expected);
      const [params] = handleSlackAction.mock.calls[0] ?? [];
      for (const key of testCase.absentKeys ?? []) {
        expect(params).not.toHaveProperty(key);
      }
    }
  });

  it("rejects invalid Slack payloads before dispatch", async () => {
    const cases = [
      {
        name: "invalid JSON",
        action: "send" as const,
        params: {
          to: "channel:C1",
          message: "",
          blocks: "{bad-json",
        },
        error: /blocks must be valid JSON/i,
      },
      {
        name: "empty blocks",
        action: "send" as const,
        params: {
          to: "channel:C1",
          message: "",
          blocks: "[]",
        },
        error: /at least one block/i,
      },
      {
        name: "blocks with media",
        action: "send" as const,
        params: {
          to: "channel:C1",
          message: "",
          media: "https://example.com/image.png",
          blocks: JSON.stringify([{ type: "divider" }]),
        },
        error: /does not support blocks with media/i,
      },
      {
        name: "edit missing message and blocks",
        action: "edit" as const,
        params: {
          channelId: "C1",
          messageId: "171234.567",
          message: "",
        },
        error: /edit requires message or blocks/i,
      },
    ] as const;

    for (const testCase of cases) {
      handleSlackAction.mockClear();
      if (testCase.action === "send") {
        await expectSlackSendRejected(testCase.params, testCase.error);
      } else {
        const { cfg, actions } = slackHarness();
        await expect(
          actions.handleAction?.({
            channel: "slack",
            action: "edit",
            cfg,
            params: testCase.params,
          }),
        ).rejects.toThrow(testCase.error);
      }
      expect(handleSlackAction, testCase.name).not.toHaveBeenCalled();
    }
  });
});
