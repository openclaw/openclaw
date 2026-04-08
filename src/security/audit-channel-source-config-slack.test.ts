import { describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { collectChannelSecurityFindings } from "./audit-channel.js";

function stubSlackPlugin(params: {
  resolveAccount: (cfg: OpenClawConfig, accountId: string | null | undefined) => unknown;
  inspectAccount?: (cfg: OpenClawConfig, accountId: string | null | undefined) => unknown;
  isConfigured?: (account: unknown, cfg: OpenClawConfig) => boolean;
}): ChannelPlugin {
  return {
    id: "slack",
    meta: {
      id: "slack",
      label: "Slack",
      selectionLabel: "Slack",
      docsPath: "/docs/testing",
      blurb: "test stub",
    },
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    commands: {
      nativeCommandsAutoEnabled: false,
      nativeSkillsAutoEnabled: false,
    },
    security: {
      collectAuditFindings: async ({ account }) => {
        const config =
          (account as { config?: { slashCommand?: { enabled?: boolean }; allowFrom?: unknown } })
            .config ?? {};
        const slashCommandEnabled = config.slashCommand?.enabled === true;
        const allowFrom =
          Array.isArray(config.allowFrom) && config.allowFrom.length > 0 ? config.allowFrom : [];
        if (!slashCommandEnabled || allowFrom.length > 0) {
          return [];
        }
        return [
          {
            checkId: "channels.slack.commands.slash.no_allowlists",
            severity: "warn" as const,
            title: "Slack slash commands have no allowlists",
            detail: "test stub",
          },
        ];
      },
    },
    config: {
      listAccountIds: () => ["default"],
      inspectAccount:
        params.inspectAccount ??
        ((cfg, accountId) => {
          const resolvedAccountId =
            typeof accountId === "string" && accountId ? accountId : "default";
          const account = params.resolveAccount(cfg, resolvedAccountId) as
            | { config?: Record<string, unknown> }
            | undefined;
          return {
            accountId: resolvedAccountId,
            enabled: true,
            configured: true,
            config: account?.config ?? {},
          };
        }),
      resolveAccount: (cfg, accountId) => params.resolveAccount(cfg, accountId),
      isEnabled: () => true,
      isConfigured: (account, cfg) => params.isConfigured?.(account, cfg) ?? true,
    },
  };
}

describe("security audit channel source-config fallback slack", () => {
  it("keeps source-configured channel security findings when resolved inspection is incomplete", async () => {
    const cases = [
      {
        name: "slack resolved inspection only exposes signingSecret status",
        sourceConfig: {
          channels: {
            slack: {
              enabled: true,
              mode: "http",
              groupPolicy: "open",
              slashCommand: { enabled: true },
            },
          },
        } as OpenClawConfig,
        resolvedConfig: {
          channels: {
            slack: {
              enabled: true,
              mode: "http",
              groupPolicy: "open",
              slashCommand: { enabled: true },
            },
          },
        } as OpenClawConfig,
        plugin: (sourceConfig: OpenClawConfig) =>
          stubSlackPlugin({
            inspectAccount: (cfg) => {
              const channel = cfg.channels?.slack ?? {};
              if (cfg === sourceConfig) {
                return {
                  accountId: "default",
                  enabled: false,
                  configured: true,
                  mode: "http",
                  botTokenSource: "config",
                  botTokenStatus: "configured_unavailable",
                  signingSecretSource: "config",
                  signingSecretStatus: "configured_unavailable",
                  config: channel,
                };
              }
              return {
                accountId: "default",
                enabled: true,
                configured: true,
                mode: "http",
                botTokenSource: "config",
                botTokenStatus: "available",
                signingSecretSource: "config",
                signingSecretStatus: "available",
                config: channel,
              };
            },
            resolveAccount: (cfg) => ({ config: cfg.channels?.slack ?? {} }),
            isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
          }),
      },
      {
        name: "slack source config still wins when resolved inspection is unconfigured",
        sourceConfig: {
          channels: {
            slack: {
              enabled: true,
              mode: "http",
              groupPolicy: "open",
              slashCommand: { enabled: true },
            },
          },
        } as OpenClawConfig,
        resolvedConfig: {
          channels: {
            slack: {
              enabled: true,
              mode: "http",
              groupPolicy: "open",
              slashCommand: { enabled: true },
            },
          },
        } as OpenClawConfig,
        plugin: (sourceConfig: OpenClawConfig) =>
          stubSlackPlugin({
            inspectAccount: (cfg) => {
              const channel = cfg.channels?.slack ?? {};
              if (cfg === sourceConfig) {
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
                };
              }
              return {
                accountId: "default",
                enabled: true,
                configured: false,
                mode: "http",
                botTokenSource: "config",
                botTokenStatus: "available",
                signingSecretSource: "config",
                signingSecretStatus: "missing",
                config: channel,
              };
            },
            resolveAccount: (cfg) => ({ config: cfg.channels?.slack ?? {} }),
            isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
          }),
      },
    ] as const;

    for (const testCase of cases) {
      const findings = await collectChannelSecurityFindings({
        cfg: testCase.resolvedConfig,
        sourceConfig: testCase.sourceConfig,
        plugins: [testCase.plugin(testCase.sourceConfig)],
      });

      expect(findings, testCase.name).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "channels.slack.commands.slash.no_allowlists",
            severity: "warn",
          }),
        ]),
      );
    }
  });
});
