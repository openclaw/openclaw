import { describe, expect, it } from "vitest";
import {
  resolveBlueBubblesGroupRequireMention,
  resolveBlueBubblesGroupToolPolicy,
  resolveDiscordGroupRequireMention,
  resolveDiscordGroupToolPolicy,
  resolveSlackGroupRequireMention,
  resolveSlackGroupToolPolicy,
  resolveTelegramGroupRequireMention,
  resolveTelegramGroupToolPolicy,
} from "./group-mentions.js";

const cfg = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      channels: {
        alerts: {
          requireMention: false,
          tools: { allow: ["message.send"] },
          toolsBySender: {
            "id:user:alice": { allow: ["sessions.list"] },
          },
        },
        "*": {
          requireMention: true,
          tools: { deny: ["exec"] },
        },
      },
    },
  },
  // oxlint-disable-next-line typescript/no-explicit-any
} as any;

describe("group mentions (slack)", () => {
  it("uses matched channel requireMention and wildcard fallback", () => {
    expect(resolveSlackGroupRequireMention({ cfg, groupChannel: "#alerts" })).toBe(false);
    expect(resolveSlackGroupRequireMention({ cfg, groupChannel: "#missing" })).toBe(true);
  });

  it("resolves sender override, then channel tools, then wildcard tools", () => {
    const senderOverride = resolveSlackGroupToolPolicy({
      cfg,
      groupChannel: "#alerts",
      senderId: "user:alice",
    });
    expect(senderOverride).toEqual({ allow: ["sessions.list"] });

    const channelTools = resolveSlackGroupToolPolicy({
      cfg,
      groupChannel: "#alerts",
      senderId: "user:bob",
    });
    expect(channelTools).toEqual({ allow: ["message.send"] });

    const wildcardTools = resolveSlackGroupToolPolicy({
      cfg,
      groupChannel: "#missing",
      senderId: "user:bob",
    });
    expect(wildcardTools).toEqual({ deny: ["exec"] });
  });
});

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
