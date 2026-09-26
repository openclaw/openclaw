/**
 * Gateway startup plugin bootstrap tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderPolicySurface } from "../plugins/provider-policy-surface.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { capturePluginLifecycleAuthority } from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";

const applyPluginAutoEnable = vi.hoisted(() =>
  vi.fn((params: { config: unknown }) => ({
    config: params.config,
    changes: [] as string[],
    autoEnabledReasons: {} as Record<string, string[]>,
  })),
);
const initSubagentRegistry = vi.hoisted(() => vi.fn());
const getActivePluginRegistry = vi.hoisted(() => vi.fn<() => PluginRegistry | undefined>());
const setActivePluginRegistry = vi.hoisted(() => vi.fn());
const resolveProviderPolicySurfaceForOwner = vi.hoisted(() =>
  vi.fn<(owner: PluginManifestRecord) => ProviderPolicySurface | null>(() => null),
);
const prepareGatewayPluginLoad = vi.hoisted(() =>
  vi.fn((params: { cfg: OpenClawConfig }) => ({
    pluginRegistry: createEmptyPluginRegistry(),
    gatewayMethods: ["ping"],
    resolvedConfig: params.cfg,
    retireGatewayRuntimeBindings: vi.fn(),
  })),
);
const pluginManifestRegistry = vi.hoisted((): PluginManifestRegistry => ({
  plugins: [
    {
      id: "telegram",
      origin: "bundled",
      rootDir: "/package/dist/extensions/telegram",
      source: "/package/dist/extensions/telegram/index.js",
      manifestPath: "/package/dist/extensions/telegram/package.json",
      channels: ["telegram"],
      providers: [],
      cliBackends: [],
      skills: [],
      hooks: [],
    },
  ],
  diagnostics: [],
}));
const pluginMetadataSnapshot = vi.hoisted((): PluginMetadataSnapshot => {
  const index: PluginMetadataSnapshot["index"] = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "policy",
    generatedAtMs: 0,
    installRecords: {},
    plugins: [],
    diagnostics: [],
  };
  return {
    policyHash: "policy",
    index,
    registryIndex: index,
    registryDiagnostics: [],
    manifestRegistry: pluginManifestRegistry,
    bundledManifestRegistry: pluginManifestRegistry,
    plugins: [],
    diagnostics: [],
    byPluginId: new Map(),
    normalizePluginId: (pluginId) => pluginId,
    declaredProviderOwners: new Map(),
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
      providerAuthContributions: [],
      modelIdNormalizationPolicies: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: 0,
    },
  };
});
const pluginLookUpTableMetrics = vi.hoisted(() => ({
  registrySnapshotMs: 0,
  manifestRegistryMs: 0,
  startupPlanMs: 0,
  ownerMapsMs: 0,
  totalMs: 0,
  indexPluginCount: 0,
  manifestPluginCount: 0,
  startupPluginCount: 1,
}));
const loadPluginLookUpTable = vi.hoisted(() =>
  vi.fn((_params: unknown) => ({
    ...pluginMetadataSnapshot,
    startup: {
      pluginIds: ["telegram"] as string[],
      channelPluginIds: ["telegram"] as string[],
    },
    metrics: pluginLookUpTableMetrics,
  })),
);
const resolveOpenClawPackageRootSync = vi.hoisted(() => vi.fn((_params: unknown) => "/package"));
const runChannelPluginStartupMaintenance = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => undefined),
);
const listAmbientOnlyConfiguredChannelIds = vi.hoisted(() =>
  vi.fn((_params: unknown) => [] as string[]),
);
const runStartupSessionMigration = vi.hoisted(() => vi.fn(async (_params: unknown) => undefined));
const listLegacyPairingStoreFiles = vi.hoisted(() => vi.fn(async () => [] as string[]));
vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => "/workspace",
  resolveDefaultAgentId: () => "default",
  tryResolveConfiguredAgentWorkspaceDir: () => "/workspace",
  tryResolveSystemAgentWorkspaceDir: () => "/workspace",
}));

vi.mock("../agents/workspace-state-dirs.js", () => ({
  assertConfiguredWorkspaceStateReady: () => {},
}));

vi.mock("../agents/subagents/registry/subagent-registry.js", () => ({
  initSubagentRegistry: () => initSubagentRegistry(),
}));

vi.mock("../channels/plugins/lifecycle-startup.js", () => ({
  runChannelPluginStartupMaintenance: (params: unknown) =>
    runChannelPluginStartupMaintenance(params),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (params: { config: unknown }) => applyPluginAutoEnable(params),
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync: (params: unknown) => resolveOpenClawPackageRootSync(params),
}));

vi.mock("../infra/device-pairing-node-desktop-migration.js", () => ({
  migrateLegacyDesktopStreamOptOuts: async () => 0,
}));

vi.mock("../infra/pairing-files.js", () => ({
  listLegacyPairingStoreFiles: () => listLegacyPairingStoreFiles(),
}));

vi.mock("../plugins/channel-presence-policy.js", () => ({
  listAmbientOnlyConfiguredChannelIds: (params: unknown) =>
    listAmbientOnlyConfiguredChannelIds(params),
}));

vi.mock("../plugins/plugin-lookup-table.js", () => ({
  loadPluginLookUpTable: (params: unknown) => loadPluginLookUpTable(params),
}));

vi.mock("../plugins/registry.js", () => import("../plugins/registry-empty.js"));

vi.mock("../plugins/provider-public-artifacts.js", () => ({
  resolveProviderPolicySurfaceForOwner,
}));

vi.mock("../plugins/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/runtime.js")>()),
  getActivePluginRegistry,
  setActivePluginRegistry,
}));

vi.mock("./server-methods-list.js", () => ({
  listGatewayMethods: () => ["ping"],
}));

vi.mock("./server-plugin-bootstrap.js", () => ({
  prepareGatewayPluginLoad,
}));

vi.mock("./server-startup-session-migration.js", () => ({
  runStartupSessionMigration: (params: unknown) => runStartupSessionMigration(params),
}));

function createLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function firstCallArg<T>(mock: { mock: { calls: unknown[][] } }, _type?: (value: T) => T): T {
  const call = mock.mock.calls.at(0);
  if (!call) {
    throw new Error("Expected first mock call");
  }
  return call[0] as T;
}

function slackConfig(): OpenClawConfig {
  return {
    channels: {
      slack: { enabled: true, token: "token" },
    },
  } as OpenClawConfig;
}

async function prepareBootstrapWithRuntimeConfig(
  cfg: OpenClawConfig,
  options: {
    minimalTestGateway?: boolean;
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
    workerProviderIds?: readonly string[];
  } = {},
) {
  const log = createLog();
  const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");

  return await prepareGatewayPluginBootstrap({
    cfgAtStart: cfg,
    minimalTestGateway: false,
    log,
    ...options,
  });
}

describe("runGatewayStartupMaintenance", () => {
  beforeEach(() => {
    runChannelPluginStartupMaintenance.mockClear();
    runStartupSessionMigration.mockClear();
    listLegacyPairingStoreFiles.mockReset().mockResolvedValue([]);
  });

  it("runs channel and session maintenance for a normal gateway", async () => {
    const log = createLog();
    const { runGatewayStartupMaintenance } = await import("./server-startup-plugins.js");

    await runGatewayStartupMaintenance({
      cfgAtStart: {},
      startupRuntimeConfig: {},
      minimalTestGateway: false,
      log,
    });

    expect(runChannelPluginStartupMaintenance).toHaveBeenCalledWith({
      cfg: {},
      env: process.env,
      log,
    });
    expect(runStartupSessionMigration).toHaveBeenCalledWith({
      cfg: {},
      env: process.env,
      log,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("skips maintenance for a minimal gateway without channel config", async () => {
    const { runGatewayStartupMaintenance } = await import("./server-startup-plugins.js");

    await runGatewayStartupMaintenance({
      cfgAtStart: {},
      startupRuntimeConfig: {},
      minimalTestGateway: true,
      log: createLog(),
    });

    expect(runChannelPluginStartupMaintenance).not.toHaveBeenCalled();
    expect(runStartupSessionMigration).not.toHaveBeenCalled();
    expect(listLegacyPairingStoreFiles).not.toHaveBeenCalled();
  });

  it("runs only channel maintenance for a minimal gateway with recovered channel config", async () => {
    const log = createLog();
    const recoveredConfig = slackConfig();
    const { runGatewayStartupMaintenance } = await import("./server-startup-plugins.js");

    await runGatewayStartupMaintenance({
      cfgAtStart: {},
      startupRuntimeConfig: recoveredConfig,
      minimalTestGateway: true,
      log,
    });

    expect(runChannelPluginStartupMaintenance).toHaveBeenCalledWith({
      cfg: recoveredConfig,
      env: process.env,
      log,
    });
    expect(runStartupSessionMigration).not.toHaveBeenCalled();
    expect(listLegacyPairingStoreFiles).not.toHaveBeenCalled();
  });
});

describe("prepareGatewayPluginBootstrap startup plugins", () => {
  beforeEach(() => {
    getActivePluginRegistry.mockReset();
    setActivePluginRegistry.mockClear();
    applyPluginAutoEnable.mockClear();
    initSubagentRegistry.mockClear();
    prepareGatewayPluginLoad.mockClear();
    listAmbientOnlyConfiguredChannelIds.mockClear().mockReturnValue([]);
    loadPluginLookUpTable.mockClear().mockReturnValue({
      ...pluginMetadataSnapshot,
      manifestRegistry: pluginManifestRegistry,
      startup: {
        pluginIds: ["telegram"] as string[],
        channelPluginIds: ["telegram"] as string[],
      },
      metrics: pluginLookUpTableMetrics,
    });
    resolveOpenClawPackageRootSync.mockClear().mockReturnValue("/package");
    runChannelPluginStartupMaintenance.mockClear();
    runStartupSessionMigration.mockClear();
    listLegacyPairingStoreFiles.mockReset().mockResolvedValue([]);
  });
  it("does not run startup maintenance", async () => {
    await prepareBootstrapWithRuntimeConfig({});

    expect(runChannelPluginStartupMaintenance).not.toHaveBeenCalled();
    expect(runStartupSessionMigration).not.toHaveBeenCalled();
    expect(listLegacyPairingStoreFiles).not.toHaveBeenCalled();
  });

  it("hydrates the subagent registry before plugin bootstrap", async () => {
    await prepareBootstrapWithRuntimeConfig({});

    expect(initSubagentRegistry).toHaveBeenCalledOnce();
    expect(initSubagentRegistry.mock.invocationCallOrder[0]).toBeLessThan(
      loadPluginLookUpTable.mock.invocationCallOrder[0]!,
    );
  });

  it("derives startup activation from source config instead of runtime plugin defaults", async () => {
    const sourceConfig = {
      channels: {
        telegram: {
          botToken: "token",
        },
      },
      plugins: {
        allow: ["bench-plugin"],
      },
    } as OpenClawConfig;
    const activationConfig = {
      channels: {
        telegram: {
          botToken: "token",
          enabled: true,
        },
      },
      plugins: {
        allow: ["bench-plugin"],
        entries: {
          "bench-plugin": {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;
    const runtimeConfig = {
      channels: {
        telegram: {
          botToken: "token",
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
        },
      },
      plugins: {
        allow: ["bench-plugin", "memory-core"],
        entries: {
          "bench-plugin": {
            config: {
              runtimeDefault: true,
            },
          },
          "memory-core": {
            config: {
              dreaming: {
                enabled: false,
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    applyPluginAutoEnable.mockReturnValueOnce({
      config: activationConfig,
      changes: [],
      autoEnabledReasons: {},
    });
    const log = createLog();
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");

    await prepareGatewayPluginBootstrap({
      cfgAtStart: runtimeConfig,
      activationSourceConfig: sourceConfig,
      pluginMetadataSnapshot,
      minimalTestGateway: false,
      log,
    });

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: sourceConfig,
      env: process.env,
      manifestRegistry: pluginManifestRegistry,
    });
    const lookupInput = firstCallArg<{
      activationSourceConfig?: OpenClawConfig;
      metadataSnapshot?: PluginMetadataSnapshot;
      config?: OpenClawConfig;
    }>(loadPluginLookUpTable);
    expect(lookupInput.activationSourceConfig).toBe(sourceConfig);
    expect(lookupInput.metadataSnapshot).toBe(pluginMetadataSnapshot);
    expect(lookupInput.config?.channels?.telegram?.enabled).toBe(true);
    expect(lookupInput.config?.channels?.telegram?.dmPolicy).toBe("pairing");
    expect(lookupInput.config?.channels?.telegram?.groupPolicy).toBe("allowlist");
    expect(lookupInput.config?.plugins?.allow).toEqual(["bench-plugin"]);
    expect(lookupInput.config?.plugins?.entries?.["bench-plugin"]?.enabled).toBe(true);
    expect(lookupInput.config?.plugins?.entries?.["bench-plugin"]?.config).toEqual({
      runtimeDefault: true,
    });
    expect(lookupInput.config?.plugins?.entries?.["memory-core"]?.config).toEqual({
      dreaming: { enabled: false },
    });

    expect(prepareGatewayPluginLoad).not.toHaveBeenCalled();
  });

  it.each([
    { minimalTestGateway: false, pluginsEnabled: true, reuseAmbientRegistry: false },
    { minimalTestGateway: true, pluginsEnabled: undefined, reuseAmbientRegistry: true },
    { minimalTestGateway: true, pluginsEnabled: true, reuseAmbientRegistry: true },
    { minimalTestGateway: true, pluginsEnabled: false, reuseAmbientRegistry: false },
  ])(
    "keeps the pre-bind registry local without runtime loading (minimal=$minimalTestGateway, enabled=$pluginsEnabled)",
    async ({ minimalTestGateway, pluginsEnabled, reuseAmbientRegistry }) => {
      const { capturePluginRegistryLifecycleEpoch, markPluginRegistryActive } =
        await import("../plugins/registry-lifecycle.js");
      const ambientRegistry = createEmptyPluginRegistry();
      ambientRegistry.gatewayHandlers.fixture = vi.fn();
      markPluginRegistryActive(ambientRegistry);
      const ambientEpoch = capturePluginRegistryLifecycleEpoch(ambientRegistry);
      getActivePluginRegistry.mockReturnValue(ambientRegistry);

      const result = await prepareBootstrapWithRuntimeConfig(
        { ...slackConfig(), plugins: { enabled: pluginsEnabled } },
        { minimalTestGateway },
      );

      if (reuseAmbientRegistry) {
        expect(result.pluginRegistry).toBe(ambientRegistry);
      } else {
        expect(result.pluginRegistry.gatewayHandlers).toEqual({});
      }
      expect(capturePluginRegistryLifecycleEpoch(result.pluginRegistry)).toBeDefined();
      expect(capturePluginRegistryLifecycleEpoch(ambientRegistry)).toBe(ambientEpoch);
      expect(setActivePluginRegistry).not.toHaveBeenCalled();
      expect(getActivePluginRegistry()).toBe(ambientRegistry);
      expect(prepareGatewayPluginLoad).not.toHaveBeenCalled();
    },
  );

  it("threads durable worker provider ids into startup lookup planning", async () => {
    await prepareBootstrapWithRuntimeConfig({ channels: {} } as OpenClawConfig, {
      workerProviderIds: ["static-ssh"],
    });

    const lookupInput = firstCallArg<{ workerProviderIds?: readonly string[] }>(
      loadPluginLookUpTable,
    );
    expect(lookupInput.workerProviderIds).toEqual(["static-ssh"]);
  });

  it("preserves an explicitly empty manifest snapshot for ambient channel planning", async () => {
    const emptyManifestRegistry: PluginManifestRegistry = { plugins: [], diagnostics: [] };
    loadPluginLookUpTable.mockReturnValueOnce({
      ...pluginMetadataSnapshot,
      manifestRegistry: emptyManifestRegistry,
      bundledManifestRegistry: emptyManifestRegistry,
      startup: {
        pluginIds: [],
        channelPluginIds: [],
      },
      metrics: pluginLookUpTableMetrics,
    });

    const log = createLog();
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");
    const result = await prepareGatewayPluginBootstrap({
      cfgAtStart: { channels: {} },
      minimalTestGateway: false,
      ambientEnvTriggers: "suppress",
      log,
    });

    expect(result.pluginManifestRecords).toBe(emptyManifestRegistry.plugins);
    const ambientInput = firstCallArg<{ manifestRecords?: readonly unknown[] }>(
      listAmbientOnlyConfiguredChannelIds,
    );
    expect(ambientInput.manifestRecords).toBe(emptyManifestRegistry.plugins);
  });

  it("bypasses plugin lookup when plugins are globally disabled", async () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "token",
        },
      },
      plugins: {
        enabled: false,
        allow: ["telegram"],
        entries: {
          telegram: { enabled: true },
        },
      },
    } as OpenClawConfig;

    const result = await prepareBootstrapWithRuntimeConfig(cfg, {
      pluginMetadataSnapshot,
      workerProviderIds: ["static-ssh"],
    });
    expect(result.startupPluginIds).toEqual([]);
    expect(result.pluginMetadataSnapshot).toBe(pluginMetadataSnapshot);
    expect(result.pluginLookUpTable).toBeUndefined();
    expect(result.baseGatewayMethods).toEqual(["ping"]);

    expect(loadPluginLookUpTable).not.toHaveBeenCalled();
    expect(prepareGatewayPluginLoad).not.toHaveBeenCalled();
  });
});

describe("loadGatewayStartupPluginRuntime", () => {
  beforeEach(() => {
    resolveProviderPolicySurfaceForOwner.mockReset().mockReturnValue(null);
    prepareGatewayPluginLoad.mockReset().mockImplementation((params) => ({
      pluginRegistry: createEmptyPluginRegistry(),
      gatewayMethods: ["ping"],
      resolvedConfig: params.cfg,
      retireGatewayRuntimeBindings: vi.fn(),
    }));
  });

  it.each(["valid", "invalid", "invalid with failed cleanup"] as const)(
    "validates %s bindings inside the unpublished candidate and owns its disposal",
    async (outcome) => {
      const registry = createEmptyPluginRegistry();
      const record = createPluginRecord({
        id: "binding-owner",
        source: "startup-binding-fixture",
        origin: "workspace",
        enabled: true,
        configSchema: false,
      });
      registry.plugins.push(record);
      const instance = new PluginInstance(record.id, { registry, record });
      const validationError = new Error("synthetic invalid binding");
      const cleanupError = new Error("synthetic candidate cleanup failure");
      const cleanup = vi.fn(() => {
        if (outcome === "invalid with failed cleanup") {
          throw cleanupError;
        }
      });
      instance.lifecycle.onDispose(cleanup);
      let validationAuthority: (() => boolean) | undefined;
      const compileConfiguredBinding = vi.fn(() => {
        expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
        validationAuthority = capturePluginLifecycleAuthority(registry, record);
        expect(validationAuthority?.()).toBe(true);
        if (outcome !== "valid") {
          throw validationError;
        }
        return null;
      });
      registry.channels.push({
        pluginId: record.id,
        source: record.source,
        plugin: {
          ...createChannelTestPluginBase({ id: "discord" }),
          bindings: { compileConfiguredBinding, matchInboundConversation: () => null },
        },
      });
      const config: OpenClawConfig = {
        bindings: [
          {
            type: "acp",
            agentId: "main",
            match: { channel: "discord", peer: { kind: "channel", id: "fixture-room" } },
          },
        ],
      };
      const retireGatewayRuntimeBindings = vi.fn();
      const candidate = {
        pluginRegistry: registry,
        gatewayMethods: [],
        resolvedConfig: config,
        retireGatewayRuntimeBindings,
      };
      prepareGatewayPluginLoad.mockReturnValueOnce(candidate);
      const { loadGatewayStartupPluginRuntime } = await import("./server-startup-plugins.js");
      try {
        const loading = loadGatewayStartupPluginRuntime({
          cfg: config,
          log: createLog(),
          baseMethods: [],
          startupPluginIds: [record.id],
        });
        if (outcome === "valid") {
          await expect(loading).resolves.toBe(candidate);
          expect(cleanup).not.toHaveBeenCalled();
          expect(retireGatewayRuntimeBindings).not.toHaveBeenCalled();
        } else {
          await expect(loading).rejects.toBe(validationError);
          expect(cleanup).toHaveBeenCalledOnce();
          expect(instance.lifecycle.signal.aborted).toBe(true);
          expect(retireGatewayRuntimeBindings).toHaveBeenCalledOnce();
        }
        expect(compileConfiguredBinding).toHaveBeenCalledOnce();
        expect(validationAuthority?.()).toBe(false);
      } finally {
        retireGatewayRuntimeBindings();
        const disposed = await disposePluginRegistryInstances(registry);
        expect(disposed.failures).toEqual(
          outcome === "invalid with failed cleanup"
            ? [{ pluginId: record.id, hookId: "instance", error: cleanupError }]
            : [],
        );
        expect(cleanup).toHaveBeenCalledOnce();
        expect(instance.lifecycle.signal.aborted).toBe(true);
      }
    },
  );

  it("warns after a full startup runtime load when configured memory embedding providers stay unregistered", async () => {
    const log = createLog();
    const { loadGatewayStartupPluginRuntime } = await import("./server-startup-plugins.js");

    await loadGatewayStartupPluginRuntime({
      cfg: {
        memory: {
          search: {
            provider: "voyage",
          },
        },

        agents: {
          defaults: {},
        },
      } as OpenClawConfig,
      workspaceDir: "/workspace",
      log,
      baseMethods: ["ping"],
      startupPluginIds: ["voyage"],
    });

    const startupInput = firstCallArg<{
      channelPluginLoadIntent?: "full" | "setup";
      loadIntent: "startup" | "replacement";
    }>(prepareGatewayPluginLoad);
    expect(startupInput.channelPluginLoadIntent).toBe("full");
    expect(startupInput.loadIntent).toBe("startup");
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('memory.search.provider="voyage"'),
    );
  });

  it.each(["registered owner", "ready", "inspection failed", "inspection stalled"] as const)(
    "reports registered memory provider setup per active agent without blocking startup: %s",
    async (outcome) => {
      const log = createLog();
      const registry = createEmptyPluginRegistry();
      const registeredOwner = createPluginManifestRecordFixture({
        id: "llama-cpp",
        contracts: { embeddingProviders: ["local"] },
      });
      const disabledOwner = createPluginManifestRecordFixture({
        id: "a-disabled",
        contracts: registeredOwner.contracts,
      });
      registry.embeddingProviders.push({
        pluginId: "llama-cpp",
        source: "synthetic-llama-cpp",
        provider: { id: "local", create: async () => ({ provider: null }) },
      });
      const cfg: OpenClawConfig = {
        memory: { search: { provider: "local" } },
        plugins: { entries: { "a-disabled": { enabled: false } } },
        agents: {
          entries: {
            main: { memory: { search: { enabled: false } } },
            helper: {},
          },
        },
      };
      const inspectionGate = createDeferred();
      if (outcome !== "inspection stalled") {
        inspectionGate.resolve();
      }
      const inspectEmbeddingProviderSetup = vi.fn(async () => {
        await inspectionGate.promise;
        if (outcome === "inspection failed") {
          throw new Error("synthetic setup inspection failed");
        }
        return outcome === "ready"
          ? null
          : {
              provider: "local",
              reason: "Local embeddings need a managed llama-server.",
              fixHint:
                "Run `openclaw models --agent helper auth login --provider llama-cpp --method local`.",
            };
      });
      const disabledPolicy = {
        inspectEmbeddingProviderSetup: vi.fn(),
      };
      resolveProviderPolicySurfaceForOwner.mockImplementation((owner) =>
        owner === registeredOwner ? { inspectEmbeddingProviderSetup } : disabledPolicy,
      );
      prepareGatewayPluginLoad.mockReturnValueOnce({
        pluginRegistry: registry,
        gatewayMethods: ["ping"],
        resolvedConfig: cfg,
        retireGatewayRuntimeBindings: vi.fn(),
      });
      const { loadGatewayStartupPluginRuntime } = await import("./server-startup-plugins.js");

      let startupCompleted = false;
      const startup = loadGatewayStartupPluginRuntime({
        cfg,
        log,
        baseMethods: ["ping"],
        startupPluginIds: ["llama-cpp"],
        pluginLookUpTable: {
          ...loadPluginLookUpTable({}),
          workerProviderIds: [],
          manifestRegistry: { plugins: [disabledOwner, registeredOwner], diagnostics: [] },
        },
      }).then((result) => {
        startupCompleted = true;
        return result;
      });
      try {
        await vi.waitFor(() => expect(startupCompleted).toBe(true));
      } finally {
        inspectionGate.resolve();
      }
      expect((await startup).pluginRegistry).toBe(registry);
      expect(inspectEmbeddingProviderSetup).toHaveBeenCalledExactlyOnceWith({
        config: cfg,
        env: process.env,
        agentId: "helper",
        provider: "local",
      });
      if (outcome === "registered owner") {
        expect(resolveProviderPolicySurfaceForOwner).toHaveBeenCalledExactlyOnceWith(
          registeredOwner,
        );
        expect(disabledPolicy.inspectEmbeddingProviderSetup).not.toHaveBeenCalled();
      }
      if (outcome === "registered owner" || outcome === "inspection stalled") {
        await vi.waitFor(() =>
          expect(log.warn).toHaveBeenCalledWith(
            expect.stringMatching(/helper.*degraded.*llama-server.*models --agent helper/s),
          ),
        );
      } else if (outcome === "inspection failed") {
        await vi.waitFor(() =>
          expect(log.warn).toHaveBeenCalledWith(
            expect.stringContaining("synthetic setup inspection failed"),
          ),
        );
      } else {
        expect(log.warn).not.toHaveBeenCalled();
      }
    },
  );
});

describe("warnUnregisteredConfiguredMemoryEmbeddingProviders", () => {
  async function warnFor(config: OpenClawConfig, providerIds: string[]) {
    const { warnUnregisteredConfiguredMemoryEmbeddingProviders } =
      await import("./server-startup-plugins.js");
    const log = createLog();
    warnUnregisteredConfiguredMemoryEmbeddingProviders({
      config,
      pluginRegistry: {
        embeddingProviders: providerIds.map((id) => ({ provider: { id } })),
      } as never,
      log,
    });
    return log;
  }

  it("warns when a configured memory embedding fallback is not registered", async () => {
    const log = await warnFor(
      {
        memory: { search: { provider: "openai", fallback: "ollama" } },
        agents: { defaults: {} },
      } as OpenClawConfig,
      ["openai"],
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]?.[0])).toContain('memory.search.fallback="ollama"');
  });

  it("does not warn when the configured memory embedding fallback is registered", async () => {
    const log = await warnFor(
      {
        memory: { search: { provider: "openai", fallback: "ollama" } },
        agents: { defaults: {} },
      } as OpenClawConfig,
      ["openai", "ollama"],
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not warn for core generic memory embedding providers", async () => {
    const log = await warnFor(
      {
        memory: { search: { provider: "openai-compatible" } },
        agents: { defaults: {} },
      } as OpenClawConfig,
      [],
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  function customOllamaConfig(): OpenClawConfig {
    return {
      memory: { search: { provider: "openai", fallback: "ollama-5080" } },
      models: {
        providers: {
          "ollama-5080": {
            api: "ollama",
            baseUrl: "http://gpu-box.local:11435",
            models: [],
          },
        },
      },
    } as OpenClawConfig;
  }

  it("does not warn for custom fallback entries whose api-owner plugin is registered", async () => {
    const log = await warnFor(customOllamaConfig(), ["openai", "ollama"]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns for custom fallbacks whose api-owner plugin is not registered", async () => {
    const log = await warnFor(customOllamaConfig(), ["openai"]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]?.[0])).toContain('memory.search.fallback="ollama-5080"');
  });
});
