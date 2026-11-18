/**
 * Gateway startup plugin bootstrap tests.
 */
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInfoWarnErrorDebugLogger as createLog } from "../../test/helpers/mock-logger.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
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

const applyPluginAutoEnable = vi.hoisted(() =>
  vi.fn((params: { config?: OpenClawConfig }) => ({
    config: params.config ?? {},
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
const { createEmptyPluginMetadataSnapshot } = await vi.hoisted(
  () => import("../plugins/plugin-metadata-empty.test-support.js"),
);
const pluginMetadataSnapshot = vi.hoisted((): PluginMetadataSnapshot => {
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
const loadPluginLookUpTable = vi.hoisted(() =>
  vi.fn((_params: unknown) => ({
    ...pluginMetadataSnapshot,
    startup: {
      pluginIds: ["telegram"] as string[],
      channelPluginIds: ["telegram"] as string[],
    },
    workerProviderIds: [],
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

vi.mock(import("../channels/plugins/lifecycle-startup.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  runChannelPluginStartupMaintenance,
}));

vi.mock(import("../config/plugin-auto-enable.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  applyPluginAutoEnable,
}));

vi.mock(import("../infra/openclaw-root.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  resolveOpenClawPackageRootSync,
}));

vi.mock("../infra/device-pairing-node-desktop-migration.js", () => ({
  migrateLegacyDesktopStreamOptOuts: async () => 0,
}));

vi.mock(import("../infra/pairing-files.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  listLegacyPairingStoreFiles,
}));

vi.mock(import("../plugins/channel-presence-policy.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  listAmbientOnlyConfiguredChannelIds,
}));

vi.mock(import("../plugins/plugin-lookup-table.js"), async (importOriginal) => ({
  ...(await importOriginal()),
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

function firstCallArg<T>(mock: { mock: { calls: unknown[][] } }, _type?: (value: T) => T): T {
  return expectDefined(mock.mock.calls.at(0), "Expected first mock call")[0] as T;
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
    loadPluginLookUpTable.mockReset();
    resolveOpenClawPackageRootSync.mockClear().mockReturnValue("/package");
    runChannelPluginStartupMaintenance.mockClear();
    runGatewaySessionStartupMaintenance.mockClear();
    listLegacyPairingStoreFiles.mockReset().mockResolvedValue([]);
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
      workerProviderIds: ["static-ssh"],
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
      workerProviderIds?: readonly string[];
    }>(loadPluginLookUpTable);
    expect(lookupInput.activationSourceConfig).toBe(sourceConfig);
    expect(lookupInput.metadataSnapshot).toBe(pluginMetadataSnapshot);
    expect(lookupInput.workerProviderIds).toEqual(["static-ssh"]);
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
    expect(runChannelPluginStartupMaintenance).not.toHaveBeenCalled();
    expect(runGatewaySessionStartupMaintenance).not.toHaveBeenCalled();
    expect(listLegacyPairingStoreFiles).not.toHaveBeenCalled();
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
      ambientRegistry.gatewayHandlers.fixture = vi.fn<GatewayRequestHandler>();
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
      workerProviderIds: [],
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
    const cfg: OpenClawConfig = {
      ...slackConfig(),
      plugins: {
        enabled: false,
        allow: ["slack"],
        entries: {
          slack: { enabled: true },
        },
      },
    };

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
        const loaded = await withPluginCache(cache, () =>
          loadGatewayStartupPluginRuntime({
            cfg: {},
            log: createLog(),
            baseMethods: ["ping"],
            startupPluginIds: ["fixture"],
          }),
        );
        expect(loaded.gatewayMethods).toEqual(["ping"]);
        expect(publicationFinished).toBe(false);
        vi.useFakeTimers();
        const retired = vi.fn();
        retirement = retirePluginCache(cache).finally(retired);
        await vi.runAllTimersAsync();
        expect(retired).not.toHaveBeenCalled();
        vi.useRealTimers();
        publication.resolve();
        await retirement;
        expect(publicationFinished).toBe(true);
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
      },
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

  it.each(["ready", "inspection failed", "inspection stalled"] as const)(
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
      expect(resolveProviderPolicySurfaceForOwner).toHaveBeenCalledExactlyOnceWith(registeredOwner);
      expect(disabledPolicy.inspectEmbeddingProviderSetup).not.toHaveBeenCalled();
      if (outcome === "inspection stalled") {
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
  it.each([
    ["openai", "ollama", ["openai"], "ollama"],
    ["openai", "ollama", ["openai", "ollama"], undefined],
    ["openai-compatible", undefined, [], undefined],
    ["openai", "ollama-5080", ["openai", "ollama"], undefined],
    ["openai", "ollama-5080", ["openai"], "ollama-5080"],
  ] as const)(
    "reports configured embedding availability (provider=%s, fallback=%s, registered=%j)",
    async (provider, fallback, providerIds, missing) => {
      const { warnUnregisteredConfiguredMemoryEmbeddingProviders } =
        await import("./server-startup-plugins.js");
      const config: OpenClawConfig = {
        memory: { search: { provider, fallback } },
        agents: { defaults: {} },
        models:
          fallback === "ollama-5080"
            ? {
                providers: {
                  "ollama-5080": {
                    api: "ollama",
                    baseUrl: "http://gpu-box.local:11435",
                    models: [],
                  },
                },
              }
            : undefined,
      };
      const log = createLog();
      warnUnregisteredConfiguredMemoryEmbeddingProviders({
        config,
        pluginRegistry: {
          embeddingProviders: providerIds.map((id) => ({
            pluginId: id,
            source: "synthetic-embedding-provider",
            provider: { id, create: async () => ({ provider: null }) },
          })),
        },
        log,
      });
      expect(log.warn).toHaveBeenCalledTimes(missing ? 1 : 0);
      if (missing) {
        expect(String(log.warn.mock.calls[0]?.[0])).toContain(
          `memory.search.fallback="${missing}"`,
        );
      }
    },
  );
});
