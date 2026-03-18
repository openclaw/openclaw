import { describe, expect, it } from "vitest";
import {
  resolveBlueBubblesGroupRequireMention,
  resolveBlueBubblesGroupToolPolicy,
  resolveDiscordGroupRequireMention,
  resolveDiscordGroupToolPolicy,
  resolveLineGroupRequireMention,
  resolveLineGroupToolPolicy,
  resolveTelegramGroupRequireMention,
  resolveTelegramGroupToolPolicy,
} from "./group-mentions.js";

describe("group mentions (telegram)", () => {
  it("resolves topic-level requireMention and chat-level tools for topic ids", () => {
    const telegramCfg = {
      channels: {
        telegram: {
          botToken: "telegram-test",
          groups: {
            "-1001": {
              requireMention: true,
              tools: { allow: ["message.send"] },
              topics: {
                "77": {
                  requireMention: false,
                },
              },
            },
            "*": {
              requireMention: true,
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    expect(
      resolveTelegramGroupRequireMention({ cfg: telegramCfg, groupId: "-1001:topic:77" }),
    ).toBe(false);
    expect(resolveTelegramGroupToolPolicy({ cfg: telegramCfg, groupId: "-1001:topic:77" })).toEqual(
      {
        allow: ["message.send"],
      },
    );
  });
});

describe("group mentions (discord)", () => {
  it("prefers channel policy, then guild policy, with sender-specific overrides", () => {
    const discordCfg = {
      channels: {
        discord: {
          token: "discord-test",
          guilds: {
            guild1: {
              requireMention: false,
              tools: { allow: ["message.guild"] },
              toolsBySender: {
                "id:user:guild-admin": { allow: ["sessions.list"] },
              },
              channels: {
                "123": {
                  requireMention: true,
                  tools: { allow: ["message.channel"] },
                  toolsBySender: {
                    "id:user:channel-admin": { deny: ["exec"] },
                  },
                },
              },
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    expect(
      resolveDiscordGroupRequireMention({ cfg: discordCfg, groupSpace: "guild1", groupId: "123" }),
    ).toBe(true);
    expect(
      resolveDiscordGroupRequireMention({
        cfg: discordCfg,
        groupSpace: "guild1",
        groupId: "missing",
      }),
    ).toBe(false);
    expect(
      resolveDiscordGroupToolPolicy({
        cfg: discordCfg,
        groupSpace: "guild1",
        groupId: "123",
        senderId: "user:channel-admin",
      }),
    ).toEqual({ deny: ["exec"] });
    expect(
      resolveDiscordGroupToolPolicy({
        cfg: discordCfg,
        groupSpace: "guild1",
        groupId: "123",
        senderId: "user:someone",
      }),
    ).toEqual({ allow: ["message.channel"] });
    expect(
      resolveDiscordGroupToolPolicy({
        cfg: discordCfg,
        groupSpace: "guild1",
        groupId: "missing",
        senderId: "user:guild-admin",
      }),
    ).toEqual({ allow: ["sessions.list"] });
    expect(
      resolveDiscordGroupToolPolicy({
        cfg: discordCfg,
        groupSpace: "guild1",
        groupId: "missing",
        senderId: "user:someone",
      }),
    ).toEqual({ allow: ["message.guild"] });
  });
});

describe("group mentions (bluebubbles)", () => {
  it("uses generic channel group policy helpers", () => {
    const blueBubblesCfg = {
      channels: {
        bluebubbles: {
          groups: {
            "chat:primary": {
              requireMention: false,
              tools: { deny: ["exec"] },
            },
            "*": {
              requireMention: true,
              tools: { allow: ["message.send"] },
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    expect(
      resolveBlueBubblesGroupRequireMention({ cfg: blueBubblesCfg, groupId: "chat:primary" }),
    ).toBe(false);
    expect(
      resolveBlueBubblesGroupRequireMention({ cfg: blueBubblesCfg, groupId: "chat:other" }),
    ).toBe(true);
    expect(
      resolveBlueBubblesGroupToolPolicy({ cfg: blueBubblesCfg, groupId: "chat:primary" }),
    ).toEqual({ deny: ["exec"] });
    expect(
      resolveBlueBubblesGroupToolPolicy({ cfg: blueBubblesCfg, groupId: "chat:other" }),
    ).toEqual({
      allow: ["message.send"],
    });
  });
});

describe("group mentions (line)", () => {
  it("matches raw and prefixed LINE group keys for requireMention and tools", () => {
    const lineCfg = {
      channels: {
        line: {
          groups: {
            "room:r123": {
              requireMention: false,
              tools: { allow: ["message.send"] },
            },
            "group:g123": {
              requireMention: false,
              tools: { deny: ["exec"] },
            },
            "*": {
              requireMention: true,
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    expect(resolveLineGroupRequireMention({ cfg: lineCfg, groupId: "r123" })).toBe(false);
    expect(resolveLineGroupRequireMention({ cfg: lineCfg, groupId: "room:r123" })).toBe(false);
    expect(resolveLineGroupRequireMention({ cfg: lineCfg, groupId: "g123" })).toBe(false);
    expect(resolveLineGroupRequireMention({ cfg: lineCfg, groupId: "group:g123" })).toBe(false);
    expect(resolveLineGroupRequireMention({ cfg: lineCfg, groupId: "other" })).toBe(true);
    expect(resolveLineGroupToolPolicy({ cfg: lineCfg, groupId: "r123" })).toEqual({
      allow: ["message.send"],
    });
    expect(resolveLineGroupToolPolicy({ cfg: lineCfg, groupId: "g123" })).toEqual({
      deny: ["exec"],
    });
  });

  it("uses account-scoped prefixed LINE group config for requireMention", () => {
    const lineCfg = {
      channels: {
        line: {
          groups: {
            "*": {
              requireMention: true,
            },
          },
          accounts: {
            work: {
              groups: {
                "group:g123": {
                  requireMention: false,
                },
              },
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    expect(
      resolveLineGroupRequireMention({ cfg: lineCfg, groupId: "g123", accountId: "work" }),
    ).toBe(false);
  });
});
