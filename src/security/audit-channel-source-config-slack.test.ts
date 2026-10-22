import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { stubAuditChannelPlugin } from "./audit-channel-test-helpers.js";
import { collectChannelSecurityFindingsCore } from "./audit-channel.js";

type SlashConfig = { slashCommand?: { enabled?: boolean }; allowFrom?: unknown };

function makeSlackHttpConfig(): OpenClawConfig {
  return {
    channels: {
      slack: {
        enabled: true,
        mode: "http",
        groupPolicy: "open",
        slashCommand: { enabled: true },
      },
    },
  };
}

type InspectionOverrides = Partial<{
  enabled: boolean;
  configured: boolean;
  botTokenStatus: string;
  signingSecretStatus: string;
}>;

function makeSlackInspection(channel: unknown, overrides: InspectionOverrides) {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    mode: "http",
    botTokenSource: "config",
    botTokenStatus: "configured_unavailable",
    signingSecretSource: "config",
    signingSecretStatus: "configured_unavailable",
    config: channel,
    ...overrides,
  };
}

describe("security audit channel source-config fallback slack", () => {
  it("keeps source-configured channel security findings when resolved inspection is incomplete", async () => {
    const cases: [string, InspectionOverrides, InspectionOverrides][] = [
      [
        "resolved inspection only exposes signingSecret status",
        { enabled: false },
        { botTokenStatus: "available", signingSecretStatus: "available" },
      ],
      [
        "source wins when resolved inspection is unconfigured",
        {},
        { configured: false, botTokenStatus: "available", signingSecretStatus: "missing" },
      ],
    ];

    for (const [name, source, resolved] of cases) {
      const sourceConfig = makeSlackHttpConfig();
      const findings = await collectChannelSecurityFindingsCore({
        cfg: makeSlackHttpConfig(),
        sourceConfig,
        plugins: [
          stubAuditChannelPlugin({
            id: "slack",
            label: "Slack",
            commands: { nativeCommandsAutoEnabled: false, nativeSkillsAutoEnabled: false },
            collectAuditFindings: async ({ account }) => {
              const { slashCommand, allowFrom } =
                (account as { config?: SlashConfig }).config ?? {};
              if (
                slashCommand?.enabled !== true ||
                (Array.isArray(allowFrom) && allowFrom.length > 0)
              ) {
                return [];
              }
              return [
                {
                  checkId: "channels.slack.commands.slash.no_allowlists",
                  severity: "warn",
                  title: "Slack slash commands have no allowlists",
                  detail: "test stub",
                },
              ];
            },
            inspectAccount: (cfg) =>
              makeSlackInspection(
                cfg.channels?.slack ?? {},
                cfg === sourceConfig ? source : resolved,
              ),
            resolveAccount: (cfg) => ({ config: cfg.channels?.slack ?? {} }),
            isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
          }),
        ],
      });

      expect(findings, name).toContainEqual(
        expect.objectContaining({
          checkId: "channels.slack.commands.slash.no_allowlists",
          severity: "warn",
        }),
      );
    }
  });
});
