import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveNeverReply } from "./group-policy.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

type ChannelWiring = {
  channel: string;
  integrationSource: string;
  groupGuard: RegExp;
};

const CHANNEL_WIRINGS: ChannelWiring[] = [
  {
    channel: "bluebubbles",
    integrationSource: "extensions/bluebubbles/src/monitor-processing.ts",
    groupGuard: /isGroup/,
  },
  {
    channel: "discord",
    integrationSource: "extensions/discord/src/monitor/message-handler.preflight.ts",
    groupGuard: /isGroup/,
  },
  {
    channel: "googlechat",
    integrationSource: "extensions/googlechat/src/monitor.ts",
    groupGuard: /isGroup/,
  },
  {
    channel: "imessage",
    integrationSource: "extensions/imessage/src/monitor/inbound-processing.ts",
    groupGuard: /isGroup/,
  },
  {
    channel: "irc",
    integrationSource: "extensions/irc/src/inbound.ts",
    groupGuard: /isGroup|isChannel/,
  },
  {
    channel: "line",
    integrationSource: "extensions/line/src/bot-handlers.ts",
    groupGuard: /senderGroupAccess|groupPolicy|group message/,
  },
  {
    channel: "matrix",
    integrationSource: "extensions/matrix/src/matrix/monitor/handler.ts",
    groupGuard: /isRoom|isGroup/,
  },
  {
    channel: "mattermost",
    integrationSource: "extensions/mattermost/src/mattermost/monitor.ts",
    groupGuard: /kind\s*!==\s*["']direct["']|isGroup|channelType/,
  },
  {
    channel: "msteams",
    integrationSource: "extensions/msteams/src/monitor-handler/message-handler.ts",
    groupGuard: /!\s*isDirectMessage|isGroup|conversationType/,
  },
  {
    channel: "signal",
    integrationSource: "extensions/signal/src/monitor/event-handler.ts",
    groupGuard: /isGroup|groupId/,
  },
  {
    channel: "slack",
    integrationSource: "extensions/slack/src/monitor/message-handler/prepare.ts",
    groupGuard: /isGroup|channel\.is_im/,
  },
  {
    channel: "telegram",
    integrationSource: "extensions/telegram/src/bot-message-context.body.ts",
    groupGuard: /isGroup/,
  },
  {
    channel: "whatsapp",
    integrationSource: "extensions/whatsapp/src/auto-reply/monitor/group-gating.ts",
    // The whole module is the group-only gating path; the call lives inside
    // resolveWhatsappAutoReplyGroupGating which is only invoked for groups.
    groupGuard: /resolveWhatsappAutoReplyGroupGating|group message|conversationGroupPolicy/,
  },
  {
    channel: "zalo",
    integrationSource: "extensions/zalo/src/monitor.ts",
    groupGuard: /isGroup/,
  },
  {
    channel: "zalouser",
    integrationSource: "extensions/zalouser/src/monitor.ts",
    groupGuard: /isGroup/,
  },
];

describe("neverReply channel wiring contract", () => {
  describe.each(CHANNEL_WIRINGS)("$channel", ({ channel, integrationSource, groupGuard }) => {
    const sourcePath = resolve(REPO_ROOT, integrationSource);
    const source = readFileSync(sourcePath, "utf8");

    it("imports resolveNeverReply from the channel-policy SDK seam", () => {
      expect(source).toMatch(
        /(?:import\s+\{[^}]*\bresolveNeverReply\b[^}]*\}|^\s*resolveNeverReply,?$)/m,
      );
      expect(source).toMatch(/from\s+["']openclaw\/plugin-sdk\/channel-policy["']/);
    });

    it(`calls resolveNeverReply with channel: "${channel}"`, () => {
      const callPattern = new RegExp(
        `resolveNeverReply\\([^)]*channel:\\s*["']${channel}["']`,
        "s",
      );
      expect(source).toMatch(callPattern);
    });

    it("guards the resolveNeverReply call so DMs are not affected", () => {
      const callIndex = source.indexOf("resolveNeverReply(");
      expect(callIndex).toBeGreaterThan(-1);
      const surrounding = source.slice(Math.max(0, callIndex - 400), callIndex + 200);
      expect(surrounding).toMatch(groupGuard);
    });

    it("threads accountId into the resolveNeverReply call", () => {
      const callPattern = /resolveNeverReply\(([^)]*)\)/s;
      const match = source.match(callPattern);
      expect(match).not.toBeNull();
      expect(match![1]).toMatch(/accountId/);
    });
  });
});

describe("neverReply resolver precedence", () => {
  it("prefers account override over channel default", () => {
    const cfg = {
      channels: {
        telegram: {
          neverReply: false,
          accounts: { primary: { neverReply: true } },
        },
      },
    } as never;
    expect(resolveNeverReply({ cfg, channel: "telegram", accountId: "primary" })).toBe(true);
  });

  it("prefers channel value over channels.defaults", () => {
    const cfg = {
      channels: {
        defaults: { neverReply: true },
        slack: { neverReply: false },
      },
    } as never;
    expect(resolveNeverReply({ cfg, channel: "slack", accountId: "default" })).toBe(false);
  });

  it("falls back to channels.defaults", () => {
    const cfg = {
      channels: {
        defaults: { neverReply: true },
        signal: {},
      },
    } as never;
    expect(resolveNeverReply({ cfg, channel: "signal", accountId: "default" })).toBe(true);
  });

  it("returns false when nothing is configured", () => {
    const cfg = { channels: {} } as never;
    expect(resolveNeverReply({ cfg, channel: "discord", accountId: "default" })).toBe(false);
  });
});
