/** Tests plugin lookup table indexing for manifest-owned contribution ids. */
import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { makePluginMetadataIndex } from "./current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
import type { PluginRegistrySnapshot } from "./plugin-registry.js";

const { channels, disabledChannels, readManifests } = vi.hoisted(() => {
  // Shared plugin workers must load the lookup graph under this file's manifest mocks.
  vi.resetModules();
  return { channels: vi.fn(), disabledChannels: vi.fn(), readManifests: vi.fn() };
});

// mock-isolation: Synthetic presence signals keep lookup tests independent of channel runtimes.
vi.mock("../channels/config-presence.js", () => ({
  hasMeaningfulChannelConfig: (value: unknown) =>
    Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).some((key) => key !== "enabled"),
    ),
  listPotentialConfiguredChannelIds: channels,
  listPotentialConfiguredChannelPresenceSignals: (
    config: OpenClawConfig,
    env: NodeJS.ProcessEnv,
    options?: { includePersistedAuthState?: boolean },
  ) =>
    channels(config, env, options).map((channelId: string) => ({
      channelId,
      source: "env" as const,
    })),
  listExplicitlyDisabledChannelIdsForConfig: disabledChannels,
}));

vi.mock("./manifest-registry-installed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manifest-registry-installed.js")>();
  return { ...actual, loadPluginManifestRegistryForInstalledIndex: readManifests };
});

function createManifestRecord(
  id: string,
  plugin: Partial<PluginManifestRecord> = {},
): PluginManifestRecord {
  return createPluginManifestRecordFixture({
    id,
    name: id,
    rootDir: `/plugins/${id}`,
    ...plugin,
  });
}

function createStartupPlugins() {
  return [
    createManifestRecord("openai", {
      enabledByDefault: true,
      providers: ["openai"],
      activation: { onStartup: true },
    }),
    createManifestRecord("browser", {
      enabledByDefault: true,
      activation: { onStartup: true, onConfigPaths: ["browser"] },
    }),
    createManifestRecord("telegram", { channels: ["telegram"] }),
  ];
}

function createIndex(
  plugins: readonly PluginManifestRecord[],
  params: { policyHash?: string; enabled?: boolean } = {},
): PluginRegistrySnapshot {
  return {
    ...makePluginMetadataIndex(),
    policyHash: params.policyHash ?? "policy",
    plugins: plugins.map((plugin) => ({
      ...makePluginMetadataIndex(plugin.id).plugins[0]!,
      manifestPath: plugin.manifestPath,
      manifestHash: `${plugin.id}-hash`,
      rootDir: plugin.rootDir,
      origin: plugin.origin,
      enabled: params.enabled ?? true,
      ...(plugin.enabledByDefault !== undefined
        ? { enabledByDefault: plugin.enabledByDefault }
        : {}),
      startup: {
        sidecar: false,
        memory: false,
        agentHarnesses: [],
        configPaths: plugin.activation?.onConfigPaths ?? [],
      },
    })),
  };
}

const indexDiagnostic = {
  level: "warn",
  source: "/plugins/demo/openclaw.plugin.json",
  message: "indexed warning",
} as const;

const manifestDiagnostic = { ...indexDiagnostic, message: "manifest warning" };

function makeConfig(plugins: OpenClawConfig["plugins"] = {}): OpenClawConfig {
  return { plugins: { slots: { memory: "none" }, ...plugins } };
}

beforeEach(() => {
  channels
    .mockReset()
    .mockImplementation((config: OpenClawConfig) => Object.keys(config.channels ?? {}));
  disabledChannels.mockReset().mockReturnValue([]);
  readManifests.mockReset();
});

it("builds owner maps and startup ids from one installed manifest registry", async () => {
  const plugins = [
    createManifestRecord("telegram", {
      channels: ["telegram"],
      channelConfigs: { telegram: { schema: { type: "object" } } },
      commandAliases: [{ name: "telegram-send" }],
      contracts: { tools: ["telegram.send"] },
    }),
    createManifestRecord("openai", {
      providers: ["openai"],
      providerAuthAliases: { openai: "openai" },
      modelCatalog: {
        aliases: { "azure-openai-responses": { provider: "openai" } },
        providers: { openai: { models: [{ id: "gpt-test" }] } },
      },
      cliBackends: [],
      setup: { providers: [{ id: "openai" }] },
    }),
  ];
  const index = { ...createIndex(plugins), diagnostics: [indexDiagnostic] };
  const manifestRegistry: PluginManifestRegistry = {
    plugins,
    diagnostics: [indexDiagnostic, manifestDiagnostic],
  };
  readManifests.mockReturnValue(manifestRegistry);
  const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");

  const table = loadPluginLookUpTable({
    config: {
      channels: { telegram: { token: "configured" } },
      plugins: { slots: { memory: "none" } },
    } as OpenClawConfig,
    env: {},
    index,
  });

  expect(table.manifestRegistry).toBe(manifestRegistry);
  expect(table.diagnostics).toEqual([indexDiagnostic, manifestDiagnostic]);
  expect(table.metrics).toMatchObject({
    indexPluginCount: 2,
    manifestPluginCount: 2,
    startupPluginCount: 1,
  });
  for (const metricName of [
    "registrySnapshotMs",
    "manifestRegistryMs",
    "startupPlanMs",
    "ownerMapsMs",
    "totalMs",
  ] as const) {
    expect(table.metrics[metricName]).toBeGreaterThanOrEqual(0);
  }
  expect(table.byPluginId.get("telegram")?.id).toBe("telegram");
  expect(table.normalizePluginId("openai")).toBe("openai");
  expect(table.owners.channels.get("telegram")).toEqual(["telegram"]);
  expect(table.owners.channelConfigs.get("telegram")).toEqual(["telegram"]);
  expect(table.owners.providers.get("openai")).toEqual(["openai"]);
  expect(table.owners.modelCatalogProviders.get("openai")).toEqual(["openai"]);
  expect(table.owners.modelCatalogProviders.get("azure-openai-responses")).toEqual(["openai"]);
  expect(table.owners.cliBackends.get("codex-cli")).toBeUndefined();
  expect(table.owners.setupProviders.get("openai")).toEqual(["openai"]);
  expect(table.owners.commandAliases.get("telegram-send")).toEqual(["telegram"]);
  expect(table.owners.contracts.get("tools")).toEqual(["telegram"]);
  expect(table.startup.channelPluginIds).toEqual(["telegram"]);
  expect(table.startup.pluginIds).toEqual(["telegram"]);
});

it("projects ambient activation policy from prepared lookup metadata", async () => {
  const plugins = [createManifestRecord("telegram", { channels: ["telegram"] })];
  const config = makeConfig();
  const env = { TELEGRAM_FAKE_TEST_TRIGGER: "configured" } as NodeJS.ProcessEnv;
  const index = createIndex(plugins, { policyHash: resolveInstalledPluginIndexPolicyHash(config) });
  readManifests.mockReturnValue({ plugins, diagnostics: [] });
  channels.mockImplementation(
    (
      _config: OpenClawConfig,
      _env: NodeJS.ProcessEnv,
      options?: { ambientEnvTriggers?: string },
    ) => (options?.ambientEnvTriggers === "suppress" ? [] : ["telegram"]),
  );
  const { loadPluginMetadataSnapshot } = await import("./plugin-metadata-snapshot.js");
  const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");
  const metadataSnapshot = loadPluginMetadataSnapshot({ config, env, index });

  const ambient = loadPluginLookUpTable({ config, env, index, metadataSnapshot });
  const suppressed = loadPluginLookUpTable({
    config,
    env,
    index,
    metadataSnapshot,
    ambientEnvTriggers: "suppress",
  });
  expect(ambient.startup.pluginIds).toEqual(["telegram"]);
  expect(suppressed.startup.pluginIds).toStrictEqual([]);
  expect(readManifests).toHaveBeenCalledOnce();
});

it("keeps config-path activation owners when projecting one complete inventory", async () => {
  const plugins = createStartupPlugins();
  const index = createIndex(plugins);
  readManifests.mockImplementation((params: { pluginIds?: readonly string[] }) => ({
    plugins: params.pluginIds
      ? plugins.filter((plugin) => params.pluginIds?.includes(plugin.id))
      : plugins,
    diagnostics: [],
  }));
  const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");

  const params = {
    config: { ...makeConfig({ allow: ["openai"] }), browser: { enabled: true } },
    env: {},
    index,
  };
  const table = loadPluginLookUpTable(params);
  const repeated = loadPluginLookUpTable(params);
  expect(repeated.manifestRegistry).toBe(table.manifestRegistry);

  expect(readManifests).toHaveBeenCalledOnce();
  expect(readManifests.mock.calls[0]?.[0]).toMatchObject({
    index,
    config: params.config,
    env: {},
    includeDisabled: true,
  });
  expect(readManifests.mock.calls[0]?.[0]).not.toHaveProperty("pluginIds");
  expect(table.pluginIds).toEqual(["browser", "openai"]);
  expect(table.metrics.indexPluginCount).toBe(3);
  expect(table.metrics.manifestPluginCount).toBe(2);
  expect(table.byPluginId.has("telegram")).toBe(false);
  expect(table.startup.pluginIds).toEqual(["openai", "browser"]);
});

it("applies current activation policy without replacing the startup inventory", async () => {
  const plugins = [
    createManifestRecord("demo", { enabledByDefault: true, activation: { onStartup: true } }),
  ];
  const startupConfig = makeConfig({
    entries: { demo: { enabled: false } },
    load: { paths: ["/plugins/startup"] },
  });
  const index = createIndex(plugins, {
    policyHash: resolveInstalledPluginIndexPolicyHash(startupConfig),
    enabled: false,
  });
  readManifests.mockReturnValue({ plugins, diagnostics: [] });
  const { loadPluginMetadataSnapshot } = await import("./plugin-metadata-snapshot.js");
  const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");
  const metadataSnapshot = loadPluginMetadataSnapshot({
    config: startupConfig,
    env: {},
    workspaceDir: "/workspace/startup",
    index,
  });
  readManifests.mockClear();
  const enabledConfig = makeConfig({ load: { paths: ["/plugins/next-boot"] } });
  const replacementIndex = createIndex([
    ...plugins,
    createManifestRecord("next-boot", { enabledByDefault: true, activation: { onStartup: true } }),
  ]);

  for (const [config, expectedPluginIds] of [
    [startupConfig, []],
    [enabledConfig, ["demo"]],
    [{ ...enabledConfig, plugins: { ...enabledConfig.plugins, deny: ["demo"] } }, []],
  ] satisfies Array<[OpenClawConfig, string[]]>) {
    const table = loadPluginLookUpTable({
      config,
      env: { HOME: "/home/next-boot" },
      workspaceDir: "/workspace/next-boot",
      index: replacementIndex,
      metadataSnapshot,
    });
    expect(table.startup.pluginIds).toEqual(expectedPluginIds);
    expect(table.manifestRegistry).toBe(metadataSnapshot.manifestRegistry);
    expect(table.index).toBe(metadataSnapshot.index);
    expect([...table.byPluginId.keys()]).toEqual(["demo"]);
  }
  expect(readManifests).not.toHaveBeenCalled();
});
