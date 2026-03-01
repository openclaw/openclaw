import type { Client } from "@buape/carbon";
import { ChannelType, MessageType } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createReplyDispatcherWithTyping } from "../auto-reply/reply/reply-dispatcher.js";
import {
  dispatchMock,
  readAllowFromStoreMock,
  sendMock,
  updateLastRouteMock,
  upsertPairingRequestMock,
} from "./monitor.tool-result.test-harness.js";
import { __resetDiscordChannelInfoCacheForTest } from "./monitor/message-utils.js";
import { createNoopThreadBindingManager } from "./monitor/thread-bindings.js";
const loadConfigMock = vi.fn();

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: (...args: unknown[]) => loadConfigMock(...args),
  };
});

beforeEach(() => {
  vi.useRealTimers();
  sendMock.mockClear().mockResolvedValue(undefined);
  updateLastRouteMock.mockClear();
  dispatchMock.mockClear().mockImplementation(async (params: unknown) => {
    if (
      typeof params === "object" &&
      params !== null &&
      "dispatcher" in params &&
      typeof params.dispatcher === "object" &&
      params.dispatcher !== null &&
      "sendFinalReply" in params.dispatcher &&
      typeof params.dispatcher.sendFinalReply === "function"
    ) {
      params.dispatcher.sendFinalReply({ text: "hi" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    }
    if (
      typeof params === "object" &&
      params !== null &&
      "dispatcherOptions" in params &&
      params.dispatcherOptions
    ) {
      const { dispatcher, markDispatchIdle } = createReplyDispatcherWithTyping(
        params.dispatcherOptions as Parameters<typeof createReplyDispatcherWithTyping>[0],
      );
      dispatcher.sendFinalReply({ text: "final reply" });
      await dispatcher.waitForIdle();
      markDispatchIdle();
      return { queuedFinal: true, counts: dispatcher.getQueuedCounts() };
    }
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  });
  readAllowFromStoreMock.mockClear().mockResolvedValue([]);
  upsertPairingRequestMock.mockClear().mockResolvedValue({ code: "PAIRCODE", created: true });
  loadConfigMock.mockClear().mockReturnValue({});
  __resetDiscordChannelInfoCacheForTest();
});

const MENTION_PATTERNS_TEST_TIMEOUT_MS = process.platform === "win32" ? 90_000 : 60_000;

type LoadedConfig = ReturnType<(typeof import("../config/config.js"))["loadConfig"]>;
let createDiscordMessageHandler: typeof import("./monitor.js").createDiscordMessageHandler;
let createDiscordNativeCommand: typeof import("./monitor.js").createDiscordNativeCommand;

beforeAll(async () => {
  ({ createDiscordMessageHandler, createDiscordNativeCommand } = await import("./monitor.js"));
});

function makeRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
}

async function createHandler(cfg: LoadedConfig) {
  return createDiscordMessageHandler({
    cfg,
    discordConfig: cfg.channels?.discord,
    accountId: "default",
    token: "token",
    runtime: makeRuntime(),
    botUserId: "bot-id",
    guildHistories: new Map(),
    historyLimit: 0,
    mediaMaxBytes: 10_000,
    textLimit: 2000,
    replyToMode: "off",
    dmEnabled: true,
    groupDmEnabled: false,
    guildEntries: cfg.channels?.discord?.guilds,
    threadBindings: createNoopThreadBindingManager("default"),
  });
}

function captureNextDispatchCtx<
  T extends {
    SessionKey?: string;
    ParentSessionKey?: string;
    ThreadStarterBody?: string;
    ThreadLabel?: string;
  },
>(): () => T | undefined {
  let capturedCtx: T | undefined;
  dispatchMock.mockImplementationOnce(async ({ ctx, dispatcher }) => {
    capturedCtx = ctx as T;
    dispatcher.sendFinalReply({ text: "hi" });
    return { queuedFinal: true, counts: { final: 1 } };
  });
  return () => capturedCtx;
}

function createDefaultThreadConfig(): LoadedConfig {
  return {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-5",
        workspace: "/tmp/openclaw",
      },
    },
    session: { store: "/tmp/openclaw-sessions.json" },
    messages: { responsePrefix: "PFX" },
    channels: {
      discord: {
        dm: { enabled: true, policy: "open" },
        groupPolicy: "open",
        guilds: { "*": { requireMention: false } },
      },
    },
  } as LoadedConfig;
}

function createMentionRequiredGuildConfig(
  params: {
    messages?: LoadedConfig["messages"];
  } = {},
): LoadedConfig {
  return {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-5",
        workspace: "/tmp/openclaw",
      },
    },
    session: { store: "/tmp/openclaw-sessions.json" },
    channels: {
      discord: {
        dm: { enabled: true, policy: "open" },
        groupPolicy: "open",
        guilds: { "*": { requireMention: true } },
      },
    },
    ...(params.messages ? { messages: params.messages } : {}),
  } as LoadedConfig;
}

function createGuildTextClient() {
  return {
    fetchChannel: vi.fn().mockResolvedValue({
      type: ChannelType.GuildText,
      name: "general",
    }),
  } as unknown as Client;
}

function createGuildMessageEvent(params: {
  messageId: string;
  content: string;
  messagePatch?: Record<string, unknown>;
  eventPatch?: Record<string, unknown>;
}) {
  return {
    message: {
      id: params.messageId,
      content: params.content,
      channelId: "c1",
      timestamp: new Date().toISOString(),
      type: MessageType.Default,
      attachments: [],
      embeds: [],
      mentionedEveryone: false,
      mentionedUsers: [],
      mentionedRoles: [],
      author: { id: "u1", bot: false, username: "Ada" },
      ...params.messagePatch,
    },
    author: { id: "u1", bot: false, username: "Ada" },
    member: { nickname: "Ada" },
    guild: { id: "g1", name: "Guild" },
    guild_id: "g1",
    ...params.eventPatch,
  };
}

function createThreadChannel(params: { includeStarter?: boolean } = {}) {
  return {
    type: ChannelType.GuildText,
    name: "thread-name",
    parentId: "p1",
    parent: { id: "p1", name: "general" },
    isThread: () => true,
    ...(params.includeStarter
      ? {
          fetchStarterMessage: async () => ({
            content: "starter message",
            author: { tag: "Alice#1", username: "Alice" },
            createdTimestamp: Date.now(),
          }),
        }
      : {}),
  };
}

function createThreadClient(
  params: {
    fetchChannel?: ReturnType<typeof vi.fn>;
    restGet?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    fetchChannel:
      params.fetchChannel ??
      vi.fn().mockResolvedValue({
        type: ChannelType.GuildText,
        name: "thread-name",
      }),
    rest: {
      get:
        params.restGet ??
        vi.fn().mockResolvedValue({
          content: "starter message",
          author: { id: "u1", username: "Alice", discriminator: "0001" },
          timestamp: new Date().toISOString(),
        }),
    },
  } as unknown as Client;
}

function createThreadEvent(messageId: string, channel?: unknown) {
  return {
    message: {
      id: messageId,
      content: "thread reply",
      channelId: "t1",
      channel,
      timestamp: new Date().toISOString(),
      type: MessageType.Default,
      attachments: [],
      embeds: [],
      mentionedEveryone: false,
      mentionedUsers: [],
      mentionedRoles: [],
      author: { id: "u2", bot: false, username: "Bob", tag: "Bob#2" },
    },
    author: { id: "u2", bot: false, username: "Bob", tag: "Bob#2" },
    member: { displayName: "Bob" },
    guild: { id: "g1", name: "Guild" },
    guild_id: "g1",
  };
}

describe("discord tool result dispatch", () => {
  it(
    "accepts guild messages when mentionPatterns match",
    async () => {
      const cfg = createMentionRequiredGuildConfig({
        messages: {
          responsePrefix: "PFX",
          groupChat: { mentionPatterns: ["\\bopenclaw\\b"] },
        },
      });

      const handler = await createHandler(cfg);
      const client = createGuildTextClient();

      await handler(
        createGuildMessageEvent({ messageId: "m2", content: "openclaw: hello" }),
        client,
      );

      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(sendMock).toHaveBeenCalledTimes(1);
    },
    MENTION_PATTERNS_TEST_TIMEOUT_MS,
  );

  it(
    "skips tool results for native slash commands",
    { timeout: MENTION_PATTERNS_TEST_TIMEOUT_MS },
    async () => {
      const cfg = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            humanDelay: { mode: "off" },
            workspace: "/tmp/openclaw",
          },
        },
        session: { store: "/tmp/openclaw-sessions.json" },
        channels: {
          discord: { dm: { enabled: true, policy: "open" } },
        },
      } as ReturnType<typeof import("../config/config.js").loadConfig>;

      const command = createDiscordNativeCommand({
        command: {
          name: "verbose",
          description: "Toggle verbose mode.",
          acceptsArgs: true,
        },
        cfg,
        discordConfig: cfg.channels!.discord!,
        accountId: "default",
        sessionPrefix: "discord:slash",
        ephemeralDefault: true,
        threadBindings: createNoopThreadBindingManager("default"),
      });

      const reply = vi.fn().mockResolvedValue(undefined);
      const followUp = vi.fn().mockResolvedValue(undefined);

      const interaction = {
        user: { id: "u1", username: "Ada", globalName: "Ada" },
        channel: { type: ChannelType.DM },
        guild: null,
        rawData: { id: "i1" },
        options: { getString: vi.fn().mockReturnValue("on") },
        reply,
        followUp,
      } as unknown as Parameters<typeof command.run>[0];

      await command.run(interaction);

      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(reply).toHaveBeenCalledTimes(1);
      expect(followUp).toHaveBeenCalledTimes(0);
      expect(reply.mock.calls[0]?.[0]?.content).toContain("final");
    },
  );

  it("accepts guild reply-to-bot messages as implicit mentions", async () => {
    const cfg = createMentionRequiredGuildConfig();

    const handler = await createHandler(cfg);
    const client = createGuildTextClient();

    await handler(
      createGuildMessageEvent({
        messageId: "m3",
        content: "following up",
        messagePatch: {
          referencedMessage: {
            id: "m2",
            channelId: "c1",
            content: "bot reply",
            timestamp: new Date().toISOString(),
            type: MessageType.Default,
            attachments: [],
            embeds: [],
            mentionedEveryone: false,
            mentionedUsers: [],
            mentionedRoles: [],
            author: { id: "bot-id", bot: true, username: "OpenClaw" },
          },
        },
        eventPatch: {
          channel: { id: "c1", type: ChannelType.GuildText },
          client,
          data: {
            id: "m3",
            content: "following up",
            channel_id: "c1",
            guild_id: "g1",
            type: MessageType.Default,
            mentions: [],
          },
        },
      }),
      client,
    );

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const payload = dispatchMock.mock.calls[0]?.[0]?.ctx as Record<string, unknown>;
    expect(payload.WasMentioned).toBe(true);
  });

  it("forks thread sessions and injects starter context", async () => {
    const getCapturedCtx = captureNextDispatchCtx<{
      SessionKey?: string;
      ParentSessionKey?: string;
      ThreadStarterBody?: string;
      ThreadLabel?: string;
    }>();
    const cfg = createDefaultThreadConfig();
    const handler = await createHandler(cfg);
    const threadChannel = createThreadChannel({ includeStarter: true });
    const client = createThreadClient();
    await handler(createThreadEvent("m4", threadChannel), client);

    const capturedCtx = getCapturedCtx();
    expect(capturedCtx?.SessionKey).toBe("agent:main:discord:channel:t1");
    expect(capturedCtx?.ParentSessionKey).toBe("agent:main:discord:channel:p1");
    expect(capturedCtx?.ThreadStarterBody).toContain("starter message");
    expect(capturedCtx?.ThreadLabel).toContain("Discord thread #general");
  });

  it("skips thread starter context when disabled", async () => {
    const getCapturedCtx = captureNextDispatchCtx<{ ThreadStarterBody?: string }>();
    const cfg = {
      ...createDefaultThreadConfig(),
      channels: {
        discord: {
          dm: { enabled: true, policy: "open" },
          groupPolicy: "open",
          guilds: {
            "*": {
              requireMention: false,
              channels: {
                "*": { includeThreadStarter: false },
              },
            },
          },
        },
      },
    } as LoadedConfig;
    const handler = await createHandler(cfg);
    const threadChannel = createThreadChannel();
    const client = createThreadClient();
    await handler(createThreadEvent("m7", threadChannel), client);

    const capturedCtx = getCapturedCtx();
    expect(capturedCtx?.ThreadStarterBody).toBeUndefined();
  });

  it("treats forum threads as distinct sessions without channel payloads", async () => {
    const getCapturedCtx = captureNextDispatchCtx<{
      SessionKey?: string;
      ParentSessionKey?: string;
      ThreadStarterBody?: string;
      ThreadLabel?: string;
    }>();

    const cfg = {
      agent: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" },
      session: { store: "/tmp/openclaw-sessions.json" },
      channels: {
        discord: {
          dm: { enabled: true, policy: "open" },
          groupPolicy: "open",
          guilds: { "*": { requireMention: false } },
        },
      },
      routing: { allowFrom: [] },
    } as ReturnType<typeof import("../config/config.js").loadConfig>;

    const handler = await createHandler(cfg);

    const fetchChannel = vi
      .fn()
      .mockResolvedValueOnce({
        type: ChannelType.PublicThread,
        name: "topic-1",
        parentId: "forum-1",
      })
      .mockResolvedValueOnce({
        type: ChannelType.GuildForum,
        name: "support",
      });
    const restGet = vi.fn().mockResolvedValue({
      content: "starter message",
      author: { id: "u1", username: "Alice", discriminator: "0001" },
      timestamp: new Date().toISOString(),
    });
    const client = createThreadClient({ fetchChannel, restGet });
    await handler(createThreadEvent("m6"), client);

    const capturedCtx = getCapturedCtx();
    expect(capturedCtx?.SessionKey).toBe("agent:main:discord:channel:t1");
    expect(capturedCtx?.ParentSessionKey).toBe("agent:main:discord:channel:forum-1");
    expect(capturedCtx?.ThreadStarterBody).toContain("starter message");
    expect(capturedCtx?.ThreadLabel).toContain("Discord thread #support");
    expect(restGet).toHaveBeenCalledWith(Routes.channelMessage("t1", "t1"));
  });

  it("scopes thread sessions to the routed agent", async () => {
    const getCapturedCtx = captureNextDispatchCtx<{
      SessionKey?: string;
      ParentSessionKey?: string;
    }>();

    const cfg = {
      ...createDefaultThreadConfig(),
      bindings: [{ agentId: "support", match: { channel: "discord", guildId: "g1" } }],
    } as LoadedConfig;
    loadConfigMock.mockReturnValue(cfg);

    const handler = await createHandler(cfg);

    const threadChannel = createThreadChannel();
    const client = createThreadClient();
    await handler(createThreadEvent("m5", threadChannel), client);

    const capturedCtx = getCapturedCtx();
    expect(capturedCtx?.SessionKey).toBe("agent:support:discord:channel:t1");
    expect(capturedCtx?.ParentSessionKey).toBe("agent:support:discord:channel:p1");
  });
});
