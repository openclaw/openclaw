import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runSecurityAudit } from "./audit.js";

let channelSecurityContractsPromise:
  | Promise<typeof import("../../test/helpers/channels/security-audit-contract.js")>
  | undefined;

async function loadChannelSecurityContracts() {
  channelSecurityContractsPromise ??=
    import("../../test/helpers/channels/security-audit-contract.js");
  return await channelSecurityContractsPromise;
}

function createLazyChannelCollectAuditFindings(
  id: "discord" | "feishu" | "slack" | "synology-chat" | "telegram" | "zalouser",
): NonNullable<ChannelPlugin["security"]>["collectAuditFindings"] {
  return async (...args) => {
    const contracts = await loadChannelSecurityContracts();
    const handler =
      id === "discord"
        ? contracts.collectDiscordSecurityAuditFindings
        : id === "feishu"
          ? contracts.collectFeishuSecurityAuditFindings
          : id === "slack"
            ? contracts.collectSlackSecurityAuditFindings
            : id === "synology-chat"
              ? contracts.collectSynologyChatSecurityAuditFindings
              : id === "telegram"
                ? contracts.collectTelegramSecurityAuditFindings
                : contracts.collectZalouserSecurityAuditFindings;
    return await handler(...args);
  };
}

function stubChannelPlugin(params: {
  id: "discord" | "feishu" | "slack" | "synology-chat" | "telegram" | "zalouser";
  label: string;
  resolveAccount: (cfg: OpenClawConfig, accountId: string | null | undefined) => unknown;
  inspectAccount?: (cfg: OpenClawConfig, accountId: string | null | undefined) => unknown;
  listAccountIds?: (cfg: OpenClawConfig) => string[];
  isConfigured?: (account: unknown, cfg: OpenClawConfig) => boolean;
  isEnabled?: (account: unknown, cfg: OpenClawConfig) => boolean;
  collectAuditFindings?: NonNullable<ChannelPlugin["security"]>["collectAuditFindings"];
  commands?: ChannelPlugin["commands"];
}): ChannelPlugin {
  const channelConfigured = (cfg: OpenClawConfig) =>
    Boolean((cfg.channels as Record<string, unknown> | undefined)?.[params.id]);
  const defaultCollectAuditFindings =
    params.collectAuditFindings ?? createLazyChannelCollectAuditFindings(params.id);
  const defaultCommands =
    params.commands ??
    (params.id === "discord" || params.id === "telegram"
      ? {
          nativeCommandsAutoEnabled: true,
          nativeSkillsAutoEnabled: true,
        }
      : params.id === "slack"
        ? {
            nativeCommandsAutoEnabled: false,
            nativeSkillsAutoEnabled: false,
          }
        : undefined);
  return {
    id: params.id,
    meta: {
      id: params.id,
      label: params.label,
      selectionLabel: params.label,
      docsPath: "/docs/testing",
      blurb: "test stub",
    },
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    ...(defaultCommands ? { commands: defaultCommands } : {}),
    security: defaultCollectAuditFindings
      ? {
          collectAuditFindings: defaultCollectAuditFindings,
        }
      : {},
    config: {
      listAccountIds:
        params.listAccountIds ??
        ((cfg) => {
          const enabled = Boolean(
            (cfg.channels as Record<string, unknown> | undefined)?.[params.id],
          );
          return enabled ? ["default"] : [];
        }),
      inspectAccount:
        params.inspectAccount ??
        ((cfg, accountId) => {
          const resolvedAccountId =
            typeof accountId === "string" && accountId ? accountId : "default";
          let account: { config?: Record<string, unknown> } | undefined;
          try {
            account = params.resolveAccount(cfg, resolvedAccountId) as
              | { config?: Record<string, unknown> }
              | undefined;
          } catch {
            return null;
          }
          const config = account?.config ?? {};
          return {
            accountId: resolvedAccountId,
            enabled: params.isEnabled?.(account, cfg) ?? channelConfigured(cfg),
            configured: params.isConfigured?.(account, cfg) ?? channelConfigured(cfg),
            config,
          };
        }),
      resolveAccount: (cfg, accountId) => params.resolveAccount(cfg, accountId),
      isEnabled: (account, cfg) => params.isEnabled?.(account, cfg) ?? channelConfigured(cfg),
      isConfigured: (account, cfg) => params.isConfigured?.(account, cfg) ?? channelConfigured(cfg),
    },
  };
}

const discordPlugin = stubChannelPlugin({
  id: "discord",
  label: "Discord",
  listAccountIds: (cfg) => {
    const ids = Object.keys(cfg.channels?.discord?.accounts ?? {});
    return ids.length > 0 ? ids : ["default"];
  },
  resolveAccount: (cfg, accountId) => {
    const resolvedAccountId = typeof accountId === "string" && accountId ? accountId : "default";
    const base = cfg.channels?.discord ?? {};
    const account = cfg.channels?.discord?.accounts?.[resolvedAccountId] ?? {};
    return { config: { ...base, ...account } };
  },
});

const slackPlugin = stubChannelPlugin({
  id: "slack",
  label: "Slack",
  listAccountIds: (cfg) => {
    const ids = Object.keys(cfg.channels?.slack?.accounts ?? {});
    return ids.length > 0 ? ids : ["default"];
  },
  resolveAccount: (cfg, accountId) => {
    const resolvedAccountId = typeof accountId === "string" && accountId ? accountId : "default";
    const base = cfg.channels?.slack ?? {};
    const account = cfg.channels?.slack?.accounts?.[resolvedAccountId] ?? {};
    return { config: { ...base, ...account } };
  },
});

const telegramPlugin = stubChannelPlugin({
  id: "telegram",
  label: "Telegram",
  listAccountIds: (cfg) => {
    const ids = Object.keys(cfg.channels?.telegram?.accounts ?? {});
    return ids.length > 0 ? ids : ["default"];
  },
  resolveAccount: (cfg, accountId) => {
    const resolvedAccountId = typeof accountId === "string" && accountId ? accountId : "default";
    const base = cfg.channels?.telegram ?? {};
    const account = cfg.channels?.telegram?.accounts?.[resolvedAccountId] ?? {};
    return { config: { ...base, ...account } };
  },
});

const zalouserPlugin = stubChannelPlugin({
  id: "zalouser",
  label: "Zalo Personal",
  listAccountIds: (cfg) => {
    const channel = (cfg.channels as Record<string, unknown> | undefined)?.zalouser as
      | { accounts?: Record<string, unknown> }
      | undefined;
    const ids = Object.keys(channel?.accounts ?? {});
    return ids.length > 0 ? ids : ["default"];
  },
  resolveAccount: (cfg, accountId) => {
    const resolvedAccountId = typeof accountId === "string" && accountId ? accountId : "default";
    const channel = (cfg.channels as Record<string, unknown> | undefined)?.zalouser as
      | { accounts?: Record<string, unknown> }
      | undefined;
    const base = (channel ?? {}) as Record<string, unknown>;
    const account = channel?.accounts?.[resolvedAccountId] ?? {};
    return { config: { ...base, ...account } };
  },
});

const synologyChatPlugin = stubChannelPlugin({
  id: "synology-chat",
  label: "Synology Chat",
  listAccountIds: (cfg) => {
    const ids = Object.keys(cfg.channels?.["synology-chat"]?.accounts ?? {});
    return ids.length > 0 ? ids : ["default"];
  },
  inspectAccount: () => null,
  resolveAccount: (cfg, accountId) => {
    const resolvedAccountId = typeof accountId === "string" && accountId ? accountId : "default";
    const base = cfg.channels?.["synology-chat"] ?? {};
    const account = cfg.channels?.["synology-chat"]?.accounts?.[resolvedAccountId] ?? {};
    const dangerouslyAllowNameMatching =
      typeof account.dangerouslyAllowNameMatching === "boolean"
        ? account.dangerouslyAllowNameMatching
        : base.dangerouslyAllowNameMatching === true;
    return {
      accountId: resolvedAccountId,
      enabled: true,
      dangerouslyAllowNameMatching,
    };
  },
});

async function withActiveAuditChannelPlugins<T>(
  plugins: ChannelPlugin[],
  run: () => Promise<T>,
): Promise<T> {
  const previousRegistry = getActivePluginRegistry();
  const registry = createEmptyPluginRegistry();
  registry.channels = plugins.map((plugin) => ({
    pluginId: plugin.id,
    plugin,
    source: "test",
  }));
  setActivePluginRegistry(registry);
  try {
    return await run();
  } finally {
    setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
  }
}

async function runChannelSecurityAudit(
  cfg: OpenClawConfig,
  plugins: ChannelPlugin[],
): Promise<Awaited<ReturnType<typeof runSecurityAudit>>> {
  return withActiveAuditChannelPlugins(plugins, () =>
    runSecurityAudit({
      config: cfg,
      includeFilesystem: false,
      includeChannelSecurity: true,
      plugins,
    }),
  );
}

describe("security audit channel security", () => {
  let fixtureRoot = "";
  let sharedChannelSecurityStateDir = "";

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-security-audit-channel-"));
    sharedChannelSecurityStateDir = path.join(fixtureRoot, "state");
    await fs.mkdir(path.join(sharedChannelSecurityStateDir, "credentials"), {
      recursive: true,
      mode: 0o700,
    });
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  const withChannelSecurityStateDir = async (fn: (tmp: string) => Promise<void>) => {
    const credentialsDir = path.join(sharedChannelSecurityStateDir, "credentials");
    await fs.rm(credentialsDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.mkdir(credentialsDir, { recursive: true, mode: 0o700 });
    await withEnvAsync({ OPENCLAW_STATE_DIR: sharedChannelSecurityStateDir }, () =>
      fn(sharedChannelSecurityStateDir),
    );
  };

  it.each([
    {
      name: "warns when Discord allowlists contain name-based entries",
      setup: async (tmp: string) => {
        await fs.writeFile(
          path.join(tmp, "credentials", "discord-allowFrom.json"),
          JSON.stringify({ version: 1, allowFrom: ["team.owner"] }),
        );
      },
      cfg: {
        channels: {
          discord: {
            enabled: true,
            token: "t",
            allowFrom: ["Alice#1234", "<@123456789012345678>"],
            guilds: {
              "123": {
                users: ["trusted.operator"],
                channels: {
                  general: {
                    users: ["987654321098765432", "security-team"],
                  },
                },
              },
            },
          },
        },
      } satisfies OpenClawConfig,
      plugins: [discordPlugin],
      expectNameBasedSeverity: "warn",
      detailIncludes: [
        "channels.discord.allowFrom:Alice#1234",
        "channels.discord.guilds.123.users:trusted.operator",
        "channels.discord.guilds.123.channels.general.users:security-team",
        "~/.openclaw/credentials/discord-allowFrom.json:team.owner",
      ],
      detailExcludes: ["<@123456789012345678>"],
    },
    {
      name: "marks Discord name-based allowlists as break-glass when dangerous matching is enabled",
      cfg: {
        channels: {
          discord: {
            enabled: true,
            token: "t",
            dangerouslyAllowNameMatching: true,
            allowFrom: ["Alice#1234"],
          },
        },
      } satisfies OpenClawConfig,
      plugins: [discordPlugin],
      expectNameBasedSeverity: "info",
      detailIncludes: ["out-of-scope"],
      expectFindingMatch: {
        checkId: "channels.discord.allowFrom.dangerous_name_matching_enabled",
        severity: "info",
      },
    },
    {
      name: "audits non-default Discord accounts for dangerous name matching",
      cfg: {
        channels: {
          discord: {
            enabled: true,
            token: "t",
            accounts: {
              alpha: { token: "a" },
              beta: {
                token: "b",
                dangerouslyAllowNameMatching: true,
              },
            },
          },
        },
      } satisfies OpenClawConfig,
      plugins: [discordPlugin],
      expectNoNameBasedFinding: true,
      expectFindingMatch: {
        checkId: "channels.discord.allowFrom.dangerous_name_matching_enabled",
        title: expect.stringContaining("(account: beta)"),
        severity: "info",
      },
    },
    {
      name: "audits name-based allowlists on non-default Discord accounts",
      cfg: {
        channels: {
          discord: {
            enabled: true,
            token: "t",
            accounts: {
              alpha: {
                token: "a",
                allowFrom: ["123456789012345678"],
              },
              beta: {
                token: "b",
                allowFrom: ["Alice#1234"],
              },
            },
          },
        },
      } satisfies OpenClawConfig,
      plugins: [discordPlugin],
      expectNameBasedSeverity: "warn",
      detailIncludes: ["channels.discord.accounts.beta.allowFrom:Alice#1234"],
    },
    {
      name: "does not warn when Discord allowlists use ID-style entries only",
      cfg: {
        channels: {
          discord: {
            enabled: true,
            token: "t",
            allowFrom: [
              "123456789012345678",
              "<@223456789012345678>",
              "user:323456789012345678",
              "discord:423456789012345678",
              "pk:member-123",
            ],
            guilds: {
              "123": {
                users: ["523456789012345678", "<@623456789012345678>", "pk:member-456"],
                channels: {
                  general: {
                    users: ["723456789012345678", "user:823456789012345678"],
                  },
                },
              },
            },
          },
        },
      } satisfies OpenClawConfig,
      plugins: [discordPlugin],
      expectNoNameBasedFinding: true,
    },
  ])("$name", async (testCase) => {
    await withChannelSecurityStateDir(async (tmp) => {
      await testCase.setup?.(tmp);
      const res = await runChannelSecurityAudit(testCase.cfg, testCase.plugins);
      const nameBasedFinding = res.findings.find(
        (entry) => entry.checkId === "channels.discord.allowFrom.name_based_entries",
      );

      if (testCase.expectNoNameBasedFinding) {
        expect(nameBasedFinding).toBeUndefined();
      } else if (
        testCase.expectNameBasedSeverity ||
        testCase.detailIncludes?.length ||
        testCase.detailExcludes?.length
      ) {
        expect(nameBasedFinding).toBeDefined();
        if (testCase.expectNameBasedSeverity) {
          expect(nameBasedFinding?.severity).toBe(testCase.expectNameBasedSeverity);
        }
        for (const snippet of testCase.detailIncludes ?? []) {
          expect(nameBasedFinding?.detail).toContain(snippet);
        }
        for (const snippet of testCase.detailExcludes ?? []) {
          expect(nameBasedFinding?.detail).not.toContain(snippet);
        }
      }

      if (testCase.expectFindingMatch) {
        expect(res.findings).toEqual(
          expect.arrayContaining([expect.objectContaining(testCase.expectFindingMatch)]),
        );
      }
    });
  });

  it.each([
    {
      name: "audits Synology Chat base dangerous name matching",
      cfg: {
        channels: {
          "synology-chat": {
            token: "t",
            incomingUrl: "https://nas.example.com/incoming",
            dangerouslyAllowNameMatching: true,
          },
        },
      } satisfies OpenClawConfig,
      expectedMatch: {
        checkId: "channels.synology-chat.reply.dangerous_name_matching_enabled",
        severity: "info",
        title: "Synology Chat dangerous name matching is enabled",
      },
    },
    {
      name: "audits non-default Synology Chat accounts for dangerous name matching",
      cfg: {
        channels: {
          "synology-chat": {
            token: "t",
            incomingUrl: "https://nas.example.com/incoming",
            accounts: {
              alpha: {
                token: "a",
                incomingUrl: "https://nas.example.com/incoming-alpha",
              },
              beta: {
                token: "b",
                incomingUrl: "https://nas.example.com/incoming-beta",
                dangerouslyAllowNameMatching: true,
              },
            },
          },
        },
      } satisfies OpenClawConfig,
      expectedMatch: {
        checkId: "channels.synology-chat.reply.dangerous_name_matching_enabled",
        severity: "info",
        title: expect.stringContaining("(account: beta)"),
      },
    },
  ])("$name", async (testCase) => {
    await withChannelSecurityStateDir(async () => {
      const res = await runChannelSecurityAudit(testCase.cfg, [synologyChatPlugin]);
      expect(res.findings).toEqual(
        expect.arrayContaining([expect.objectContaining(testCase.expectedMatch)]),
      );
    });
  });

  it("does not treat prototype properties as explicit Discord account config paths", async () => {
    await withChannelSecurityStateDir(async () => {
      const cfg: OpenClawConfig = {
        channels: {
          discord: {
            enabled: true,
            token: "t",
            dangerouslyAllowNameMatching: true,
            allowFrom: ["Alice#1234"],
            accounts: {},
          },
        },
      };

      const pluginWithProtoDefaultAccount: ChannelPlugin = {
        ...discordPlugin,
        config: {
          ...discordPlugin.config,
          listAccountIds: () => [],
          defaultAccountId: () => "toString",
        },
      };

      const res = await withActiveAuditChannelPlugins([pluginWithProtoDefaultAccount], () =>
        runSecurityAudit({
          config: cfg,
          includeFilesystem: false,
          includeChannelSecurity: true,
          plugins: [pluginWithProtoDefaultAccount],
        }),
      );

      const dangerousMatchingFinding = res.findings.find(
        (entry) => entry.checkId === "channels.discord.allowFrom.dangerous_name_matching_enabled",
      );
      expect(dangerousMatchingFinding).toBeDefined();
      expect(dangerousMatchingFinding?.title).not.toContain("(account: toString)");

      const nameBasedFinding = res.findings.find(
        (entry) => entry.checkId === "channels.discord.allowFrom.name_based_entries",
      );
      expect(nameBasedFinding).toBeDefined();
      expect(nameBasedFinding?.detail).toContain("channels.discord.allowFrom:Alice#1234");
      expect(nameBasedFinding?.detail).not.toContain("channels.discord.accounts.toString");
    });
  });

  it.each([
    {
      name: "warns when Zalouser group routing contains mutable group entries",
      cfg: {
        channels: {
          zalouser: {
            enabled: true,
            groups: {
              "Ops Room": { allow: true },
              "group:g-123": { allow: true },
            },
          },
        },
      } satisfies OpenClawConfig,
      expectedSeverity: "warn",
      detailIncludes: ["channels.zalouser.groups:Ops Room"],
      detailExcludes: ["group:g-123"],
    },
    {
      name: "marks Zalouser mutable group routing as break-glass when dangerous matching is enabled",
      cfg: {
        channels: {
          zalouser: {
            enabled: true,
            dangerouslyAllowNameMatching: true,
            groups: {
              "Ops Room": { allow: true },
            },
          },
        },
      } satisfies OpenClawConfig,
      expectedSeverity: "info",
      detailIncludes: ["out-of-scope"],
      expectFindingMatch: {
        checkId: "channels.zalouser.allowFrom.dangerous_name_matching_enabled",
        severity: "info",
      },
    },
  ])("$name", async (testCase) => {
    await withChannelSecurityStateDir(async () => {
      const res = await runChannelSecurityAudit(testCase.cfg, [zalouserPlugin]);
      const finding = res.findings.find(
        (entry) => entry.checkId === "channels.zalouser.groups.mutable_entries",
      );

      expect(finding).toBeDefined();
      expect(finding?.severity).toBe(testCase.expectedSeverity);
      for (const snippet of testCase.detailIncludes) {
        expect(finding?.detail).toContain(snippet);
      }
      for (const snippet of testCase.detailExcludes ?? []) {
        expect(finding?.detail).not.toContain(snippet);
      }
      if (testCase.expectFindingMatch) {
        expect(res.findings).toEqual(
          expect.arrayContaining([expect.objectContaining(testCase.expectFindingMatch)]),
        );
      }
    });
  });

  it.each([
    {
      name: "flags Discord slash commands when access-group enforcement is disabled and no users allowlist exists",
      cfg: {
        commands: { useAccessGroups: false },
        channels: {
          discord: {
            enabled: true,
            token: "t",
            groupPolicy: "allowlist",
            guilds: {
              "123": {
                channels: {
                  general: { enabled: true },
                },
              },
            },
          },
        },
      } satisfies OpenClawConfig,
      plugins: [discordPlugin],
      expectedFinding: {
        checkId: "channels.discord.commands.native.unrestricted",
        severity: "critical",
      },
    },
    {
      name: "flags Slack slash commands without a channel users allowlist",
      cfg: {
        channels: {
          slack: {
            enabled: true,
            botToken: "xoxb-test",
            appToken: "xapp-test",
            groupPolicy: "open",
            slashCommand: { enabled: true },
          },
        },
      } satisfies OpenClawConfig,
      plugins: [slackPlugin],
      expectedFinding: {
        checkId: "channels.slack.commands.slash.no_allowlists",
        severity: "warn",
      },
    },
    {
      name: "flags Slack slash commands when access-group enforcement is disabled",
      cfg: {
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
      } satisfies OpenClawConfig,
      plugins: [slackPlugin],
      expectedFinding: {
        checkId: "channels.slack.commands.slash.useAccessGroups_off",
        severity: "critical",
      },
    },
    {
      name: "flags Telegram group commands without a sender allowlist",
      cfg: {
        channels: {
          telegram: {
            enabled: true,
            botToken: "t",
            groupPolicy: "allowlist",
            groups: { "-100123": {} },
          },
        },
      } satisfies OpenClawConfig,
      plugins: [telegramPlugin],
      expectedFinding: {
        checkId: "channels.telegram.groups.allowFrom.missing",
        severity: "critical",
      },
    },
    {
      name: "warns when Telegram allowFrom entries are non-numeric (legacy @username configs)",
      cfg: {
        channels: {
          telegram: {
            enabled: true,
            botToken: "t",
            groupPolicy: "allowlist",
            groupAllowFrom: ["@TrustedOperator"],
            groups: { "-100123": {} },
          },
        },
      } satisfies OpenClawConfig,
      plugins: [telegramPlugin],
      expectedFinding: {
        checkId: "channels.telegram.allowFrom.invalid_entries",
        severity: "warn",
      },
    },
  ])("$name", async (testCase) => {
    await withChannelSecurityStateDir(async () => {
      const res = await runChannelSecurityAudit(testCase.cfg, testCase.plugins);

      expect(res.findings).toEqual(
        expect.arrayContaining([expect.objectContaining(testCase.expectedFinding)]),
      );
    });
  });
});
