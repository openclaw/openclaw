import { ChannelType } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureConfiguredAcpBindingSessionMock = vi.hoisted(() => vi.fn());
const resolveConfiguredAcpBindingRecordMock = vi.hoisted(() => vi.fn());

vi.mock("../../acp/persistent-bindings.js", () => ({
  ensureConfiguredAcpBindingSession: (...args: unknown[]) =>
    ensureConfiguredAcpBindingSessionMock(...args),
  resolveConfiguredAcpBindingRecord: (...args: unknown[]) =>
    resolveConfiguredAcpBindingRecordMock(...args),
}));

import { __testing as sessionBindingTesting } from "../../infra/outbound/session-binding-service.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

const GUILD_ID = "guild-1";
const CHANNEL_ID = "channel-1";

function createConfiguredDiscordBinding() {
  return {
    spec: {
      channel: "discord",
      accountId: "default",
      conversationId: CHANNEL_ID,
      agentId: "codex",
      mode: "persistent",
    },
    record: {
      bindingId: "config:acp:discord:default:channel-1",
      targetSessionKey: "agent:codex:acp:binding:discord:default:abc123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: CHANNEL_ID,
      },
      status: "active",
      boundAt: 0,
      metadata: {
        source: "config",
        mode: "persistent",
        agentId: "codex",
      },
    },
  } as const;
}

function createBasePreflightParams(overrides?: Record<string, unknown>) {
  const message = {
    id: "m-1",
    content: "<@bot-1> hello",
    timestamp: new Date().toISOString(),
    channelId: CHANNEL_ID,
    attachments: [],
    mentionedUsers: [{ id: "bot-1" }],
    mentionedRoles: [],
    mentionedEveryone: false,
    author: {
      id: "user-1",
      bot: false,
      username: "alice",
    },
  } as unknown as import("@buape/carbon").Message;

  const client = {
    fetchChannel: async (channelId: string) => {
      if (channelId === CHANNEL_ID) {
        return {
          id: CHANNEL_ID,
          type: ChannelType.GuildText,
          name: "general",
        };
      }
      return null;
    },
  } as unknown as import("@buape/carbon").Client;

  return {
    cfg: {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    } as import("../../config/config.js").OpenClawConfig,
    discordConfig: {
      allowBots: true,
    } as NonNullable<import("../../config/config.js").OpenClawConfig["channels"]>["discord"],
    accountId: "default",
    token: "token",
    runtime: {} as import("../../runtime.js").RuntimeEnv,
    botUserId: "bot-1",
    guildHistories: new Map(),
    historyLimit: 0,
    mediaMaxBytes: 1_000_000,
    textLimit: 2_000,
    replyToMode: "all",
    dmEnabled: true,
    groupDmEnabled: true,
    ackReactionScope: "direct",
    groupPolicy: "open",
    threadBindings: createNoopThreadBindingManager("default"),
    data: {
      channel_id: CHANNEL_ID,
      guild_id: GUILD_ID,
      guild: {
        id: GUILD_ID,
        name: "Guild One",
      },
      author: message.author,
      message,
    } as unknown as import("./listeners.js").DiscordMessageEvent,
    client,
    ...overrides,
  } satisfies Parameters<typeof preflightDiscordMessage>[0];
}

describe("preflightDiscordMessage configured ACP bindings", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    ensureConfiguredAcpBindingSessionMock.mockReset();
    resolveConfiguredAcpBindingRecordMock.mockReset();
    resolveConfiguredAcpBindingRecordMock.mockReturnValue(createConfiguredDiscordBinding());
    ensureConfiguredAcpBindingSessionMock.mockResolvedValue({
      ok: true,
      sessionKey: "agent:codex:acp:binding:discord:default:abc123",
    });
  });

  it("does not initialize configured ACP bindings for rejected messages", async () => {
    const result = await preflightDiscordMessage(
      createBasePreflightParams({
        guildEntries: {
          [GUILD_ID]: {
            id: GUILD_ID,
            channels: {
              [CHANNEL_ID]: {
                allow: true,
                enabled: false,
              },
            },
          },
        },
      }),
    );

    expect(result).toBeNull();
    expect(resolveConfiguredAcpBindingRecordMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredAcpBindingSessionMock).not.toHaveBeenCalled();
  });

  it("initializes configured ACP bindings only after preflight accepts the message", async () => {
    const result = await preflightDiscordMessage(
      createBasePreflightParams({
        guildEntries: {
          [GUILD_ID]: {
            id: GUILD_ID,
            channels: {
              [CHANNEL_ID]: {
                allow: true,
                enabled: true,
                requireMention: false,
              },
            },
          },
        },
      }),
    );

    expect(result).not.toBeNull();
    expect(resolveConfiguredAcpBindingRecordMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredAcpBindingSessionMock).toHaveBeenCalledTimes(1);
    expect(result?.boundSessionKey).toBe("agent:codex:acp:binding:discord:default:abc123");
  });
});
