import { ChannelType } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

const logDebugMock = vi.hoisted(() => vi.fn());

vi.mock("../../logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logger.js")>();
  return {
    ...actual,
    logDebug: logDebugMock,
  };
});

const { preflightDiscordMessage } = await import("./message-handler.preflight.js");

describe("discord preflight allowlist drop logging", () => {
  beforeEach(() => {
    logDebugMock.mockClear();
  });

  it("emits debug log when guild channel is blocked by allowlist", async () => {
    const author = {
      id: "user-1",
      bot: false,
      username: "alice",
    } as unknown as import("@buape/carbon").User;

    const message = {
      id: "msg-1",
      content: "hello",
      timestamp: new Date().toISOString(),
      channelId: "chan-blocked",
      attachments: [],
      mentionedUsers: [],
      mentionedRoles: [],
      mentionedEveryone: false,
      author,
    } as unknown as import("@buape/carbon").Message;

    const client = {
      fetchChannel: async (channelId: string) => ({
        id: channelId,
        type: ChannelType.GuildText,
        name: "general",
      }),
    } as unknown as import("@buape/carbon").Client;

    const result = await preflightDiscordMessage({
      cfg: {
        session: {
          mainKey: "main",
          scope: "per-sender",
        },
      } as import("../../config/config.js").OpenClawConfig,
      discordConfig: {} as NonNullable<
        import("../../config/config.js").OpenClawConfig["channels"]
      >["discord"],
      accountId: "default",
      token: "token",
      runtime: {} as import("../../runtime.js").RuntimeEnv,
      botUserId: "openclaw-bot",
      guildHistories: new Map(),
      historyLimit: 0,
      mediaMaxBytes: 1_000_000,
      textLimit: 2_000,
      replyToMode: "all",
      dmEnabled: true,
      groupDmEnabled: true,
      allowFrom: [],
      guildEntries: {
        "guild-1": {
          channels: {
            "chan-allowlisted": {
              allow: true,
            },
          },
        },
      },
      ackReactionScope: "direct",
      groupPolicy: "allowlist",
      threadBindings: createNoopThreadBindingManager("default"),
      data: {
        channel_id: "chan-blocked",
        guild_id: "guild-1",
        guild: {
          id: "guild-1",
          name: "Guild One",
        },
        author,
        message,
      } as unknown as import("./listeners.js").DiscordMessageEvent,
      client,
    });

    expect(result).toBeNull();
    expect(logDebugMock).toHaveBeenCalledWith(
      expect.stringContaining("not in guild channel allowlist"),
    );
    expect(logDebugMock).toHaveBeenCalledWith(expect.stringContaining("chan-blocked"));
  });
});
