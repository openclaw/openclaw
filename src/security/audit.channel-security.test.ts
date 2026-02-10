import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { discordPlugin } from "../../extensions/discord/src/channel.js";
import { slackPlugin } from "../../extensions/slack/src/channel.js";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { runSecurityAudit } from "./audit.js";

async function withTempStateDir(prefix: string, fn: (tmpDir: string) => Promise<void>) {
  const prevStateDir = process.env.OPENCLAW_STATE_DIR;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  process.env.OPENCLAW_STATE_DIR = tmpDir;
  await fs.mkdir(path.join(tmpDir, "credentials"), { recursive: true, mode: 0o700 });
  try {
    await fn(tmpDir);
  } finally {
    if (prevStateDir == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = prevStateDir;
    }
  }
}

describe("security audit channel checks", () => {
  it("flags Discord native commands without a guild user allowlist", async () => {
    await withTempStateDir("openclaw-security-audit-discord-", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          discord: {
            enabled: true,
            token: "t",
            groupPolicy: "allowlist",
            guilds: {
              "123": {
                channels: {
                  general: { allow: true },
                },
              },
            },
          },
        },
      };

      const res = await runSecurityAudit({
        config: cfg,
        includeFilesystem: false,
        includeChannelSecurity: true,
        plugins: [discordPlugin],
      });

      expect(res.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "channels.discord.commands.native.no_allowlists",
            severity: "warn",
          }),
        ]),
      );
    });
  });

  it("does not flag Discord slash commands when dm.allowFrom includes a Discord snowflake id", async () => {
    await withTempStateDir("openclaw-security-audit-discord-allowfrom-snowflake-", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          discord: {
            enabled: true,
            token: "t",
            dm: { allowFrom: ["387380367612706819"] },
            groupPolicy: "allowlist",
            guilds: {
              "123": {
                channels: {
                  general: { allow: true },
                },
              },
            },
          },
        },
      };

      const res = await runSecurityAudit({
        config: cfg,
        includeFilesystem: false,
        includeChannelSecurity: true,
        plugins: [discordPlugin],
      });

      expect(res.findings).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "channels.discord.commands.native.no_allowlists",
          }),
        ]),
      );
    });
  });

  it("flags Discord slash commands when access-group enforcement is disabled and no users allowlist exists", async () => {
    await withTempStateDir("openclaw-security-audit-discord-open-", async () => {
      const cfg: OpenClawConfig = {
        commands: { useAccessGroups: false },
        channels: {
          discord: {
            enabled: true,
            token: "t",
            groupPolicy: "allowlist",
            guilds: {
              "123": {
                channels: {
                  general: { allow: true },
                },
              },
            },
          },
        },
      };

      const res = await runSecurityAudit({
        config: cfg,
        includeFilesystem: false,
        includeChannelSecurity: true,
        plugins: [discordPlugin],
      });

      expect(res.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "channels.discord.commands.native.unrestricted",
            severity: "critical",
          }),
        ]),
      );
    });
  });

  it("flags Slack slash commands without a channel users allowlist", async () => {
    await withTempStateDir("openclaw-security-audit-slack-", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          slack: {
            enabled: true,
            botToken: "xoxb-test",
            appToken: "xapp-test",
            groupPolicy: "open",
            slashCommand: { enabled: true },
          },
        },
      };

      const res = await runSecurityAudit({
        config: cfg,
        includeFilesystem: false,
        includeChannelSecurity: true,
        plugins: [slackPlugin],
      });

      expect(res.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "channels.slack.commands.slash.no_allowlists",
            severity: "warn",
          }),
        ]),
      );
    });
  });

  it("flags Slack slash commands when access-group enforcement is disabled", async () => {
    await withTempStateDir("openclaw-security-audit-slack-open-", async () => {
      const cfg: OpenClawConfig = {
        commands: { useAccessGroups: false },
        channels: {
          slack: {
            enabled: true,
            botToken: "xoxb-test",
            appToken: "xapp-test",
            groupPolicy: "open",
            slashCommand: { enabled: true },
          },
        },
      };

      const res = await runSecurityAudit({
        config: cfg,
        includeFilesystem: false,
        includeChannelSecurity: true,
        plugins: [slackPlugin],
      });

      expect(res.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "channels.slack.commands.slash.useAccessGroups_off",
            severity: "critical",
          }),
        ]),
      );
    });
  });

  it("flags Telegram group commands without a sender allowlist", async () => {
    await withTempStateDir("openclaw-security-audit-telegram-", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: {
            enabled: true,
            botToken: "t",
            groupPolicy: "allowlist",
            groups: { "-100123": {} },
          },
        },
      };

      const res = await runSecurityAudit({
        config: cfg,
        includeFilesystem: false,
        includeChannelSecurity: true,
        plugins: [telegramPlugin],
      });

      expect(res.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "channels.telegram.groups.allowFrom.missing",
            severity: "critical",
          }),
        ]),
      );
    });
  });
});
