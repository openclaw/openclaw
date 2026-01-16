import { describe, expect, it } from "vitest";

describe("directory (config-backed)", () => {
  it("lists Slack peers/groups from config", async () => {
    const { slackPlugin } = await import("./slack.js");
    const runtime = { log: () => {}, error: () => {}, exit: () => {} } as any;
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

    const peers = await slackPlugin.directory?.listPeers?.({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
      runtime,
    });
    expect(peers?.map((e) => e.id).sort()).toEqual([
      "user:u123",
      "user:u234",
      "user:u777",
      "user:u999",
    ]);

    const groups = await slackPlugin.directory?.listGroups?.({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
      runtime,
    });
    expect(groups?.map((e) => e.id)).toEqual(["channel:c111"]);
  });

  it("lists Discord peers/groups from config (numeric ids only)", async () => {
    const { discordPlugin } = await import("./discord.js");
    const runtime = { log: () => {}, error: () => {}, exit: () => {} } as any;
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

    const peers = await discordPlugin.directory?.listPeers?.({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
      runtime,
    });
    expect(peers?.map((e) => e.id).sort()).toEqual(["user:111", "user:12345", "user:222"]);

    const groups = await discordPlugin.directory?.listGroups?.({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
      runtime,
    });
    expect(groups?.map((e) => e.id).sort()).toEqual(["channel:555", "channel:666"]);
  });

  it("lists Telegram peers/groups from config", async () => {
    const { telegramPlugin } = await import("./telegram.js");
    const runtime = { log: () => {}, error: () => {}, exit: () => {} } as any;
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

    const peers = await telegramPlugin.directory?.listPeers?.({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
      runtime,
    });
    expect(peers?.map((e) => e.id).sort()).toEqual(["123", "456", "@alice", "@bob"]);

    const groups = await telegramPlugin.directory?.listGroups?.({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
      runtime,
    });
    expect(groups?.map((e) => e.id)).toEqual(["-1001"]);
  });

  it("lists WhatsApp peers/groups from config", async () => {
    const { whatsappPlugin } = await import("./whatsapp.js");
    const runtime = { log: () => {}, error: () => {}, exit: () => {} } as any;
    const cfg = {
      channels: {
        whatsapp: {
          allowFrom: ["+15550000000", "*", "123@g.us"],
          groups: { "999@g.us": { requireMention: true }, "*": {} },
        },
      },
    } as any;

    const peers = await whatsappPlugin.directory?.listPeers?.({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
      runtime,
    });
    expect(peers?.map((e) => e.id)).toEqual(["+15550000000"]);

    const groups = await whatsappPlugin.directory?.listGroups?.({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
      runtime,
    });
    expect(groups?.map((e) => e.id)).toEqual(["999@g.us"]);
  });
});
