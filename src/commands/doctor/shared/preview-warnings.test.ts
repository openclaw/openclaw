import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import type { ToolPolicyConfig } from "../../../config/types.tools.js";
import { collectDoctorPreviewNotes } from "./preview-warnings.js";

async function collectDoctorPreviewWarnings(cfg: unknown): Promise<string[]> {
  return (await previewNotes({ cfg })).warningNotes;
}

function previewNotes(
  params: Omit<Parameters<typeof collectDoctorPreviewNotes>[0], "doctorFixCommand">,
) {
  return collectDoctorPreviewNotes({ doctorFixCommand: "openclaw doctor --fix", ...params });
}

function warningCollector(text: string) {
  return async (cfg: unknown) =>
    (await collectDoctorPreviewWarnings(cfg)).filter((warning) => warning.includes(text));
}

const profileWarnings = warningCollector("is configured, but configured sections");
const visibleReplyWarnings = warningCollector("visibleReplies is set");
const channelMessageWarnings = warningCollector("is routed from channel");

function messagePolicyConfig(providerPolicy: ToolPolicyConfig): OpenClawConfig {
  return {
    agents: { defaults: { model: { primary: "openai/gpt-5.5" } }, entries: { main: {} } },
    channels: { discord: {} },
    messages: { groupChat: { visibleReplies: "message_tool" } },
    tools: { profile: "coding", byProvider: { openai: providerPolicy } },
  };
}

type TestManifestRecord = {
  id: string;
  channels: string[];
  origin?: "bundled" | "global";
};

const manifestState = vi.hoisted(() => ({ plugins: [] as TestManifestRecord[] }));

const repairMergedGatewayOwnerProfile = vi.hoisted(() => vi.fn());

vi.mock("../../../state/user-profiles-owner-migration.js", () => ({
  repairMergedGatewayOwnerProfile,
}));

const commandSecretState = vi.hoisted(() => ({
  targetIds: new Set<string>(),
  resolvedConfig: undefined as OpenClawConfig | undefined,
  diagnostics: [] as string[],
}));

const tempRoots = new Set<string>();

vi.mock("../../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: vi.fn(async (params: { config: OpenClawConfig }) => ({
    resolvedConfig: commandSecretState.resolvedConfig ?? params.config,
    diagnostics: commandSecretState.diagnostics,
    targetStatesByPath: {},
    hadUnresolvedTargets: false,
  })),
}));

vi.mock("../../../cli/command-secret-targets.js", () => ({
  getConfiguredChannelsCommandSecretTargetIds: vi.fn(() => commandSecretState.targetIds),
}));

vi.mock("../channel-capabilities.js", () => {
  const fallback = {
    dmAllowFromMode: "topOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: true,
    warnOnEmptyGroupSenderAllowlist: true,
  };
  return {
    getDoctorChannelCapabilities: () => fallback,
    resolveDoctorChannelAccountIds: () => undefined,
  };
});

vi.mock("./channel-doctor.js", () => ({
  collectChannelDoctorPreviewWarnings: vi.fn(
    async ({ cfg }: { cfg: { channels?: Record<string, unknown> } }) => {
      const telegram = cfg.channels?.telegram as { allowFrom?: unknown } | undefined;
      const usernames = Array.isArray(telegram?.allowFrom)
        ? telegram.allowFrom.filter(
            (entry): entry is string => typeof entry === "string" && entry.startsWith("@"),
          )
        : [];
      if (usernames.length === 0) {
        return [];
      }
      return [
        `- Telegram allowFrom contains ${usernames.length} username entr${
          usernames.length === 1 ? "y" : "ies"
        } (e.g. ${usernames[0]}).`,
      ];
    },
  ),
  createChannelDoctorEmptyAllowlistPolicyHooks: vi.fn(() => ({
    extraWarningsForAccount: () => [],
    shouldSkipDefaultEmptyGroupAllowlistWarning: () => false,
  })),
  shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning: vi.fn(() => false),
}));

vi.mock("./channel-plugin-blockers.js", () => ({
  scanConfiguredChannelPluginBlockers: (
    cfg: OpenClawConfig,
    env: NodeJS.ProcessEnv = process.env,
    activationSourceConfig = cfg,
  ) => {
    const configuredChannels = new Set(Object.keys(cfg.channels ?? {}));
    if (Object.keys(env).some((key) => key.startsWith("TELEGRAM_"))) {
      configuredChannels.add("telegram");
    }
    if (Object.keys(env).some((key) => key.startsWith("DISCORD_"))) {
      configuredChannels.add("discord");
    }
    const hits: Array<{
      channelId: string;
      pluginId: string;
      reason: string;
      channelAvailable?: boolean;
    }> = manifestState.plugins.flatMap((plugin) => {
      const sourcePlugins = activationSourceConfig.plugins;
      const disabledByEntry = sourcePlugins?.entries?.[plugin.id]?.enabled === false;
      const pluginsDisabled = sourcePlugins?.enabled === false;
      const isExternal = plugin.origin === "global";
      const omittedFromAllowlist =
        isExternal &&
        (sourcePlugins?.allow ?? []).length > 0 &&
        !(sourcePlugins?.allow ?? []).includes(plugin.id);
      const missingExplicitTrust =
        isExternal &&
        sourcePlugins?.entries?.[plugin.id]?.enabled !== true &&
        !(sourcePlugins?.allow ?? []).includes(plugin.id);
      if (!disabledByEntry && !pluginsDisabled && !omittedFromAllowlist && !missingExplicitTrust) {
        return [];
      }
      return plugin.channels
        .filter((channelId) => configuredChannels.has(channelId))
        .map((channelId) => ({
          channelId,
          pluginId: plugin.id,
          reason: disabledByEntry
            ? "disabled in config"
            : pluginsDisabled
              ? "plugins disabled"
              : omittedFromAllowlist
                ? "not in allowlist"
                : "missing explicit enablement",
        }));
    });
    const blockedPluginIds = new Set(hits.map((hit) => hit.pluginId));
    const availableChannelIds = new Set(
      manifestState.plugins
        .filter((plugin) => !blockedPluginIds.has(plugin.id))
        .flatMap((plugin) =>
          plugin.channels.filter((channelId) => configuredChannels.has(channelId)),
        ),
    );
    for (const hit of hits) {
      if (availableChannelIds.has(hit.channelId)) {
        hit.channelAvailable = true;
      }
    }
    return hits;
  },
  collectConfiguredChannelPluginBlockerWarnings: (
    hits: Array<{ channelId: string; pluginId: string; reason: string }>,
  ) =>
    hits.map((hit) => {
      const reason =
        hit.reason === "disabled in config"
          ? `plugin "${hit.pluginId}" is disabled by plugins.entries.${hit.pluginId}.enabled=false.`
          : hit.reason === "plugins disabled"
            ? "plugins.enabled=false blocks channel plugins globally."
            : hit.reason === "not in allowlist"
              ? `external plugin "${hit.pluginId}" is installed but omitted from plugins.allow. Include "${hit.pluginId}" in plugins.allow.`
              : `external plugin "${hit.pluginId}" is installed without explicit trust. Add plugins.entries.${hit.pluginId}.enabled=true.`;
      return `- channels.${hit.channelId}: channel is configured, but ${reason}`;
    }),
  isWarningBlockedByChannelPlugin: (
    warning: string,
    hits: Array<{ channelId: string; channelAvailable?: boolean }>,
  ) =>
    hits.some(
      (hit) =>
        !hit.channelAvailable &&
        (warning.includes(`channels.${hit.channelId}:`) ||
          warning.includes(`channels.${hit.channelId}.`)),
    ),
}));

vi.mock("./stale-plugin-config.js", () => ({
  scanStalePluginConfig: (cfg: OpenClawConfig) => {
    const knownIds = new Set(manifestState.plugins.map((plugin) => plugin.id));
    const hits = [
      ...(cfg.plugins?.allow ?? []).map((id) => ({ id, surface: "allow" })),
      ...Object.keys(cfg.plugins?.entries ?? {}).map((id) => ({ id, surface: "entries" })),
    ].filter((hit) => !knownIds.has(hit.id));
    if (cfg.channels?.["openclaw-weixin"]) {
      hits.push({ id: "openclaw-weixin", surface: "channel" });
    }
    return hits.filter(
      (hit, index) =>
        hits.findIndex(
          (candidate) => candidate.id === hit.id && candidate.surface === hit.surface,
        ) === index,
    );
  },
  isStalePluginAutoRepairBlocked: () => false,
  collectStalePluginConfigWarnings: ({
    autoRepairBlocked,
    doctorFixCommand,
    hits,
    surfacePreservePluginIds,
  }: {
    autoRepairBlocked: boolean;
    doctorFixCommand: string;
    hits: Array<{ id: string; surface: string }>;
    surfacePreservePluginIds?: Record<string, ReadonlySet<string>>;
  }) => {
    const actionableHits = hits.filter(
      (hit) => !surfacePreservePluginIds?.[hit.surface]?.has(hit.id),
    );
    if (actionableHits.length === 0) {
      return [];
    }
    const pluginIds = actionableHits
      .filter((hit) => hit.surface !== "channel")
      .map((hit) => hit.id)
      .toSorted();
    const lines = [
      pluginIds.length > 0
        ? `Stale plugin references (plugins.allow/deny/entries): ${pluginIds.join(", ")}.`
        : null,
      ...actionableHits
        .filter((hit) => hit.surface === "channel")
        .map((hit) => `channels.${hit.id}: dangling channel config.`),
      autoRepairBlocked
        ? `Auto-removal is paused; rerun "${doctorFixCommand}".`
        : `Run "${doctorFixCommand}".`,
    ];
    return lines.filter((line): line is string => line !== null);
  },
}));

// mock-isolation: Script warning output without reading host auth stores.
vi.mock("./stale-oauth-profile-shadows.js", () => ({
  scanStaleOAuthProfileShadows: () => ({ hits: [], warnings: [] }),
  collectStaleOAuthProfileShadowWarnings: () => [],
}));

vi.mock("./stale-auth-order.js", () => ({
  collectStaleConfiguredAuthOrderWarnings: () => [],
}));

vi.mock("./codex-route-warnings.js", () => ({
  collectCodexRouteWarnings: vi.fn(() => []),
}));

async function useRealCodexRouteWarningsOnce(): Promise<void> {
  const mocked = await import("./codex-route-warnings.js");
  const actual = await vi.importActual<typeof import("./codex-route-warnings.js")>(
    "./codex-route-warnings.js",
  );
  vi.mocked(mocked.collectCodexRouteWarnings).mockImplementationOnce(
    actual.collectCodexRouteWarnings,
  );
}

vi.mock("./context-engine-host-compat.js", () => ({
  collectContextEngineHostCompatibilityWarnings: vi.fn(async () => []),
}));

function manifest(id: string, channels: string[] = [], origin?: "global"): TestManifestRecord {
  return { id, channels, origin };
}

function expectSingleWarningContaining(warnings: string[], text: string): string {
  expect(warnings).toHaveLength(1);
  const warning = warnings[0];
  expect(warning).toContain(text);
  return expectDefined(warning, "warning test invariant");
}

function expectWarningsContaining(warnings: string[], texts: string[]): void {
  expect(warnings).toHaveLength(texts.length);
  texts.forEach((text, index) => {
    expect(warnings[index]).toContain(text);
  });
}

describe("doctor preview warnings", () => {
  beforeEach(() => {
    manifestState.plugins = [manifest("discord")];
    repairMergedGatewayOwnerProfile
      .mockReset()
      .mockReturnValue({ repaired: false, changes: [], warnings: [] });
    commandSecretState.targetIds = new Set<string>();
    commandSecretState.resolvedConfig = undefined;
    commandSecretState.diagnostics = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const root of tempRoots) {
      await fs.rm(root, { recursive: true, force: true });
    }
    tempRoots.clear();
  });

  it("reports merged gateway owner profiles without applying the repair", async () => {
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-doctor-preview" };
    const warning = 'Gateway owner profile is merged. Run "openclaw doctor --fix" to repair it.';
    repairMergedGatewayOwnerProfile.mockReturnValue({
      repaired: false,
      changes: [],
      warnings: [warning],
    });

    const notes = await previewNotes({ cfg: {}, env });

    expect(repairMergedGatewayOwnerProfile).toHaveBeenCalledWith({ env, shouldRepair: false });
    expect(notes.warningNotes).toContain(warning);
    expect(notes.infoNotes).toEqual([]);
  });

  it("routes personal Codex asset notices to info instead of warnings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-preview-codex-assets-"));
    tempRoots.add(root);
    const codexHome = path.join(root, ".codex");
    await fs.mkdir(path.join(root, ".agents", "skills", "agent-helper"), { recursive: true });
    await fs.writeFile(path.join(root, ".agents", "skills", "agent-helper", "SKILL.md"), "");

    const notes = await previewNotes({
      cfg: {
        plugins: { entries: { codex: { enabled: true } } },
        agents: { defaults: { agentRuntime: { id: "codex" } } },
      } satisfies OpenClawConfigWithLegacyRoster,
      env: { CODEX_HOME: codexHome, HOME: root },
    });

    expect(notes.infoNotes.join("\n")).toContain("Personal Codex CLI assets found");
    expect(notes.warningNotes.join("\n")).not.toContain("Personal Codex CLI assets found");
  });

  it("collects provider and shared preview warnings", async () => {
    const channelDoctor = await import("./channel-doctor.js");
    vi.mocked(channelDoctor.createChannelDoctorEmptyAllowlistPolicyHooks).mockReturnValueOnce({
      extraWarningsForAccount: ({ prefix }) => [`extra:${prefix}`],
      shouldSkipDefaultEmptyGroupAllowlistWarning: () => false,
    });
    const warnings = await collectDoctorPreviewWarnings({
      channels: { telegram: { allowFrom: ["@alice"] }, signal: { dmPolicy: "open" } },
    });

    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Telegram allowFrom contains 1.*\(e\.g\. @alice\)/),
        expect.stringContaining('channels.signal.allowFrom: set to ["*"]'),
      ]),
    );
    expect(warnings.join("\n")).toContain("extra:channels.telegram");
    expect(warnings.join("\n")).toContain("extra:channels.signal");
  });

  it("resolves configured channel SecretRefs before collecting channel preview warnings", async () => {
    const rawConfig = {
      channels: {
        telegram: { botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" } },
      },
    } satisfies OpenClawConfig;
    commandSecretState.resolvedConfig = {
      channels: { telegram: { botToken: "resolved-token", allowFrom: ["@alice"] } },
    };
    commandSecretState.targetIds = new Set(["channels.telegram.botToken"]);
    commandSecretState.diagnostics = [
      "doctor preview: gateway secrets.resolve unavailable (gateway closed); resolved command secrets locally.",
    ];

    const { resolveCommandSecretRefsViaGateway } =
      await import("../../../cli/command-secret-gateway.js");
    const notes = await previewNotes({ cfg: rawConfig, env: {} });

    expect(resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith({
      config: rawConfig,
      commandName: "doctor preview",
      targetIds: commandSecretState.targetIds,
      mode: "read_only_status",
      allowLocalExecSecretRefs: false,
      scrubUnresolvedSecretRefs: false,
    });
    expect(notes.warningNotes).toContain(commandSecretState.diagnostics[0]);
    expect(notes.warningNotes).toContainEqual(
      expect.stringMatching(/Telegram allowFrom contains 1.*\(e\.g\. @alice\)/),
    );
  });

  it("allows doctor preview to opt into local exec SecretRef resolution", async () => {
    commandSecretState.targetIds = new Set(["channels.telegram.botToken"]);
    const { resolveCommandSecretRefsViaGateway } =
      await import("../../../cli/command-secret-gateway.js");

    await previewNotes({
      cfg: {
        channels: {
          telegram: {
            botToken: { source: "exec", provider: "default", id: "telegram/bot-token" },
          },
        },
      },
      env: {},
      allowExec: true,
    });

    expect(resolveCommandSecretRefsViaGateway).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowLocalExecSecretRefs: true, scrubUnresolvedSecretRefs: false }),
    );
  });

  it("warns when a normalized legacy Codex provider cannot be auto-merged", async () => {
    await useRealCodexRouteWarningsOnce();
    const warnings = await collectDoctorPreviewWarnings({
      models: {
        providers: {
          openai: {
            api: "openai-chatgpt-responses",
            baseUrl: "https://api.openai.com/v1",
            params: { store: true },
            models: [{ id: "text-embedding-3-small" }],
          },
          "openai-codex": {
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api",
            models: [{ id: "gpt-5.5", api: "openai-chatgpt-responses" }],
          },
        },
      },
    });

    const warning = expectSingleWarningContaining(
      warnings,
      "models.providers.openai-codex cannot be merged automatically",
    );
    expect(warning).toContain("models.providers.openai.params");
    expect(warning).toContain("remove the legacy provider entry");
  });

  it("sanitizes empty-allowlist warning paths before returning preview output", async () => {
    const warnings = await collectDoctorPreviewWarnings({
      channels: {
        signal: {
          accounts: { "ops\u001B[31m-team\u001B[0m\r\nnext": { dmPolicy: "allowlist" } },
        },
      },
    });

    const warning = expectSingleWarningContaining(
      warnings,
      "channels.signal.accounts.ops-teamnext.dmPolicy",
    );
    expect(warning).not.toContain("\u001B");
    expect(warning).not.toContain("\r");
  });

  it("includes stale channel config warnings without plugin config", async () => {
    const warnings = await collectDoctorPreviewWarnings({
      channels: { "openclaw-weixin": { enabled: true } },
    });

    expectSingleWarningContaining(warnings, "channels.openclaw-weixin: dangling channel config");
  });

  it("warns when a configured external channel plugin is omitted from plugins.allow", async () => {
    manifestState.plugins = [
      manifest("discord", ["discord"], "global"),
      manifest("brave", ["brave"]),
    ];

    const warnings = await collectDoctorPreviewWarnings({
      plugins: { allow: ["brave"] },
      channels: {
        discord: {
          enabled: true,
          token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
        },
      },
    });

    const warning = expectSingleWarningContaining(
      warnings,
      'channels.discord: channel is configured, but external plugin "discord" is installed but omitted from plugins.allow.',
    );
    expect(warning).toContain('Include "discord" in plugins.allow');
    expect(warning).not.toContain("first-time setup mode");
  });

  it("warns when channel plugins are blocked globally", async () => {
    manifestState.plugins = [manifest("telegram", ["telegram"])];

    const warnings = await collectDoctorPreviewWarnings({
      channels: { telegram: { botToken: "123:abc", groupPolicy: "allowlist" } },
      plugins: { enabled: false },
    });

    const warning = expectSingleWarningContaining(
      warnings,
      "channels.telegram: channel is configured, but plugins.enabled=false blocks channel plugins globally.",
    );
    expect(warning).not.toContain("first-time setup mode");
  });

  it("uses list agent paths for restrictive tool profile advice", async () => {
    const warnings = await profileWarnings({
      tools: { profile: "messaging" },
      agents: {
        list: [{ id: "sage", tools: { allow: ["message"], exec: { mode: "allowlist" } } }],
      },
    });

    const warning = expectSingleWarningContaining(warnings, "agents.list[0].tools.profile");
    expect(warning).toContain("Add these grants to agents.list[0].tools.allow");
    expect(warning).toContain('set agents.list[0].tools.profile to "full"');
    expect(warning).not.toContain("agents.list[0].tools.alsoAllow");
    expect(warning).not.toContain("agents.entries");
  });

  it("uses keyed agent paths for inherited provider profile advice", async () => {
    const warnings = await profileWarnings({
      tools: { byProvider: { openai: { profile: "messaging" } } },
      agents: { entries: { main: {}, sage: { tools: { exec: { mode: "allowlist" } } } } },
    });

    const warning = expectSingleWarningContaining(
      warnings,
      'tools.byProvider.openai.profile is "messaging"',
    );
    expect(warning).toContain("agents.entries.sage.tools.exec is configured");
    expect(warning).toContain(
      'agents.entries.sage.tools.byProvider.openai.alsoAllow: ["exec", "process"]',
    );
    expect(warning).not.toContain("agents.list");
  });

  it.each([
    {
      scope: "inherited provider alsoAllow for agent provider profiles",
      tools: { byProvider: { openai: { alsoAllow: ["exec", "process"] } } },
      agents: {
        entries: {
          sage: {
            tools: {
              exec: { mode: "allowlist" },
              byProvider: { "openai/gpt-5": { profile: "messaging" } },
            },
          },
        },
      },
    },
    {
      scope: "model-scoped agent overrides for inherited provider profiles",
      tools: { byProvider: { openai: { profile: "messaging" } } },
      agents: {
        entries: {
          sage: {
            model: { primary: "openai/gpt-5" },
            tools: {
              exec: { mode: "allowlist" },
              byProvider: { "openai/gpt-5": { alsoAllow: ["exec", "process"] } },
            },
          },
        },
      },
    },
  ])("uses $scope", async ({ tools, agents }) => {
    expect(await profileWarnings({ tools, agents })).toStrictEqual([]);
  });

  it("does not warn for configured tool sections when the profile id is unknown", async () => {
    const warnings = await profileWarnings({
      tools: {
        profile: "custom-profile",
        exec: { mode: "allowlist" },
        byProvider: { openai: { profile: "custom-provider-profile" } },
      },
      agents: {
        list: [
          {
            id: "sage",
            tools: {
              exec: { mode: "allowlist" },
              byProvider: { openai: { profile: "custom-agent-provider-profile" } },
            },
          },
        ],
      },
    });

    expect(warnings).toStrictEqual([]);
  });

  it("still warns when provider policy blocks the runtime message grant", async () => {
    const cfg = messagePolicyConfig({ allow: ["read"] });

    expectWarningsContaining(await visibleReplyWarnings(cfg), [
      'messages.groupChat.visibleReplies is set to "message_tool"',
    ]);
    expect(await channelMessageWarnings(cfg)).toEqual([
      '- Agent "main" is routed from channel "discord", but the message tool is unavailable for that agent; explicit channel actions such as sendAttachment, upload-file, thread-reply, or reply can fail. Add "message" to the agent tool allowlist, add "group:messaging", or switch the agent to a profile that includes messaging tools.',
    ]);
  });

  it("keeps provider-specific message grants when checking provider policy", async () => {
    const cfg = messagePolicyConfig({ alsoAllow: ["message"] });

    expect(await visibleReplyWarnings(cfg)).toStrictEqual([]);
    expect(await channelMessageWarnings(cfg)).toStrictEqual([]);
  });

  it("warns separately for explicit global and group visible reply policy mismatches", async () => {
    const warnings = await visibleReplyWarnings({
      messages: { visibleReplies: "message_tool", groupChat: { visibleReplies: "message_tool" } },
      tools: { allow: ["read"] },
    });

    expectWarningsContaining(warnings, [
      'messages.groupChat.visibleReplies is set to "message_tool"',
      'messages.visibleReplies is set to "message_tool"',
    ]);
  });

  it("warns for the default agent when configured channels have no explicit routes", async () => {
    const warnings = await channelMessageWarnings({
      channels: {
        defaults: { groupPolicy: "allowlist" },
        discord: {},
        slack: { enabled: false },
        telegram: {},
      },
      tools: { allow: ["read"] },
    });

    expect(warnings).toEqual([
      '- Agent "main" is routed from channel "discord" and "telegram", but the message tool is unavailable for that agent; explicit channel actions such as sendAttachment, upload-file, thread-reply, or reply can fail. Add "message" to the agent tool allowlist, add "group:messaging", or switch the agent to a profile that includes messaging tools.',
    ]);
    expect(warnings.join("\n")).not.toContain("slack");
    expect(warnings.join("\n")).not.toContain("defaults");
  });

  it("warns for the default agent when configured account routes are incomplete", async () => {
    const warnings = await channelMessageWarnings({
      channels: { discord: { accounts: { personal: {}, work: {} } } },
      agents: {
        list: [
          { id: "main", default: true, tools: { allow: ["read"] } },
          { id: "personal-agent", tools: { profile: "messaging" } },
        ],
      },
      bindings: [
        {
          agentId: "personal-agent",
          match: { channel: "discord", accountId: "personal" },
        },
      ],
    });

    expect(warnings).toEqual([
      '- Agent "main" is routed from channel "discord", but the message tool is unavailable for that agent; explicit channel actions such as sendAttachment, upload-file, thread-reply, or reply can fail. Add "message" to the agent tool allowlist, add "group:messaging", or switch the agent to a profile that includes messaging tools.',
    ]);
    expect(warnings.join("\n")).not.toContain("personal-agent");
  });
});
