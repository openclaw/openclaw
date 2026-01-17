import { describe, expect, it } from "vitest";
import {
  listDiscordDirectoryGroupsFromConfig,
  listDiscordDirectoryPeersFromConfig,
  listSlackDirectoryGroupsFromConfig,
  listSlackDirectoryPeersFromConfig,
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
  listWhatsAppDirectoryGroupsFromConfig,
  listWhatsAppDirectoryPeersFromConfig,
} from "./directory-config.js";

describe("directory (config-backed)", () => {
  it("lists Slack peers/groups from config", async () => {
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
          dm: { allowFrom: ["U123", "user:U999"] },
          dms: { U234: {} },
          channels: { C111: { users: ["U777"] } },
        },
      },
    } as any;

    const peers = await listSlackDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    expect(peers?.map((e) => e.id).sort()).toEqual([
      "user:u123",
      "user:u234",
      "user:u777",
      "user:u999",
    ]);

    const groups = await listSlackDirectoryGroupsFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    expect(groups?.map((e) => e.id)).toEqual(["channel:c111"]);
  });

  it("lists Discord peers/groups from config (numeric ids only)", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "discord-test",
          dm: { allowFrom: ["<@111>", "nope"] },
          dms: { "222": {} },
          guilds: {
            "123": {
              users: ["<@12345>", "not-an-id"],
              channels: {
                "555": {},
                "channel:666": {},
                general: {},
              },
            },
          },
        },
      },
    } as any;

    const peers = await listDiscordDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    expect(peers?.map((e) => e.id).sort()).toEqual(["user:111", "user:12345", "user:222"]);

    const groups = await listDiscordDirectoryGroupsFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    expect(groups?.map((e) => e.id).sort()).toEqual(["channel:555", "channel:666"]);
  });

  it("lists Telegram peers/groups from config", async () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "telegram-test",
          allowFrom: ["123", "alice", "tg:@bob"],
          dms: { "456": {} },
          groups: { "-1001": {}, "*": {} },
        },
      },
    } as any;

    const peers = await listTelegramDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    expect(peers?.map((e) => e.id).sort()).toEqual(["123", "456", "@alice", "@bob"]);

    const groups = await listTelegramDirectoryGroupsFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    expect(groups?.map((e) => e.id)).toEqual(["-1001"]);
  });

  it("lists WhatsApp peers/groups from config", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          allowFrom: ["+15550000000", "*", "123@g.us"],
          groups: { "999@g.us": { requireMention: true }, "*": {} },
        },
      },
    } as any;

    const peers = await listWhatsAppDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    expect(peers?.map((e) => e.id)).toEqual(["+15550000000"]);

    const groups = await listWhatsAppDirectoryGroupsFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    expect(groups?.map((e) => e.id)).toEqual(["999@g.us"]);
  });
});
