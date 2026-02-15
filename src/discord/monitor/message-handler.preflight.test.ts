import { ChannelType } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
import { __resetDiscordChannelInfoCacheForTest } from "./message-utils.js";

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

const { preflightDiscordMessage } = await import("./message-handler.preflight.js");

describe("preflightDiscordMessage role allowlist", () => {
  beforeEach(() => {
    __resetDiscordChannelInfoCacheForTest();
  });

  it("allows role allowlist matches from raw member roles", async () => {
    const roleMention = { toString: () => "<@&123>" };
    const ctx = await preflightDiscordMessage({
      cfg: {},
      discordConfig: {},
      accountId: "default",
      token: "token",
      runtime: { log: () => {}, error: () => {} },
      guildHistories: new Map(),
      historyLimit: 0,
      mediaMaxBytes: 1024,
      textLimit: 4000,
      replyToMode: "off",
      ackReactionScope: "direct",
      groupPolicy: "open",
      dmEnabled: true,
      groupDmEnabled: true,
      guildEntries: {
        g1: {
          roles: ["123"],
          requireMention: false,
        },
      },
      data: {
        guild_id: "g1",
        guild: { id: "g1", name: "Guild" },
        member: { roles: [roleMention], nickname: "Alice" },
        rawMember: { roles: ["123"] },
        author: {
          id: "u1",
          username: "alice",
          discriminator: "0",
          globalName: "Alice",
          bot: false,
        },
        message: {
          id: "m1",
          channelId: "c1",
          content: "hello",
          attachments: [],
          embeds: [],
          timestamp: new Date().toISOString(),
          mentionedUsers: [],
          mentionedRoles: [],
          mentionedEveryone: false,
        },
      },
      client: {
        fetchChannel: async () => ({ type: ChannelType.GuildText, name: "general" }),
        rest: {},
      },
    } as unknown as DiscordMessagePreflightParams);

    expect(ctx).not.toBeNull();
  });
});
