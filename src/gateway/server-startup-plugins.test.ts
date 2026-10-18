import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { createFixture } from "../plugins/plugin-generation-artifact.admission.test-support.js";
import { capturePluginGenerationArtifact } from "../plugins/plugin-generation-artifact.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { preparePluginNativeAdmissions } from "../plugins/plugin-native-admission-state.js";
import * as sourceAdmissionStore from "../plugins/plugin-source-admission-store.js";
import type { ProviderPolicySurface } from "../plugins/provider-policy-surface.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { capturePluginLifecycleAuthority } from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

type PluginLoadParams = Parameters<
  typeof import("./server-plugin-bootstrap.js").prepareGatewayPluginLoad
>[0];
const makeLoadedRuntime = vi.hoisted(
  () =>
    (cfg: OpenClawConfig, pluginRegistry = createEmptyPluginRegistry()) => ({
      pluginRegistry,
      gatewayMethods: ["ping"],
      resolvedConfig: cfg,
      retireGatewayRuntimeBindings: vi.fn(),
    }),
);
const applyPluginAutoEnable = vi.hoisted(() =>
  vi.fn((params: { config: unknown }) => ({
    config: params.config,
    changes: [] as string[],
    autoEnabledReasons: {} as Record<string, string[]>,
  })),
);
const getActivePluginRegistry = vi.hoisted(() => vi.fn<() => PluginRegistry | undefined>());
const setActivePluginRegistry = vi.hoisted(() => vi.fn());
const resolveProviderPolicySurfaceForOwner = vi.hoisted(() =>
  vi.fn<(owner: PluginManifestRecord) => ProviderPolicySurface | null>(() => null),
);
const prepareGatewayPluginLoad = vi.hoisted(() =>
  vi.fn((params: PluginLoadParams) => makeLoadedRuntime(params.cfg)),
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
const pluginMetadataSnapshot = await vi.hoisted(async (): Promise<PluginMetadataSnapshot> => {
  const { createEmptyPluginMetadataSnapshot } =
    await import("../plugins/plugin-metadata-empty.test-support.js");
  const snapshot = createEmptyPluginMetadataSnapshot();
  Object.assign(snapshot.index, { policyHash: "policy", generatedAtMs: 0 });
  return {
    ...snapshot,
    policyHash: "policy",
    manifestRegistry: pluginManifestRegistry,
    bundledManifestRegistry: pluginManifestRegistry,
  };
});
const pluginLookUpTableMetrics = vi.hoisted(() => ({
  ...pluginMetadataSnapshot.metrics,
  startupPlanMs: 0,
  startupPluginCount: 1,
}));
const makePluginLookup = vi.hoisted(
  () =>
    (pluginIds = ["telegram"], manifestRegistry = pluginManifestRegistry) => ({
      ...pluginMetadataSnapshot,
      manifestRegistry,
      startup: { pluginIds, channelPluginIds: [...pluginIds] },
      metrics: pluginLookUpTableMetrics,
    }),
);
const loadPluginLookUpTable = vi.hoisted(() => vi.fn((_params: unknown) => makePluginLookup()));
const resolveOpenClawPackageRootSync = vi.hoisted(() => vi.fn((_params: unknown) => "/package"));
const runChannelPluginStartupMaintenance = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => undefined),
);
const listAmbientOnlyConfiguredChannelIds = vi.hoisted(() =>
  vi.fn((_params: { manifestRecords?: readonly PluginManifestRecord[] }) => [] as string[]),
);
const runGatewaySessionStartupMaintenance = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => undefined),
);
const listLegacyPairingStoreFiles = vi.hoisted(() => vi.fn(async () => [] as string[]));
const refreshPluginRegistryAfterConfigMutation = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => "/workspace",
  resolveDefaultAgentId: () => "default",
  tryResolveConfiguredAgentWorkspaceDir: () => "/workspace",
  tryResolveSystemAgentWorkspaceDir: () => "/workspace",
}));

vi.mock("../agents/workspace-state-dirs.js", () => ({
  assertConfiguredWorkspaceStateReady: () => {},
}));

vi.mock("../channels/plugins/lifecycle-startup.js", () => ({
  runChannelPluginStartupMaintenance,
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable,
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync,
}));

vi.mock("../infra/device-pairing-node-desktop-migration.js", () => ({
  migrateLegacyDesktopStreamOptOuts: async () => 0,
}));

vi.mock("../infra/pairing-files.js", () => ({
  listLegacyPairingStoreFiles,
}));

vi.mock("../plugins/channel-presence-policy.js", () => ({
  listAmbientOnlyConfiguredChannelIds,
}));

vi.mock("../plugins/plugin-lookup-table.js", () => ({
  loadPluginLookUpTable,
}));

vi.mock("../plugins/registry.js", () => import("../plugins/registry-empty.js"));

vi.mock("../plugins/registry-refresh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/registry-refresh.js")>()),
  refreshPluginRegistryAfterConfigMutation,
}));

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

// mock-isolation: Maintenance composition uses a controlled session repair lifetime.
vi.mock("./server-startup-session-migration.js", () => ({
  runGatewaySessionStartupMaintenance,
}));

function createLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function slackConfig(): OpenClawConfig {
  return { channels: { slack: { enabled: true, token: "token" } } } as OpenClawConfig;
}

async function prepareBootstrapWithRuntimeConfig(
  cfg: OpenClawConfig,
  options: {
    minimalTestGateway?: boolean;
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
    workerProviderIds?: readonly string[];
    ambientEnvTriggers?: "suppress";
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

describe("runGatewayPostReadyStartupMaintenance", () => {
  beforeEach(() => {
    runChannelPluginStartupMaintenance.mockClear();
    runGatewaySessionStartupMaintenance.mockReset().mockResolvedValue(undefined);
    listLegacyPairingStoreFiles.mockReset().mockResolvedValue([]);
    refreshPluginRegistryAfterConfigMutation.mockReset().mockResolvedValue(undefined);
  });

  it("joins admitted registry refresh when the Gateway closes during maintenance", async () => {
    await withOpenClawTestState({ label: "startup-registry-maintenance" }, async () => {
      const { runGatewayPostReadyStartupMaintenance } = await import("./server-startup-plugins.js");
      const started = createDeferred();
      const release = createDeferred();
      const controller = new AbortController();
      refreshPluginRegistryAfterConfigMutation.mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
      });
      const log = createLog();
      let settled = false;
      const maintenance = runGatewayPostReadyStartupMaintenance({
        getConfig: () => ({}),
        getPluginRegistry: createEmptyPluginRegistry,
        pluginMetadataSnapshot: { registrySource: "derived" },
        databases: [],
        signal: controller.signal,
        log,
      }).finally(() => {
        settled = true;
      });
      try {
        expect(
          await Promise.race([
            started.promise.then(() => "started"),
            maintenance.then(() => "completed"),
          ]),
        ).toBe("started");
        controller.abort(new Error("Gateway closing"));
        await Promise.resolve();
        expect(settled).toBe(false);
      } finally {
        release.resolve();
        await maintenance;
      }
      expect(log.warn).not.toHaveBeenCalled();
    });
  });

  it("reports nested session repair failures while completing the other maintenance owners", async () => {
    const log = createLog();
    const { runGatewayPostReadyStartupMaintenance } = await import("./server-startup-plugins.js");
    const cfg = slackConfig();
    runGatewaySessionStartupMaintenance.mockRejectedValueOnce(
      new Error("synthetic repair failure", {
        cause: Object.assign(new Error("synthetic storage failure"), { code: "SQLITE_BUSY" }),
      }),
    );
    listLegacyPairingStoreFiles.mockResolvedValueOnce(["synthetic-pairing.json"]);
    await runGatewayPostReadyStartupMaintenance({
      getConfig: () => cfg,
      getPluginRegistry: createEmptyPluginRegistry,
      databases: [],
      signal: new AbortController().signal,
      log,
    });
    expect(runChannelPluginStartupMaintenance).toHaveBeenCalledWith({ cfg, env: process.env, log });
    expect(log.warn).toHaveBeenCalledWith(
      "Gateway post-ready sessions maintenance failed: synthetic repair failure | synthetic storage failure | SQLITE_BUSY",
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("synthetic-pairing.json"));
  });

  it("does not start maintenance after its Gateway lifetime closes", async () => {
    const { runGatewayPostReadyStartupMaintenance } = await import("./server-startup-plugins.js");
    const controller = new AbortController();
    controller.abort();
    const log = createLog();
    await runGatewayPostReadyStartupMaintenance({
      getConfig: () => ({}),
      getPluginRegistry: createEmptyPluginRegistry,
      pluginMetadataSnapshot: { registrySource: "derived" },
      databases: [],
      signal: controller.signal,
      log,
    });
    expect(runChannelPluginStartupMaintenance).not.toHaveBeenCalled();
    expect(runGatewaySessionStartupMaintenance).not.toHaveBeenCalled();
    expect(listLegacyPairingStoreFiles).not.toHaveBeenCalled();
    expect(refreshPluginRegistryAfterConfigMutation).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("prepareGatewayPluginBootstrap startup plugins", () => {
  beforeEach(() => {
    getActivePluginRegistry.mockReset();
    setActivePluginRegistry.mockClear();
    applyPluginAutoEnable.mockClear();
    prepareGatewayPluginLoad.mockClear();
    listAmbientOnlyConfiguredChannelIds.mockClear().mockReturnValue([]);
    loadPluginLookUpTable.mockClear().mockReturnValue(makePluginLookup());
    resolveOpenClawPackageRootSync.mockClear().mockReturnValue("/package");
    runChannelPluginStartupMaintenance.mockClear();
    runGatewaySessionStartupMaintenance.mockClear();
    listLegacyPairingStoreFiles.mockReset().mockResolvedValue([]);
  });
  it("does not run startup maintenance", async () => {
    await prepareBootstrapWithRuntimeConfig({});

    expect(runChannelPluginStartupMaintenance).not.toHaveBeenCalled();
    expect(runGatewaySessionStartupMaintenance).not.toHaveBeenCalled();
    expect(listLegacyPairingStoreFiles).not.toHaveBeenCalled();
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
    { minimalTestGateway: false, pluginsEnabled: false, reuseAmbientRegistry: false },
  ])(
    "keeps the pre-bind registry local without runtime loading (minimal=$minimalTestGateway, enabled=$pluginsEnabled)",
    async ({ minimalTestGateway, pluginsEnabled, reuseAmbientRegistry }) => {
      const { capturePluginRegistryLifecycleEpoch, markPluginRegistryActive } =
        await import("../plugins/registry-lifecycle.js");
      const ambientRegistry = createEmptyPluginRegistry();
      ambientRegistry.gatewayHandlers.fixture = vi.fn<GatewayRequestHandler>();
      markPluginRegistryActive(ambientRegistry);
      const ambientEpoch = capturePluginRegistryLifecycleEpoch(ambientRegistry);
      getActivePluginRegistry.mockReturnValue(ambientRegistry);

      const disabled = !minimalTestGateway && pluginsEnabled === false;
      const cfg: OpenClawConfig = disabled
        ? {
            channels: { telegram: { botToken: "token" } },
            plugins: {
              enabled: false,
              allow: ["telegram"],
              entries: { telegram: { enabled: true } },
            },
          }
        : { ...slackConfig(), plugins: { enabled: pluginsEnabled } };
      const result = await prepareBootstrapWithRuntimeConfig(cfg, {
        minimalTestGateway,
        ...(disabled ? { pluginMetadataSnapshot, workerProviderIds: ["static-ssh"] } : {}),
      });

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
      if (disabled) {
        expect(result).toMatchObject({ startupPluginIds: [], baseGatewayMethods: ["ping"] });
        expect(result.pluginMetadataSnapshot).toBe(pluginMetadataSnapshot);
        expect(result.pluginLookUpTable).toBeUndefined();
        expect(loadPluginLookUpTable).not.toHaveBeenCalled();
      }
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
      ...makePluginLookup([], emptyManifestRegistry),
      bundledManifestRegistry: emptyManifestRegistry,
    });

    const result = await prepareBootstrapWithRuntimeConfig(
      { channels: {} },
      { ambientEnvTriggers: "suppress" },
    );

    expect(result.pluginManifestRecords).toBe(emptyManifestRegistry.plugins);
    expect(listAmbientOnlyConfiguredChannelIds.mock.calls[0]?.[0].manifestRecords).toBe(
      emptyManifestRegistry.plugins,
    );
  });
});

describe("loadGatewayStartupPluginRuntime", () => {
  beforeEach(() => {
    resolveProviderPolicySurfaceForOwner.mockReset().mockReturnValue(null);
    prepareGatewayPluginLoad
      .mockReset()
      .mockImplementation((params) => makeLoadedRuntime(params.cfg));
  });

  it("returns admitted plugins while native receipt persistence remains owned by cache cleanup", async () => {
    await withOpenClawTestState({ label: "startup-native-receipt" }, async (state) => {
      const fixture = createFixture(state.path("installed"), true);
      await writePersistedInstalledPluginIndex(fixture.index, { stateDir: state.stateDir });
      const cache = createPluginCache();
      const publication = createDeferred();
      let publicationStarted = false;
      let publicationFinished = false;
      const createPublisher = sourceAdmissionStore.createPluginSourceAdmissionPublisher;
      const publisher = vi
        .spyOn(sourceAdmissionStore, "createPluginSourceAdmissionPublisher")
        .mockImplementation((options) => {
          const publish = createPublisher(options);
          return publish
            ? async (receipt) => {
                publicationStarted = true;
                await publication.promise;
                const accepted = await publish(receipt);
                publicationFinished = true;
                return accepted;
              }
            : undefined;
        });
      preparePluginNativeAdmissions(fixture.index, cache);
      const artifact = withPluginCache(cache, () => capturePluginGenerationArtifact(fixture.root));
      const { loadGatewayStartupPluginRuntime } = await import("./server-startup-plugins.js");
      let retirement: ReturnType<typeof retirePluginCache> | undefined;
      try {
        expect(publicationStarted).toBe(true);
        vi.useFakeTimers();
        let loaded: Awaited<ReturnType<typeof loadGatewayStartupPluginRuntime>> | undefined;
        const startup = withPluginCache(cache, () =>
          loadGatewayStartupPluginRuntime({
            cfg: {},
            log: createLog(),
            baseMethods: ["ping"],
            startupPluginIds: ["fixture"],
          }),
        ).then((result) => {
          loaded = result;
        });
        await vi.runAllTimersAsync();
        expect(loaded?.gatewayMethods).toEqual(["ping"]);
        expect(publicationFinished).toBe(false);
        await startup;

        let retired = false;
        retirement = retirePluginCache(cache).then((result) => {
          retired = true;
          return result;
        });
        await vi.runAllTimersAsync();
        expect(retired).toBe(false);
        vi.useRealTimers();
        publication.resolve();
        await retirement;
        expect(publicationFinished).toBe(true);
        await using reader = createPluginCache();
        const persisted = await withPluginCache(reader, () =>
          readPersistedInstalledPluginIndex({ stateDir: state.stateDir }),
        );
        expect(Object.keys(persisted?.plugins[0]?.sourceAdmissions ?? {})).toHaveLength(1);
      } finally {
        vi.useRealTimers();
        publication.resolve();
        publisher.mockRestore();
        await artifact.disposeAsync();
        await (retirement ?? retirePluginCache(cache));
      }
    });
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
        ...makeLoadedRuntime(config, registry),
        gatewayMethods: [],
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
      cfg: { memory: { search: { provider: "voyage" } }, agents: { defaults: {} } },
      workspaceDir: "/workspace",
      log,
      baseMethods: ["ping"],
      startupPluginIds: ["voyage"],
    });
    expect(prepareGatewayPluginLoad.mock.calls[0]?.[0]).toMatchObject({
      channelPluginLoadIntent: "full",
      loadIntent: "startup",
    });
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
        agents: { entries: { main: { memory: { search: { enabled: false } } }, helper: {} } },
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
      prepareGatewayPluginLoad.mockReturnValueOnce(makeLoadedRuntime(cfg, registry));
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
