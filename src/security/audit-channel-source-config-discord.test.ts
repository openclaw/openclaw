// Verifies Discord channel source-config audit behavior.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { stubAuditChannelPlugin } from "./audit-channel-test-helpers.js";
import { collectChannelSecurityFindingsCore } from "./audit-channel.js";

describe("security audit channel source-config fallback discord", () => {
  it("keeps source-configured channel security findings when resolved inspection is incomplete", async () => {
    const sourceChannel = {
      enabled: true,
      groupPolicy: "allowlist",
      guilds: { "123": { channels: { general: { enabled: true } } } },
    } satisfies NonNullable<OpenClawConfig["channels"]>["discord"];
    const sourceConfig: OpenClawConfig = {
      commands: { native: true },
      channels: {
        discord: {
          ...sourceChannel,
          token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
        },
      },
    };
    const resolvedConfig: OpenClawConfig = {
      commands: { native: true },
      channels: { discord: sourceChannel },
    };

    const findings = await collectChannelSecurityFindingsCore({
      cfg: resolvedConfig,
      sourceConfig,
      plugins: [
        stubAuditChannelPlugin({
          id: "discord",
          label: "Discord",
          commands: { nativeCommandsAutoEnabled: true, nativeSkillsAutoEnabled: true },
          collectAuditFindings: ({ account }) => {
            const config = (account as { config?: { guilds?: unknown } }).config ?? {};
            const guilds =
              config.guilds && typeof config.guilds === "object" && !Array.isArray(config.guilds)
                ? config.guilds
                : {};
            return Object.keys(guilds).length === 0
              ? []
              : [
                  {
                    checkId: "channels.discord.commands.native.no_allowlists",
                    severity: "warn",
                    title: "Discord slash commands have no allowlists",
                    detail: "test stub",
                  },
                ];
          },
          inspectAccount: (cfg) => {
            const channel = cfg.channels?.discord ?? {};
            const token = channel.token;
            const configured =
              Boolean(token) &&
              typeof token === "object" &&
              !Array.isArray(token) &&
              "source" in token;
            return {
              accountId: "default",
              enabled: true,
              configured,
              token: "",
              tokenSource: configured ? "config" : "none",
              tokenStatus: configured ? "configured_unavailable" : "missing",
              config: channel,
            };
          },
          resolveAccount: (cfg) => ({ config: cfg.channels?.discord ?? {} }),
          isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
        }),
      ],
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "channels.discord.commands.native.no_allowlists",
        severity: "warn",
      }),
    );
  });
});
