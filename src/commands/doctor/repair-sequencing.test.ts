import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import {
  createPluginManifestRecordFixture,
  createPluginMetadataSnapshotFixture,
} from "../../plugins/plugin-metadata.test-support.js";
import { createAuthProfileImportResult } from "./auth-profile-repair.test-support.js";
import { mocks } from "./repair-sequencing-mocks.test-support.js";
import { runDoctorRepairSequence } from "./repair-sequencing.js";
import { registerSharedRuntimeReaderDoctorTests } from "./repair-sequencing.shared-runtime.test-support.js";

function runRepairs(
  cfg: OpenClawConfig = {},
  options: Omit<Parameters<typeof runDoctorRepairSequence>[0], "state" | "doctorFixCommand"> & {
    candidate?: OpenClawConfig;
  } = {},
) {
  const { candidate = structuredClone(cfg), ...params } = options;
  return runDoctorRepairSequence({
    state: { cfg, candidate, pendingChanges: false, fixHints: [] },
    doctorFixCommand: "openclaw doctor --fix",
    ...params,
  });
}

const mutation = (config: OpenClawConfig, ...changes: string[]) => ({ config, changes });
const unchanged = (config: OpenClawConfig) => mutation(config);
const unchangedConfig = ({ config }: { config: OpenClawConfig }) => unchanged(config);
const unchangedWithWarnings = (config: OpenClawConfig) => ({ ...unchanged(config), warnings: [] });
const configuredBrave = {
  enabled: true,
  config: {
    webSearch: { apiKey: { source: "env", provider: "default", id: "BRAVE_API_KEY" } },
  },
} satisfies NonNullable<NonNullable<OpenClawConfig["plugins"]>["entries"]>[string];

function installedPlugin(id: string, pkg: string, repaired = false) {
  return {
    changes: [`Installed missing configured plugin "${id}" from ${pkg}.`],
    warnings: [],
    ...(repaired ? { repairedPluginIds: [id], pluginInventoryChanged: true } : {}),
  };
}

function enableRepairedPlugin(id: string) {
  mocks.materializePluginAutoEnableCandidates.mockImplementationOnce(
    ({ config }: { config: OpenClawConfig }) => ({
      config: {
        ...config,
        plugins: {
          ...config.plugins,
          entries: { ...config.plugins?.entries, [id]: { enabled: true } },
        },
      },
      changes: [`${id} installed for existing configuration, enabled automatically.`],
    }),
  );
}

function mistralConfig(): OpenClawConfig {
  return {
    plugins: { allow: ["mistral"], entries: { mistral: { enabled: true } } },
    agents: { defaults: { model: { primary: "mistral/mistral-large-latest" } } },
    memory: { search: { provider: "mistral" } },
  };
}

function expectMistralPreserved(config: OpenClawConfig) {
  expect(config.plugins?.allow).toEqual(["mistral"]);
  expect(config.plugins?.entries?.mistral?.enabled).toBe(true);
  expect(config.agents?.defaults?.model).toEqual({ primary: "mistral/mistral-large-latest" });
  expect(config.memory?.search?.provider).toBe("mistral");
}

function expectPreservedPlugins(params: unknown, id: string) {
  expect(params).toEqual({
    preservePluginIds: [id],
    surfacePreservePluginIds: {
      allow: new Set(["codex"]),
      deny: new Set(["codex"]),
      entries: new Set(["codex"]),
    },
  });
}

describe("doctor repair sequencing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applyPluginAutoEnable.mockImplementation(unchangedConfig);
    mocks.materializePluginAutoEnableCandidates.mockImplementation(unchangedConfig);
    mocks.ensureAuthProfileStore.mockReturnValue({ profiles: {}, usageStats: {} });
    mocks.evaluateStoredCredentialEligibility.mockReturnValue({ eligible: true, reasonCode: "ok" });
    mocks.isInstalledPluginEnabled.mockReturnValue(false);
    mocks.loadInstalledPluginIndex.mockReturnValue({ plugins: [] });
    mocks.loadPluginMetadataSnapshot.mockReturnValue(createPluginMetadataSnapshotFixture());
    mocks.resolveConfigWidePluginMetadataSnapshot.mockReturnValue(
      createPluginMetadataSnapshotFixture(),
    );
    mocks.maybeRepairGroupAllowFromFallback.mockImplementation(unchanged);
    mocks.maybeRepairPluginOpenClawHostLinks.mockResolvedValue(false);
    mocks.migrateLegacyTailscaleProfileIdentities.mockReturnValue({ changes: [], warnings: [] });
    mocks.repairMergedGatewayOwnerProfile.mockReturnValue({
      repaired: false,
      changes: [],
      warnings: [],
    });
    mocks.collectOpenAICodexAuthProfileStoreIdMap.mockReturnValue(new Map());
    mocks.maybeMigrateAuthProfileJsonStoresToSqlite.mockResolvedValue(
      createAuthProfileImportResult(),
    );
    mocks.maybeRepairOpenAICodexAuthConfig.mockImplementation(unchangedWithWarnings);
    mocks.maybeRepairOpenPolicyAllowFrom.mockImplementation(unchanged);
    mocks.maybeRepairStaleManagedNpmBundledPlugins.mockReturnValue(null);
    mocks.maybeRepairStaleConfiguredAuthOrders.mockImplementation(
      ({ cfg }: { cfg: OpenClawConfig }) => ({ config: cfg, changes: [] }),
    );
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({ changes: [], warnings: [] });
    mocks.repairStaleAgentModelRefs.mockImplementation(unchangedWithWarnings);
    mocks.repairStaleOAuthProfileShadows.mockResolvedValue({ changes: [], warnings: [] });
    mocks.collectChannelDoctorCompatibilityMutations.mockReturnValue([]);
    mocks.resolveAuthProfileOrder.mockReturnValue([]);
    mocks.resolveProviderInstallCatalogEntries.mockReturnValue([]);
    mocks.resolveConfigWidePluginManifestRegistry.mockReturnValue({ plugins: [], diagnostics: [] });
    mocks.resolveProfileUnusableUntilForDisplay.mockReturnValue(null);
    mocks.maybeRepairStalePluginConfig.mockImplementation(unchanged);
  });

  registerSharedRuntimeReaderDoctorTests();

  it.each([
    {
      name: "Tailscale profile identity migration",
      repair: mocks.migrateLegacyTailscaleProfileIdentities,
      options: {},
    },
    {
      name: "merged gateway owner profile repair",
      repair: mocks.repairMergedGatewayOwnerProfile,
      options: { shouldRepair: true },
    },
  ])("reports the doctor-only $name", async ({ repair, options }) => {
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-doctor-test" };
    repair.mockReturnValue({
      repaired: true,
      changes: ["Repaired user profile identity."],
      warnings: ["User profile identity conflict."],
    });

    const result = await runRepairs({}, { env });

    expect(repair).toHaveBeenCalledWith({ env, ...options });
    expect(result.changeNotes).toContain("Repaired user profile identity.");
    expect(result.warningNotes).toContain("User profile identity conflict.");
    expect(result.state.pendingChanges).toBe(false);
  });

  it("sanitizes ordered plugin repair changes, warnings, notices, and migration notes", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValueOnce({
      changes: ["Installed \u001B[31mplugin\u001B[0m\r\nnext."],
      warnings: ["Plugin \u001B[31mwarning\u001B[0m\r\nnext."],
      notices: ["Plugin \u001B[31mnotice\u001B[0m\r\nnext."],
    });
    mocks.migrateLegacyTailscaleProfileIdentities.mockReturnValueOnce({
      changes: ["Migrated \u001B[31mrecommendations\u001B[0m\r\nnext."],
      warnings: ["Migration \u001B[31mwarning\u001B[0m\r\nnext."],
    });
    const result = await runRepairs();

    expect(result.changeNotes).toEqual(["Installed pluginnext.", "Migrated recommendationsnext."]);
    expect(result.warningNotes).toEqual([
      "Plugin warningnext.",
      "Plugin noticenext.",
      "Migration warningnext.",
    ]);
  });

  it("applies ordered repairs and sanitizes empty-allowlist warnings", async () => {
    const result = await runRepairs({
      channels: {
        discord: { allowFrom: [123] },
        signal: {
          accounts: {
            "ops\u001B[31m-team\u001B[0m\r\nnext": { dmPolicy: "allowlist" },
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(result.state.pendingChanges).toBe(true);
    expect(result.state.candidate.channels?.discord?.allowFrom).toEqual(["123"]);
    expect(result.changeNotes).toStrictEqual([]);
    expect(result.configChangeNotes).toStrictEqual([
      "channels.discord.allowFrom: converted 1 numeric ID to strings",
    ]);
    expect(result.warningNotes).toStrictEqual([
      "channels.signal.accounts.ops-teamnext.dmPolicy warning",
    ]);
  });

  it("applies stale configured auth-order repair", async () => {
    const cfg = {
      auth: { order: { anthropic: ["anthropic:claude-cli"] } },
    } satisfies OpenClawConfig;
    mocks.maybeRepairStaleConfiguredAuthOrders.mockReturnValueOnce(
      mutation(
        { auth: { order: {} } },
        "auth.order.anthropic: removed 1 missing profile reference to restore automatic per-agent auth selection.",
      ),
    );

    const result = await runRepairs(cfg, { candidate: cfg });

    expect(result.state.candidate.auth?.order?.anthropic).toBeUndefined();
    expect(result.authProfilesRepaired).toBe(false);
  });

  it("repairs managed npm plugin drift before missing plugin install repair", async () => {
    const config: OpenClawConfig = { plugins: { entries: { "google-meet": { enabled: true } } } };
    const events: string[] = [];
    const refreshedSnapshot = createPluginMetadataSnapshotFixture();
    mocks.loadPluginMetadataSnapshot.mockReturnValueOnce(refreshedSnapshot);
    mocks.maybeRepairStaleManagedNpmBundledPlugins.mockImplementation(() => {
      events.push("bundled-shadow-cleanup");
      return { installRecords: {}, removedPluginIds: ["google-meet"] };
    });
    mocks.maybeRepairPluginOpenClawHostLinks.mockImplementation(async () => {
      events.push("openclaw-peer-links");
      return true;
    });
    mocks.repairMissingConfiguredPluginInstalls.mockImplementation(async () => {
      events.push("missing-installs");
      return { changes: [], warnings: [], records: {} };
    });

    const result = await runRepairs(structuredClone(config));

    expect(events).toEqual(["bundled-shadow-cleanup", "openclaw-peer-links", "missing-installs"]);
    expect(mocks.maybeRepairStaleManagedNpmBundledPlugins).toHaveBeenCalledWith(
      expect.objectContaining({ config, prompter: { shouldRepair: true } }),
    );
    expect(mocks.maybeRepairPluginOpenClawHostLinks).toHaveBeenCalledWith({
      env: process.env,
      prompter: { shouldRepair: true },
    });
    expect(mocks.repairMissingConfiguredPluginInstalls).toHaveBeenCalledWith(
      expect.objectContaining({ baselineRecords: {}, repairVersionDrift: true }),
    );
    expect(result.pluginMetadataSnapshot).toMatchObject({
      manifestRegistry: refreshedSnapshot.manifestRegistry,
      plugins: [],
    });
  });

  it.each(["shadow", "import"])("repairs %s auth changes in migration order", async (changed) => {
    const events: string[] = [];
    mocks.repairStaleOAuthProfileShadows.mockImplementationOnce(async () => {
      events.push("stale-oauth-shadows");
      return {
        changes:
          changed === "shadow" ? ["Removed stale OAuth auth profile shadow openai-codex."] : [],
        warnings: [],
      };
    });
    mocks.maybeMigrateAuthProfileJsonStoresToSqlite.mockImplementationOnce(async () => {
      events.push("sqlite-migration");
      return createAuthProfileImportResult({
        detected: ["auth-profiles.json"],
        changes: changed === "import" ? ["Migrated auth profile JSON into SQLite."] : [],
        configChanged: true,
      });
    });
    mocks.maybeRepairStaleConfiguredAuthOrders.mockImplementationOnce(({ cfg }) => {
      events.push("stale-auth-order");
      return { config: cfg, changes: [] };
    });

    const result = await runRepairs();

    expect(events).toEqual(["stale-oauth-shadows", "sqlite-migration", "stale-auth-order"]);
    expect(result.changeNotes).toEqual([
      changed === "shadow"
        ? "Removed stale OAuth auth profile shadow openai-codex."
        : "Migrated auth profile JSON into SQLite.",
    ]);
    expect(result.state.pendingChanges).toBe(true);
    expect(result.warningNotes).toEqual([]);
    expect(result.authProfilesRepaired).toBe(true);
  });

  it("emits Discord warnings when unsafe numeric ids block repair", async () => {
    const result = await runRepairs({
      channels: { discord: { allowFrom: [106232522769186816] } },
    } as unknown as OpenClawConfig);

    expect(result.warningNotes).toStrictEqual([
      "channels.discord.allowFrom[0] cannot be auto-repaired because it is not a safe integer",
    ]);
    expect(result.state.pendingChanges).toBe(false);
    expect(result.state.candidate.channels?.discord?.allowFrom).toEqual([106232522769186816]);
  });

  it("auto-enables newly installed configured plugins after doctor repair", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValueOnce(
      installedPlugin("brave", "@openclaw/brave-plugin"),
    );
    mocks.applyPluginAutoEnable.mockImplementationOnce(({ config }: { config: OpenClawConfig }) =>
      mutation(
        {
          ...config,
          plugins: { allow: ["telegram", "brave"], entries: { brave: { enabled: true } } },
        },
        "brave web search provider selected, enabled automatically.",
      ),
    );

    const result = await runRepairs({
      tools: { web: { search: { provider: "brave" } } },
      plugins: { allow: ["telegram"] },
    });

    expect(result.state.pendingChanges).toBe(true);
    expect(result.state.candidate.plugins?.allow).toEqual(["telegram", "brave"]);
    expect(result.state.candidate.plugins?.entries?.brave?.enabled).toBe(true);
  });

  it("uses plugins from every agent workspace after inventory repair", async () => {
    const researchPlugin = createPluginManifestRecordFixture({
      id: "research-channel",
      source: "/srv/research/.openclaw/extensions/research-channel/openclaw.plugin.json",
      providers: [],
    });
    const manifestRegistry = { plugins: [researchPlugin], diagnostics: [] };
    mocks.resolveConfigWidePluginManifestRegistry.mockReturnValue(manifestRegistry);
    mocks.loadPluginMetadataSnapshot.mockReturnValue(createPluginMetadataSnapshotFixture());
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValueOnce({
      changes: ['Installed missing configured plugin "research-channel".'],
      warnings: [],
      pluginInventoryChanged: true,
    });

    await runRepairs({
      agents: {
        ownership: "explicit",
        entries: {
          ops: { workspace: "/srv/ops" },
          research: { workspace: "/srv/research" },
        },
      },
    });

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith(
      expect.objectContaining({ manifestRegistry }),
    );
  });

  it("installs an external provider and migrates auth before validating model references", async () => {
    let mistralInstalled = false;
    let authMigrated = false;
    mocks.maybeMigrateAuthProfileJsonStoresToSqlite.mockImplementationOnce(async () => {
      authMigrated = true;
      return createAuthProfileImportResult({});
    });
    mocks.repairMissingConfiguredPluginInstalls.mockImplementationOnce(async () => {
      mistralInstalled = true;
      return installedPlugin("mistral", "@openclaw/mistral-provider", true);
    });
    mocks.repairStaleAgentModelRefs.mockImplementationOnce((cfg: OpenClawConfig) => {
      expect(authMigrated).toBe(true);
      expect(mistralInstalled).toBe(true);
      return unchangedWithWarnings(cfg);
    });
    const config = mistralConfig();

    const result = await runRepairs(config, { candidate: config });

    expectMistralPreserved(result.state.candidate);
  });

  it("preserves external provider model references when plugin install repair fails", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValueOnce({
      changes: [],
      warnings: [
        'Failed to install missing configured plugin "mistral" from @openclaw/mistral-provider: package install failed',
      ],
      failedPluginIds: ["mistral"],
    });
    const config = mistralConfig();

    const result = await runRepairs(config, { candidate: config });

    expect(mocks.repairStaleAgentModelRefs).not.toHaveBeenCalled();
    expectMistralPreserved(result.state.candidate);
  });

  it("applies doctor contracts exposed by newly installed plugins", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValueOnce(
      installedPlugin("discord", "@openclaw/discord", true),
    );
    enableRepairedPlugin("discord");
    mocks.collectChannelDoctorCompatibilityMutations.mockImplementationOnce(
      (cfg: OpenClawConfig) => [
        {
          config: {
            ...cfg,
            channels: {
              ...cfg.channels,
              discord: {
                ...cfg.channels?.discord,
                dmPolicy: "allowlist",
                allowFrom: [123],
                dm: { enabled: true },
              },
            },
          },
          changes: [
            "Moved channels.discord.dm.policy → channels.discord.dmPolicy.",
            "Moved channels.discord.dm.allowFrom → channels.discord.allowFrom.",
          ],
        },
      ],
    );

    const result = await runRepairs({
      channels: { discord: { dm: { enabled: true, policy: "allowlist", allowFrom: [123] } } },
    } as OpenClawConfig);

    expect(mocks.collectChannelDoctorCompatibilityMutations).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: { entries: { discord: { enabled: true } } },
      }),
      { env: process.env },
    );
    expect(result.state.candidate.channels?.discord).toEqual({
      dmPolicy: "allowlist",
      allowFrom: ["123"],
      dm: { enabled: true },
    });
  });

  it("explicitly enables plugins repaired from env-only configuration", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValueOnce(
      installedPlugin("exa", "@openclaw/exa-plugin", true),
    );
    enableRepairedPlugin("exa");

    const result = await runRepairs();

    expect(mocks.materializePluginAutoEnableCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [{ pluginId: "exa", kind: "configured-plugin-repaired" }],
      }),
    );
    expect(result.state.candidate.plugins?.entries?.exa).toEqual({ enabled: true });
  });

  it("refreshes retained default-workspace metadata after cleanup-only inventory repairs", async () => {
    const workspaceDir = path.resolve("/tmp/openclaw-doctor-workspace");
    const workspaceProvider = "workspace-provider";
    const staleSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [{ id: "google-meet" }],
    });
    const configWideManifestRegistry = {
      plugins: [
        createPluginManifestRecordFixture({
          id: "workspace-plugin",
          source: path.join(
            workspaceDir,
            ".openclaw/extensions/workspace-plugin/openclaw.plugin.json",
          ),
          providers: [workspaceProvider],
        }),
      ],
      diagnostics: [],
    };
    const createRefreshedSnapshot = (includeWorkspaceProvider: boolean) =>
      createPluginMetadataSnapshotFixture({
        plugins: includeWorkspaceProvider ? configWideManifestRegistry.plugins : [],
      });
    const refreshedSnapshot = createRefreshedSnapshot(true);
    mocks.resolveConfigWidePluginManifestRegistry.mockReturnValue(configWideManifestRegistry);
    mocks.loadPluginMetadataSnapshot.mockImplementationOnce((params: { workspaceDir?: string }) =>
      params.workspaceDir === workspaceDir ? refreshedSnapshot : createRefreshedSnapshot(false),
    );
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValueOnce({
      changes: ['Removed stale managed install record for bundled plugin "google-meet".'],
      warnings: [],
      pluginInventoryChanged: true,
      records: {},
    });
    const { repairStaleAgentModelRefs: repairStaleAgentModelRefsActual } = await vi.importActual<
      typeof import("./shared/stale-agent-model-ref-repair.js")
    >("./shared/stale-agent-model-ref-repair.js");
    mocks.repairStaleAgentModelRefs.mockImplementationOnce(repairStaleAgentModelRefsActual);
    const pluginMetadataSnapshotState = {
      current: staleSnapshot,
    };
    const scopedSnapshots: Array<PluginMetadataSnapshot | undefined> = [];
    const runWithPluginMetadataSnapshot = <T>(
      _scope: { config: OpenClawConfig; workspaceDir?: string },
      run: () => T,
    ): T => {
      scopedSnapshots.push(pluginMetadataSnapshotState.current);
      return run();
    };

    const config = {
      agents: { defaults: { model: `${workspaceProvider}/model`, workspace: workspaceDir } },
    };
    const result = await runRepairs(config, {
      pluginMetadataSnapshotState,
      runWithPluginMetadataSnapshot,
    });

    const currentPluginMetadataSnapshot = pluginMetadataSnapshotState.current;
    expect(currentPluginMetadataSnapshot).toMatchObject({
      manifestRegistry: configWideManifestRegistry,
      plugins: configWideManifestRegistry.plugins,
      owners: {
        providers: new Map([[workspaceProvider, ["workspace-plugin"]]]),
      },
    });
    expect(scopedSnapshots[0]).toBe(staleSnapshot);
    expect(scopedSnapshots).toContain(currentPluginMetadataSnapshot);
    expect(result.pluginMetadataSnapshot).toBe(currentPluginMetadataSnapshot);
    expect(result.state.candidate.agents?.defaults?.model).toBe(`${workspaceProvider}/model`);
  });

  it("moves legacy Codex routes to canonical OpenAI before missing plugin install repair", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockImplementationOnce(
      async (params: { cfg: OpenClawConfig }) => {
        expect(params.cfg.agents?.defaults?.model).toBe("openai/gpt-5.5");
        expect(params.cfg.agents?.defaults).not.toHaveProperty("agentRuntime");
        return { changes: [], warnings: [] };
      },
    );

    const result = await runRepairs(
      { agents: { defaults: { model: "openai-codex/gpt-5.5" } } },
      { env: {} },
    );

    expect(result.state.pendingChanges).toBe(true);
    expect(result.state.candidate.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(result.state.candidate.agents?.defaults).not.toHaveProperty("agentRuntime");
  });

  it("repairs #94184 stale Codex model-map refs before missing plugin install repair", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockImplementationOnce(
      async (params: { cfg: OpenClawConfig }) => {
        expect(params.cfg.plugins?.entries?.codex?.enabled).toBe(true);
        expect(params.cfg.agents?.defaults?.model).toBe("openai/gpt-5.5");
        expect(params.cfg.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime).toEqual({
          id: "codex",
        });
        expect(params.cfg.agents?.defaults?.models?.["openai-codex/gpt-5.5"]).toBeUndefined();
        return {
          changes: [],
          warnings: [],
        };
      },
    );

    const staleUpgradeConfig = {
      plugins: { allow: ["openai"], entries: { codex: { enabled: true } } },
      agents: {
        defaults: {
          model: "openai-codex/gpt-5.5",
          models: {
            "openai-codex/gpt-5.5": { params: { reasoning_effort: "high" } },
          },
        },
      },
    } as OpenClawConfig;

    const result = await runRepairs(staleUpgradeConfig, {
      candidate: staleUpgradeConfig,
      env: {},
    });

    expect(result.state.pendingChanges).toBe(true);
    expect(result.state.candidate.plugins?.allow).toEqual(["openai", "codex"]);
    expect(result.state.candidate.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.state.candidate.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(
      result.state.candidate.agents?.defaults?.models?.["openai-codex/gpt-5.5"],
    ).toBeUndefined();
    expect(result.state.candidate.agents?.defaults?.models?.["openai/gpt-5.5"]).toMatchObject({
      params: { reasoning_effort: "high" },
      agentRuntime: { id: "codex" },
    });
    const changeNotes = result.configChangeNotes.join("\n");
    expect(changeNotes).toContain("agents.defaults.model: openai-codex/gpt-5.5 -> openai/gpt-5.5");
    expect(changeNotes).toContain(
      "agents.defaults.models.openai-codex/gpt-5.5: openai-codex/gpt-5.5 -> openai/gpt-5.5",
    );
    expect(changeNotes).toContain(
      'Set agents.defaults.models.openai/gpt-5.5.agentRuntime.id to "codex"',
    );
    expect(changeNotes).toContain("Added codex to plugins.allow");
  });

  it("runs group allowFrom fallback migration after open-policy allowFrom repair", async () => {
    const events: string[] = [];
    mocks.maybeRepairOpenPolicyAllowFrom.mockImplementationOnce((cfg: OpenClawConfig) => {
      events.push("open-policy");
      return mutation(
        { ...cfg, channels: { signal: { ...cfg.channels?.signal, allowFrom: ["*"] } } },
        'channels.signal.allowFrom: set to ["*"]',
      );
    });
    mocks.maybeRepairGroupAllowFromFallback.mockImplementationOnce((cfg: OpenClawConfig) => {
      events.push("group-fallback");
      expect(cfg.channels?.signal?.allowFrom).toEqual(["*"]);
      return mutation(
        { ...cfg, channels: { signal: { ...cfg.channels?.signal, groupAllowFrom: ["*"] } } },
        "channels.signal.groupAllowFrom: copied 1 sender entry from allowFrom",
      );
    });

    const result = await runRepairs({ channels: { signal: { dmPolicy: "open" } } });

    expect(events).toEqual(["open-policy", "group-fallback"]);
    expect(result.state.candidate.channels?.signal?.groupAllowFrom).toEqual(["*"]);
  });

  it("does not remove deferred configured plugins during the package update doctor pass", async () => {
    const deferred =
      'Skipped package-manager repair for configured plugin "brave" during package update; rerun "openclaw doctor --fix" after the update completes.';
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValueOnce({
      changes: [deferred],
      warnings: [],
    });
    const result = await runRepairs(
      { plugins: { allow: ["brave"], entries: { brave: structuredClone(configuredBrave) } } },
      { env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" } },
    );

    expect(mocks.maybeRepairStalePluginConfig).not.toHaveBeenCalled();
    expect(result.state.candidate.plugins?.allow).toEqual(["brave"]);
    expect(result.state.candidate.plugins?.entries?.brave?.enabled).toBe(true);
    expect(result.changeNotes).toStrictEqual([deferred]);
  });

  it("preserves configured plugins when their install repair fails", async () => {
    const warning =
      'Failed to install missing configured plugin "brave" from @openclaw/brave-plugin: package install failed';
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValueOnce({
      changes: [],
      warnings: [warning],
      failedPluginIds: ["brave"],
    });
    mocks.maybeRepairStalePluginConfig.mockImplementationOnce(
      (cfg: OpenClawConfig, _env: NodeJS.ProcessEnv | undefined, params: unknown) => {
        expectPreservedPlugins(params, "brave");
        return {
          config: {
            ...cfg,
            plugins: {
              ...cfg.plugins,
              allow: ["brave"],
              entries: {
                brave: cfg.plugins?.entries?.brave,
              },
            },
          },
          changes: ["plugins.entries: removed 1 stale plugin entry (old-plugin)"],
        };
      },
    );

    const result = await runRepairs({
      plugins: {
        allow: ["brave"],
        entries: {
          brave: structuredClone(configuredBrave),
          "old-plugin": { enabled: true },
        },
      },
    });

    expect(result.state.candidate.plugins?.allow).toEqual(["brave"]);
    expect(result.state.candidate.plugins?.entries?.brave?.enabled).toBe(true);
    expect(result.state.candidate.plugins?.entries?.["old-plugin"]).toBeUndefined();
    expect(result.state.pendingChanges).toBe(true);
    expect(result.configChangeNotes).toContain(
      "plugins.entries: removed 1 stale plugin entry (old-plugin)",
    );
    expect(result.warningNotes).toStrictEqual([warning]);
  });

  it("preserves configured channels when their install repair fails", async () => {
    const warning =
      'Failed to install missing configured channel plugin "whatsapp" from @openclaw/whatsapp: package install failed';
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValueOnce({
      changes: [],
      warnings: [warning],
      failedPluginIds: ["whatsapp"],
    });
    mocks.maybeRepairStalePluginConfig.mockImplementationOnce(
      (cfg: OpenClawConfig, _env: NodeJS.ProcessEnv | undefined, params: unknown) => {
        expectPreservedPlugins(params, "whatsapp");
        return unchanged(cfg);
      },
    );

    const result = await runRepairs({ channels: { whatsapp: { allowFrom: ["+15555550123"] } } });

    expect(mocks.maybeRepairStalePluginConfig).toHaveBeenCalledOnce();
    expect(result.state.candidate.channels?.whatsapp).toEqual({ allowFrom: ["+15555550123"] });
    expect(result.warningNotes).toStrictEqual([warning]);
  });
});
