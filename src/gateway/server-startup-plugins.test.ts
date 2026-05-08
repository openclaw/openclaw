import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";

const applyPluginAutoEnable = vi.hoisted(() =>
  vi.fn((params: { config: unknown }) => ({
    config: params.config,
    changes: [] as string[],
    autoEnabledReasons: {} as Record<string, string[]>,
  })),
);
const initSubagentRegistry = vi.hoisted(() => vi.fn());
const loadGatewayStartupPlugins = vi.hoisted(() =>
  vi.fn((_params: unknown) => ({
    pluginRegistry: { diagnostics: [], gatewayHandlers: {}, plugins: [] },
    gatewayMethods: ["ping"],
  })),
);
const pluginManifestRegistry = vi.hoisted(
  (): PluginManifestRegistry => ({
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
  }),
);
const pluginMetadataSnapshot = vi.hoisted(
  (): PluginMetadataSnapshot => ({
    policyHash: "policy",
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "policy",
      generatedAtMs: 0,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    },
    registryDiagnostics: [],
    manifestRegistry: pluginManifestRegistry,
    plugins: [],
    diagnostics: [],
    byPluginId: new Map(),
    normalizePluginId: (pluginId) => pluginId,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: 0,
    },
  }),
);
const pluginLookUpTableMetrics = vi.hoisted(() => ({
  registrySnapshotMs: 0,
  manifestRegistryMs: 0,
  startupPlanMs: 0,
  ownerMapsMs: 0,
  totalMs: 0,
  indexPluginCount: 0,
  manifestPluginCount: 0,
  startupPluginCount: 1,
  deferredChannelPluginCount: 0,
}));
const loadPluginLookUpTable = vi.hoisted(() =>
  vi.fn((_params: unknown) => ({
    manifestRegistry: pluginManifestRegistry,
    startup: {
      configuredDeferredChannelPluginIds: [],
      pluginIds: ["telegram"],
    },
    metrics: pluginLookUpTableMetrics,
  })),
);
const resolveOpenClawPackageRootSync = vi.hoisted(() => vi.fn((_params: unknown) => "/package"));
const runChannelPluginStartupMaintenance = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => undefined),
);
const runStartupSessionMigration = vi.hoisted(() => vi.fn(async (_params: unknown) => undefined));
vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => "/workspace",
  resolveDefaultAgentId: () => "default",
}));

vi.mock("../agents/subagent-registry.js", () => ({
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

vi.mock("../plugins/plugin-lookup-table.js", () => ({
  loadPluginLookUpTable: (params: unknown) => loadPluginLookUpTable(params),
}));

vi.mock("../plugins/registry.js", () => ({
  createEmptyPluginRegistry: () => ({ diagnostics: [], gatewayHandlers: {}, plugins: [] }),
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistry: () => undefined,
  setActivePluginRegistry: vi.fn(),
}));

vi.mock("./server-methods-list.js", () => ({
  listGatewayMethods: () => ["ping"],
}));

vi.mock("./server-methods.js", () => ({
  coreGatewayHandlers: {},
}));

vi.mock("./server-plugin-bootstrap.js", () => ({
  loadGatewayStartupPlugins: (params: unknown) => loadGatewayStartupPlugins(params),
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

function createDeferred() {
  let resolve = (): void => {};
  const promise = new Promise<undefined>((res) => {
    resolve = () => {
      res(undefined);
    };
  });
  return { promise, resolve };
}

describe("prepareGatewayPluginBootstrap startup plugins", () => {
  beforeEach(() => {
    applyPluginAutoEnable.mockClear();
    initSubagentRegistry.mockClear();
    loadGatewayStartupPlugins.mockClear();
    loadPluginLookUpTable.mockClear().mockReturnValue({
      manifestRegistry: pluginManifestRegistry,
      startup: {
        configuredDeferredChannelPluginIds: [],
        pluginIds: ["telegram"],
      },
      metrics: pluginLookUpTableMetrics,
    });
    resolveOpenClawPackageRootSync.mockClear().mockReturnValue("/package");
    runChannelPluginStartupMaintenance.mockClear();
    runStartupSessionMigration.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
      startupRuntimeConfig: runtimeConfig,
      pluginMetadataSnapshot,
      minimalTestGateway: false,
      log,
    });

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: sourceConfig,
      env: process.env,
      manifestRegistry: pluginManifestRegistry,
    });
    expect(loadPluginLookUpTable).toHaveBeenCalledWith(
      expect.objectContaining({
        activationSourceConfig: sourceConfig,
        metadataSnapshot: pluginMetadataSnapshot,
        config: expect.objectContaining({
          channels: expect.objectContaining({
            telegram: expect.objectContaining({
              enabled: true,
              dmPolicy: "pairing",
              groupPolicy: "allowlist",
            }),
          }),
          plugins: expect.objectContaining({
            allow: ["bench-plugin"],
            entries: expect.objectContaining({
              "bench-plugin": expect.objectContaining({
                enabled: true,
                config: {
                  runtimeDefault: true,
                },
              }),
              "memory-core": {
                config: {
                  dreaming: {
                    enabled: false,
                  },
                },
              },
            }),
          }),
        }),
      }),
    );
    expect(loadGatewayStartupPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        activationSourceConfig: sourceConfig,
        cfg: expect.objectContaining({
          channels: expect.objectContaining({
            telegram: expect.objectContaining({
              enabled: true,
              dmPolicy: "pairing",
              groupPolicy: "allowlist",
            }),
          }),
          plugins: expect.objectContaining({
            allow: ["bench-plugin"],
            entries: expect.objectContaining({
              "bench-plugin": expect.objectContaining({
                enabled: true,
                config: {
                  runtimeDefault: true,
                },
              }),
              "memory-core": {
                config: {
                  dreaming: {
                    enabled: false,
                  },
                },
              },
            }),
          }),
        }),
      }),
    );
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
    const log = createLog();
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");

    await expect(
      prepareGatewayPluginBootstrap({
        cfgAtStart: cfg,
        startupRuntimeConfig: cfg,
        minimalTestGateway: false,
        log,
      }),
    ).resolves.toMatchObject({
      startupPluginIds: [],
      deferredConfiguredChannelPluginIds: [],
      pluginLookUpTable: undefined,
      baseGatewayMethods: ["ping"],
    });

    expect(loadPluginLookUpTable).not.toHaveBeenCalled();
    expect(loadGatewayStartupPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        pluginIds: [],
        pluginLookUpTable: undefined,
        preferSetupRuntimeForChannelPlugins: false,
        suppressPluginInfoLogs: false,
      }),
    );
  });

  it("does not block plugin loading on startup maintenance in fast gateway mode", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_FAST_CONFIG", "1");
    const channelDeferred = createDeferred();
    const migrationDeferred = createDeferred();
    runChannelPluginStartupMaintenance.mockReturnValueOnce(channelDeferred.promise);
    runStartupSessionMigration.mockReturnValueOnce(migrationDeferred.promise);
    const log = createLog();
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");
    let settled = false;
    const bootstrapPromise = prepareGatewayPluginBootstrap({
      cfgAtStart: {} as OpenClawConfig,
      startupRuntimeConfig: {} as OpenClawConfig,
      minimalTestGateway: false,
      log,
    }).then(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(settled).toBe(true);
      expect(loadGatewayStartupPlugins).toHaveBeenCalledOnce();
      expect(runChannelPluginStartupMaintenance).toHaveBeenCalledOnce();
      expect(runStartupSessionMigration).toHaveBeenCalledOnce();
    });

    channelDeferred.resolve();
    migrationDeferred.resolve();
    await bootstrapPromise;
  });

  it("logs deferred startup maintenance failures in fast gateway mode", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_FAST_CONFIG", "1");
    runChannelPluginStartupMaintenance.mockRejectedValueOnce(new Error("channels boom"));
    const log = createLog();
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");

    await prepareGatewayPluginBootstrap({
      cfgAtStart: {} as OpenClawConfig,
      startupRuntimeConfig: {} as OpenClawConfig,
      minimalTestGateway: false,
      log,
    });

    await vi.waitFor(() => {
      expect(log.warn).toHaveBeenCalledWith(
        "channel plugin startup maintenance failed during deferred fast startup: Error: channels boom",
      );
    });
  });

  it("waits for startup maintenance before plugin loading in normal mode", async () => {
    const channelDeferred = createDeferred();
    const migrationDeferred = createDeferred();
    runChannelPluginStartupMaintenance.mockReturnValueOnce(channelDeferred.promise);
    runStartupSessionMigration.mockReturnValueOnce(migrationDeferred.promise);
    const log = createLog();
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");
    let settled = false;
    const bootstrapPromise = prepareGatewayPluginBootstrap({
      cfgAtStart: {} as OpenClawConfig,
      startupRuntimeConfig: {} as OpenClawConfig,
      minimalTestGateway: false,
      log,
    }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(loadGatewayStartupPlugins).not.toHaveBeenCalled();

    channelDeferred.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(loadGatewayStartupPlugins).not.toHaveBeenCalled();

    migrationDeferred.resolve();
    await bootstrapPromise;

    expect(loadGatewayStartupPlugins).toHaveBeenCalledOnce();
  });
});
