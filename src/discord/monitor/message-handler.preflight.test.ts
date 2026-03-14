import { ChannelType } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transcribeFirstAudioMock = vi.hoisted(() => vi.fn());

vi.mock("../../media-understanding/audio-preflight.js", () => ({
  transcribeFirstAudio: (...args: unknown[]) => transcribeFirstAudioMock(...args),
}));
import {
  __testing as sessionBindingTesting,
  registerSessionBindingAdapter,
} from "../../infra/outbound/session-binding-service.js";
import {
  preflightDiscordMessage,
  resolvePreflightMentionRequirement,
  shouldIgnoreBoundThreadWebhookMessage,
} from "./message-handler.preflight.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
  DEFAULT_PREFLIGHT_CFG,
  type DiscordClient,
  type DiscordConfig,
  type DiscordMessageEvent,
} from "./message-handler.preflight.test-helpers.js";
import {
  __testing as threadBindingTesting,
  createThreadBindingManager,
} from "./thread-bindings.js";

function createThreadBinding(
  overrides?: Partial<
    import("../../infra/outbound/session-binding-service.js").SessionBindingRecord
  >,
) {
  return {
    bindingId: "default:thread-1",
    targetSessionKey: "agent:main:subagent:child-1",
    targetKind: "subagent",
    conversation: {
      channel: "discord",
      accountId: "default",
      conversationId: "thread-1",
      parentConversationId: "parent-1",
    },
    status: "active",
    boundAt: 1,
    metadata: {
      agentId: "main",
      boundBy: "test",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    },
    ...overrides,
  } satisfies import("../../infra/outbound/session-binding-service.js").SessionBindingRecord;
}

function createPreflightArgs(params: {
  cfg: import("../../config/config.js").OpenClawConfig;
  discordConfig: DiscordConfig;
  data: DiscordMessageEvent;
  client: DiscordClient;
}): Parameters<typeof preflightDiscordMessage>[0] {
  return createDiscordPreflightArgs(params);
}

function createThreadClient(params: { threadId: string; parentId: string }): DiscordClient {
  return {
    fetchChannel: async (channelId: string) => {
      if (channelId === params.threadId) {
        return {
          id: params.threadId,
          type: ChannelType.PublicThread,
          name: "focus",
          parentId: params.parentId,
          ownerId: "owner-1",
        };
      }
      if (channelId === params.parentId) {
        return {
          id: params.parentId,
          type: ChannelType.GuildText,
          name: "general",
        };
      }
      return null;
    },
  } as unknown as DiscordClient;
}

async function runThreadBoundPreflight(params: {
  threadId: string;
  parentId: string;
  message: import("@buape/carbon").Message;
  threadBinding: import("../../infra/outbound/session-binding-service.js").SessionBindingRecord;
  discordConfig: DiscordConfig;
  registerBindingAdapter?: boolean;
}) {
  if (params.registerBindingAdapter) {
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === params.threadId ? params.threadBinding : null,
    });
  }

  const client = createThreadClient({
    threadId: params.threadId,
    parentId: params.parentId,
  });

  return preflightDiscordMessage({
    ...createPreflightArgs({
      cfg: DEFAULT_PREFLIGHT_CFG,
      discordConfig: params.discordConfig,
      data: createGuildEvent({
        channelId: params.threadId,
        guildId: "guild-1",
        author: params.message.author,
        message: params.message,
      }),
      client,
    }),
    threadBindings: {
      getByThreadId: (id: string) => (id === params.threadId ? params.threadBinding : undefined),
    } as import("./thread-bindings.js").ThreadBindingManager,
  });
}

async function runGuildPreflight(params: {
  channelId: string;
  guildId: string;
  message: import("@buape/carbon").Message;
  discordConfig: DiscordConfig;
  cfg?: import("../../config/config.js").OpenClawConfig;
  guildEntries?: Parameters<typeof preflightDiscordMessage>[0]["guildEntries"];
  includeGuildObject?: boolean;
}) {
  return preflightDiscordMessage({
    ...createPreflightArgs({
      cfg: params.cfg ?? DEFAULT_PREFLIGHT_CFG,
      discordConfig: params.discordConfig,
      data: createGuildEvent({
        channelId: params.channelId,
        guildId: params.guildId,
        author: params.message.author,
        message: params.message,
        includeGuildObject: params.includeGuildObject,
      }),
      client: createGuildTextClient(params.channelId),
    }),
    guildEntries: params.guildEntries,
  });
}

async function runMentionOnlyBotPreflight(params: {
  channelId: string;
  guildId: string;
  message: import("@buape/carbon").Message;
}) {
  return runGuildPreflight({
    channelId: params.channelId,
    guildId: params.guildId,
    message: params.message,
    discordConfig: {
      allowBots: "mentions",
    } as DiscordConfig,
  });
}

async function runIgnoreOtherMentionsPreflight(params: {
  channelId: string;
  guildId: string;
  message: import("@buape/carbon").Message;
}) {
  return runGuildPreflight({
    channelId: params.channelId,
    guildId: params.guildId,
    message: params.message,
    discordConfig: {} as DiscordConfig,
    guildEntries: {
      [params.guildId]: {
        requireMention: false,
        ignoreOtherMentions: true,
      },
    },
  });
}

describe("resolvePreflightMentionRequirement", () => {
  it("requires mention when config requires mention and thread is not bound", () => {
    expect(
      resolvePreflightMentionRequirement({
        shouldRequireMention: true,
        isBoundThreadSession: false,
      }),
    ).toBe(true);
  });

  it("disables mention requirement for bound thread sessions", () => {
    expect(
      resolvePreflightMentionRequirement({
        shouldRequireMention: true,
        isBoundThreadSession: true,
      }),
    ).toBe(false);
  });

  it("keeps mention requirement disabled when config already disables it", () => {
    expect(
      resolvePreflightMentionRequirement({
        shouldRequireMention: false,
        isBoundThreadSession: false,
      }),
    ).toBe(false);
  });
});

describe("preflightDiscordMessage", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    transcribeFirstAudioMock.mockReset();
  });

  it("drops bound-thread bot system messages to prevent ACP self-loop", async () => {
    const threadBinding = createThreadBinding({
      targetKind: "session",
      targetSessionKey: "agent:main:acp:discord-thread-1",
    });
    const threadId = "thread-system-1";
    const parentId = "channel-parent-1";
    const message = createDiscordMessage({
      id: "m-system-1",
      channelId: threadId,
      content:
        "⚙️ codex-acp session active (auto-unfocus in 24h). Messages here go directly to this session.",
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "OpenClaw",
      },
    });

    const result = await runThreadBoundPreflight({
      threadId,
      parentId,
      message,
      threadBinding,
      discordConfig: {
        allowBots: true,
      } as DiscordConfig,
    });

    expect(result).toBeNull();
  });

  it("keeps bound-thread regular bot messages flowing when allowBots=true", async () => {
    const threadBinding = createThreadBinding({
      targetKind: "session",
      targetSessionKey: "agent:main:acp:discord-thread-1",
    });
    const threadId = "thread-bot-regular-1";
    const parentId = "channel-parent-regular-1";
    const message = createDiscordMessage({
      id: "m-bot-regular-1",
      channelId: threadId,
      content: "here is tool output chunk",
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "Relay",
      },
    });

    const result = await runThreadBoundPreflight({
      threadId,
      parentId,
      message,
      threadBinding,
      discordConfig: {
        allowBots: true,
      } as DiscordConfig,
      registerBindingAdapter: true,
    });

    expect(result).not.toBeNull();
    expect(result?.boundSessionKey).toBe(threadBinding.targetSessionKey);
  });

  it("bypasses mention gating in bound threads for allowed bot senders", async () => {
    const threadBinding = createThreadBinding();
    const threadId = "thread-bot-focus";
    const parentId = "channel-parent-focus";
    const client = createThreadClient({ threadId, parentId });
    const message = createDiscordMessage({
      id: "m-bot-1",
      channelId: threadId,
      content: "relay message without mention",
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "Relay",
      },
    });

    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (ref) => (ref.conversationId === threadId ? threadBinding : null),
    });

    const result = await preflightDiscordMessage(
      createPreflightArgs({
        cfg: {
          ...DEFAULT_PREFLIGHT_CFG,
        } as import("../../config/config.js").OpenClawConfig,
        discordConfig: {
          allowBots: true,
        } as DiscordConfig,
        data: createGuildEvent({
          channelId: threadId,
          guildId: "guild-1",
          author: message.author,
          message,
        }),
        client,
      }),
    );

    expect(result).not.toBeNull();
    expect(result?.boundSessionKey).toBe(threadBinding.targetSessionKey);
    expect(result?.shouldRequireMention).toBe(false);
  });

  it("drops bot messages without mention when allowBots=mentions", async () => {
    const channelId = "channel-bot-mentions-off";
    const guildId = "guild-bot-mentions-off";
    const message = createDiscordMessage({
      id: "m-bot-mentions-off",
      channelId,
      content: "relay chatter",
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "Relay",
      },
    });

    const result = await runMentionOnlyBotPreflight({ channelId, guildId, message });

    expect(result).toBeNull();
  });

  it("allows bot messages with explicit mention when allowBots=mentions", async () => {
    const channelId = "channel-bot-mentions-on";
    const guildId = "guild-bot-mentions-on";
    const message = createDiscordMessage({
      id: "m-bot-mentions-on",
      channelId,
      content: "hi <@openclaw-bot>",
      mentionedUsers: [{ id: "openclaw-bot" }],
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "Relay",
      },
    });

    const result = await runMentionOnlyBotPreflight({ channelId, guildId, message });

    expect(result).not.toBeNull();
  });

  it("accepts allowlisted guild messages when guild object is missing", async () => {
    const message = createDiscordMessage({
      id: "m-guild-id-only",
      channelId: "ch-1",
      content: "hello from maintainers",
      author: {
        id: "user-1",
        bot: false,
        username: "Peter",
      },
    });

    const result = await runGuildPreflight({
      channelId: "ch-1",
      guildId: "guild-1",
      message,
      discordConfig: {} as DiscordConfig,
      guildEntries: {
        "guild-1": {
          channels: {
            "ch-1": {
              allow: true,
              requireMention: false,
            },
          },
        },
      },
      includeGuildObject: false,
    });

    expect(result).not.toBeNull();
    expect(result?.guildInfo?.id).toBe("guild-1");
    expect(result?.channelConfig?.allowed).toBe(true);
    expect(result?.shouldRequireMention).toBe(false);
  });

  it("inherits parent thread allowlist when guild object is missing", async () => {
    const threadId = "thread-1";
    const parentId = "parent-1";
    const message = createDiscordMessage({
      id: "m-thread-id-only",
      channelId: threadId,
      content: "thread hello",
      author: {
        id: "user-1",
        bot: false,
        username: "Peter",
      },
    });

    const result = await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: DEFAULT_PREFLIGHT_CFG,
        discordConfig: {} as DiscordConfig,
        data: createGuildEvent({
          channelId: threadId,
          guildId: "guild-1",
          author: message.author,
          message,
          includeGuildObject: false,
        }),
        client: createThreadClient({
          threadId,
          parentId,
        }),
      }),
      guildEntries: {
        "guild-1": {
          channels: {
            [parentId]: {
              allow: true,
              requireMention: false,
            },
          },
        },
      },
    });

    expect(result).not.toBeNull();
    expect(result?.guildInfo?.id).toBe("guild-1");
    expect(result?.threadParentId).toBe(parentId);
    expect(result?.channelConfig?.allowed).toBe(true);
    expect(result?.shouldRequireMention).toBe(false);
  });

  it("drops guild messages that mention another user when ignoreOtherMentions=true", async () => {
    const channelId = "channel-other-mention-1";
    const guildId = "guild-other-mention-1";
    const message = createDiscordMessage({
      id: "m-other-mention-1",
      channelId,
      content: "hello <@999>",
      mentionedUsers: [{ id: "999" }],
      author: {
        id: "user-1",
        bot: false,
        username: "Alice",
      },
    });

    const result = await runIgnoreOtherMentionsPreflight({ channelId, guildId, message });

    expect(result).toBeNull();
  });

  it("does not drop @everyone messages when ignoreOtherMentions=true", async () => {
    const channelId = "channel-other-mention-everyone";
    const guildId = "guild-other-mention-everyone";
    const message = createDiscordMessage({
      id: "m-other-mention-everyone",
      channelId,
      content: "@everyone heads up",
      mentionedEveryone: true,
      author: {
        id: "user-1",
        bot: false,
        username: "Alice",
      },
    });

    const result = await runIgnoreOtherMentionsPreflight({ channelId, guildId, message });

    expect(result).not.toBeNull();
    expect(result?.hasAnyMention).toBe(true);
  });

  it("ignores bot-sent @everyone mentions for detection", async () => {
    const channelId = "channel-everyone-1";
    const guildId = "guild-everyone-1";
    const client = createGuildTextClient(channelId);
    const message = createDiscordMessage({
      id: "m-everyone-1",
      channelId,
      content: "@everyone heads up",
      mentionedEveryone: true,
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "Relay",
      },
    });

    const result = await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: DEFAULT_PREFLIGHT_CFG,
        discordConfig: {
          allowBots: true,
        } as DiscordConfig,
        data: createGuildEvent({
          channelId,
          guildId,
          author: message.author,
          message,
        }),
        client,
      }),
      guildEntries: {
        [guildId]: {
          requireMention: false,
        },
      },
    });

    expect(result).not.toBeNull();
    expect(result?.hasAnyMention).toBe(false);
  });

  it("uses attachment content_type for guild audio preflight mention detection", async () => {
    transcribeFirstAudioMock.mockResolvedValue("hey openclaw");

    const channelId = "channel-audio-1";
    const client = createGuildTextClient(channelId);

    const message = createDiscordMessage({
      id: "m-audio-1",
      channelId,
      content: "",
      attachments: [
        {
          id: "att-1",
          url: "https://cdn.discordapp.com/attachments/voice.ogg",
          content_type: "audio/ogg",
          filename: "voice.ogg",
        },
      ],
      author: {
        id: "user-1",
        bot: false,
        username: "Alice",
      },
    });

    const result = await preflightDiscordMessage(
      createPreflightArgs({
        cfg: {
          ...DEFAULT_PREFLIGHT_CFG,
          messages: {
            groupChat: {
              mentionPatterns: ["openclaw"],
            },
          },
        } as import("../../config/config.js").OpenClawConfig,
        discordConfig: {} as DiscordConfig,
        data: createGuildEvent({
          channelId,
          guildId: "guild-1",
          author: message.author,
          message,
        }),
        client,
      }),
    );

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(transcribeFirstAudioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          MediaUrls: ["https://cdn.discordapp.com/attachments/voice.ogg"],
          MediaTypes: ["audio/ogg"],
        }),
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.wasMentioned).toBe(true);
  });
});

describe("shouldIgnoreBoundThreadWebhookMessage", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    threadBindingTesting.resetThreadBindingsForTests();
  });

  it("returns true when inbound webhook id matches the bound thread webhook", () => {
    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        webhookId: "wh-1",
        threadBinding: createThreadBinding(),
      }),
    ).toBe(true);
  });

  it("returns false when webhook ids differ", () => {
    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        webhookId: "wh-other",
        threadBinding: createThreadBinding(),
      }),
    ).toBe(false);
  });

  it("returns false when there is no bound thread webhook", () => {
    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        webhookId: "wh-1",
        threadBinding: createThreadBinding({
          metadata: {
            webhookId: undefined,
          },
        }),
      }),
    ).toBe(false);
  });

  it("returns true for recently unbound thread webhook echoes", async () => {
    const manager = createThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });
    const binding = await manager.bindTarget({
      threadId: "thread-1",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child-1",
      agentId: "main",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });
    expect(binding).not.toBeNull();

    manager.unbindThread({
      threadId: "thread-1",
      sendFarewell: false,
    });

    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        accountId: "default",
        threadId: "thread-1",
        webhookId: "wh-1",
      }),
    ).toBe(true);
  });
});
