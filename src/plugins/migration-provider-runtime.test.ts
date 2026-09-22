// Covers migration provider runtime hooks supplied by plugins.
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRuntimeStore } from "../plugin-sdk/runtime-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createPluginRecord } from "./loader-records.js";
import { getPluginInstance, getPluginValueInstance } from "./plugin-instance-scope.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import { createEmptyPluginRegistry, createPluginRegistry } from "./registry.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { MigrationPlan, MigrationProviderContext } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type MockManifestRegistry = {
  plugins: Array<Record<string, unknown>>;
  diagnostics: unknown[];
};

type MockPluginIndex = {
  plugins: Array<{
    pluginId: string;
    origin: string;
    enabled: boolean;
    enabledByDefault?: boolean;
  }>;
  diagnostics: unknown[];
};

type MockPluginSnapshotLoadParams = {
  index?: MockPluginIndex;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

function createEmptyMockManifestRegistry(): MockManifestRegistry {
  return { plugins: [], diagnostics: [] };
}

function createMockPluginIndex(plugins: MockPluginIndex["plugins"]): MockPluginIndex {
  return { plugins, diagnostics: [] };
}

const mocks = vi.hoisted(() => ({
  resolveRuntimePluginRegistry: vi.fn<(params?: unknown) => PluginRegistry | undefined>(
    () => undefined,
  ),
  loadPluginManifestRegistry: vi.fn<(params?: Record<string, unknown>) => MockManifestRegistry>(
    () => createEmptyMockManifestRegistry(),
  ),
  loadPluginRegistrySnapshot: vi.fn<(_params?: unknown) => MockPluginIndex>(() =>
    createMockPluginIndex([]),
  ),
  loadPluginRegistrySnapshotWithMetadata: vi.fn((params?: MockPluginSnapshotLoadParams) => ({
    source: params?.index ? "provided" : "derived",
    snapshot: params?.index ?? createMockPluginIndex([]),
    diagnostics: [],
  })),
  acquirePluginRegistryForInspection: vi.fn(),
  release: vi.fn(async () => {}),
  listBundledPluginMetadata: vi.fn<
    typeof import("./bundled-plugin-metadata.js").listBundledPluginMetadata
  >(() => []),
}));

vi.mock("./loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./loader.js")>()),
  resolveRuntimePluginRegistry: mocks.resolveRuntimePluginRegistry,
  acquirePluginRegistryForInspection: mocks.acquirePluginRegistryForInspection,
}));

vi.mock("./active-runtime-registry.js", () => ({
  getLoadedRuntimePluginRegistry: (params?: { requiredPluginIds?: string[] }) => {
    if (params === undefined) {
      return mocks.resolveRuntimePluginRegistry();
    }
    return mocks.resolveRuntimePluginRegistry({
      onlyPluginIds: params.requiredPluginIds,
    });
  },
}));

vi.mock("./plugin-registry-snapshot.js", () => ({
  loadPluginRegistrySnapshot: mocks.loadPluginRegistrySnapshot,
  loadPluginRegistrySnapshotWithMetadata: mocks.loadPluginRegistrySnapshotWithMetadata,
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (params: { config?: OpenClawConfig; env?: NodeJS.ProcessEnv }) => {
    const loaded = mocks.loadPluginRegistrySnapshotWithMetadata(params);
    const manifestRegistry = mocks.loadPluginManifestRegistry({
      index: loaded.snapshot,
      config: params.config,
      env: params.env,
      includeDisabled: true,
    });
    return {
      index: loaded.snapshot,
      plugins: manifestRegistry.plugins,
    };
  },
}));

vi.mock("./manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex: mocks.loadPluginManifestRegistry,
  resolveInstalledManifestRegistryIndexFingerprint: () => "test-installed-index",
}));

vi.mock("./bundled-plugin-metadata.js", () => ({
  listBundledPluginMetadata: mocks.listBundledPluginMetadata,
}));

let withPluginMigrationProviders: typeof import("./migration-provider-runtime.js").withPluginMigrationProviders;

function createMigrationProvider(id: string) {
  return {
    id,
    label: id,
    plan: vi.fn(),
    apply: vi.fn(),
  };
}

function createOwnedMigrationRegistry(
  pluginId: string,
  provider: ReturnType<typeof createMigrationProvider>,
  initialize?: () => void,
) {
  const builder = createPluginRegistry({
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
    logger: { info() {}, warn() {}, error() {} },
  });
  const { registry } = builder;
  const record = createPluginRecord({
    id: pluginId,
    source: `/plugins/${pluginId}/index.js`,
    origin: "config",
    enabled: true,
    configSchema: false,
  });
  const api = builder.createApi(record, { config: {} });
  runPluginRegisterSyncInRegistry(
    (registeredApi) => {
      initialize?.();
      registeredApi.registerMigrationProvider(provider);
    },
    api,
    registry,
    pluginId,
  );
  registry.plugins.push(record);
  const instance = expectDefined(getPluginInstance(record), "migration provider instance");
  const release = async () => {
    await instance.dispose();
  };
  mocks.release.mockImplementation(release);
  onTestFinished(release);
  return registry;
}

function requireMockCallArg(
  mockFn: { mock: { calls: unknown[][] } },
  label: string,
  index = 0,
): Record<string, unknown> {
  const arg = mockFn.mock.calls[index]?.[0] as Record<string, unknown> | undefined;
  if (!arg) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return arg;
}

describe("migration provider runtime", () => {
  beforeEach(async () => {
    clearPluginMetadataLifecycleCaches();
    vi.resetModules();
    vi.clearAllMocks();
    mocks.resolveRuntimePluginRegistry.mockReturnValue(undefined);
    mocks.loadPluginManifestRegistry.mockReturnValue(createEmptyMockManifestRegistry());
    mocks.loadPluginRegistrySnapshot.mockReturnValue(createMockPluginIndex([]));
    mocks.acquirePluginRegistryForInspection.mockResolvedValue({
      registry: createEmptyPluginRegistry(),
      release: mocks.release,
    });
    mocks.listBundledPluginMetadata.mockReturnValue([]);
    mocks.loadPluginRegistrySnapshotWithMetadata.mockImplementation(
      (params?: MockPluginSnapshotLoadParams) => ({
        source: params?.index ? "provided" : "derived",
        snapshot: params?.index ?? mocks.loadPluginRegistrySnapshot(),
        diagnostics: [],
      }),
    );
    const runtime = await import("./migration-provider-runtime.js");
    withPluginMigrationProviders = runtime.withPluginMigrationProviders;
  });

  it.each(["active provider", "loaded registry", "acquired registry"] as const)(
    "retains managed migration execution through %s",
    async (route) => {
      const provider = createMigrationProvider("managed-import");
      const store = createPluginRuntimeStore<{ plan: MigrationPlan }>("migration runtime missing");
      const runtime = {
        plan: {
          providerId: provider.id,
          source: "fixture",
          items: [],
          summary: {
            total: 0,
            planned: 0,
            migrated: 0,
            skipped: 0,
            conflicts: 0,
            errors: 0,
            sensitive: 0,
          },
        },
      };
      const registry = createOwnedMigrationRegistry("managed-migration", provider, () =>
        store.setRuntime(runtime),
      );
      const owner = expectDefined(getPluginValueInstance(provider), "registered provider owner");
      expect(registry.migrationProviders[0]?.provider).toBe(provider);
      createOwnedMigrationRegistry("managed-migration", provider, () =>
        store.setRuntime({ plan: { ...runtime.plan, source: "another instance" } }),
      );
      const otherOwner = expectDefined(getPluginValueInstance(provider), "other provider owner");
      mocks.release.mockImplementation(async () => {
        await owner.dispose();
      });
      expect(store.tryGetRuntime()).toBeNull();
      mocks.loadPluginRegistrySnapshot.mockReturnValue(
        createMockPluginIndex([
          { pluginId: "managed-migration", origin: "installed", enabled: true },
        ]),
      );
      mocks.loadPluginManifestRegistry.mockReturnValue({
        plugins: [
          {
            id: "managed-migration",
            origin: "installed",
            contracts: { migrationProviders: [provider.id] },
          },
        ],
        diagnostics: [],
      });
      mocks.resolveRuntimePluginRegistry.mockReturnValue(
        route === "acquired registry" ? undefined : registry,
      );
      mocks.acquirePluginRegistryForInspection.mockResolvedValue({
        registry,
        release: mocks.release,
      });
      const context: MigrationProviderContext = {
        config: {},
        stateDir: tempDirs.make("openclaw-managed-migration-"),
        logger: { info() {}, warn() {}, error() {} },
      };
      provider.plan.mockImplementation(() => {
        const current = store.getRuntime();
        expect(current).toBe(runtime);
        expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
        return current.plan;
      });
      const resume = createDeferredCore();
      try {
        await withPluginMigrationProviders(
          route === "active provider" ? { providerId: provider.id } : {},
          async (providers) => {
            const selected = expectDefined(
              providers.find((entry) => entry.id === provider.id),
              "managed migration provider",
            );
            const retainedPlan = selected.plan;
            expect(retainedPlan(context)).toBe(runtime.plan);
            await otherOwner.dispose();
            expect(retainedPlan(context)).toBe(runtime.plan);
            provider.plan.mockImplementationOnce(async () => {
              await resume.promise;
              expect(store.getRuntime()).toBe(runtime);
              expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
              return runtime.plan;
            });
            const pending = selected.plan(context);
            const cleaned = vi.fn();
            const retirement = owner.dispose().then(cleaned);
            await Promise.resolve();
            expect(cleaned).not.toHaveBeenCalled();
            expect(() => retainedPlan(context)).toThrow("reloaded or disabled");
            resume.resolve();
            await expect(pending).resolves.toBe(runtime.plan);
            await retirement;
            expect(cleaned).toHaveBeenCalledOnce();
            expect(() => retainedPlan(context)).toThrow("reloaded or disabled");
          },
        );
        expect(mocks.acquirePluginRegistryForInspection).toHaveBeenCalledTimes(
          route === "acquired registry" ? 1 : 0,
        );
      } finally {
        resume.resolve();
        await owner.dispose();
      }
    },
  );

  it.each([
    { origin: "global", policy: "enabled", allowed: true },
    { origin: "global", policy: "disabled", allowed: false },
    { origin: "global", policy: "denied", allowed: false },
    { origin: "bundled", policy: "enabled", allowed: true },
    { origin: "bundled", policy: "disabled", allowed: false },
    { origin: "bundled", policy: "denied", allowed: false },
  ] as const)(
    "enforces $policy owner policy before executing a $origin public artifact",
    async ({ origin, policy, allowed }) => {
      const scanDir = tempDirs.make("openclaw-migration-artifact-");
      const rootDir = path.join(scanDir, "fixture-dir");
      const executedPath = path.join(scanDir, "artifact-executed");
      fs.mkdirSync(rootDir);
      fs.writeFileSync(
        path.join(rootDir, "package.json"),
        JSON.stringify({
          name: "@openclaw/fixture",
          version: "1.0.0",
          type: "module",
          openclaw: { extensions: ["./index.js"] },
        }),
      );
      fs.writeFileSync(
        path.join(rootDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: "fixture",
          contracts: { migrationProviders: ["fixture-import"] },
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        }),
      );
      fs.writeFileSync(
        path.join(rootDir, "index.js"),
        'throw new Error("Heavy plugin runtime loaded");',
      );
      fs.writeFileSync(
        path.join(rootDir, "migration-provider-api.js"),
        `
        import fs from "node:fs";
        fs.writeFileSync(${JSON.stringify(executedPath)}, "executed");
        export function buildMigrationProvider() {
          return { id: "fixture-import", label: "Fixture public owner",
            plan: async () => ({ providerId: "fixture-import", source: "fixture", items: [],
              summary: { total: 0, planned: 0, migrated: 0, skipped: 0, conflicts: 0, errors: 0, sensitive: 0 } }),
            apply: async (_ctx, plan) => plan };
        }
      `,
      );
      const { listBundledPluginMetadata } = await vi.importActual<
        typeof import("./bundled-plugin-metadata.js")
      >("./bundled-plugin-metadata.js");
      const bundled = listBundledPluginMetadata({ scanDir, includeChannelConfigs: false });
      mocks.listBundledPluginMetadata.mockReturnValue(bundled);
      const active = createEmptyPluginRegistry();
      mocks.resolveRuntimePluginRegistry.mockReturnValue(active);
      if (origin === "global") {
        mocks.loadPluginRegistrySnapshot.mockReturnValue(
          createMockPluginIndex([{ pluginId: "fixture", origin, enabled: true }]),
        );
        mocks.loadPluginManifestRegistry.mockReturnValue({
          diagnostics: [],
          plugins: [
            {
              id: "fixture",
              origin,
              rootDir,
              contracts: { migrationProviders: ["fixture-import"] },
            },
          ],
        });
      }
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", scanDir);
      try {
        const label = await withPluginMigrationProviders(
          {
            providerId: "fixture-import",
            cfg: {
              plugins: {
                entries: { fixture: { enabled: policy !== "disabled" } },
                ...(policy === "denied" ? { deny: ["fixture"] } : {}),
              },
            },
          },
          async (providers) =>
            providers.find((provider) => provider.id === "fixture-import")?.label,
        );
        expect(label).toBe(allowed ? "Fixture public owner" : undefined);
        expect(fs.existsSync(executedPath)).toBe(allowed);
        expect(mocks.acquirePluginRegistryForInspection).not.toHaveBeenCalled();
        expect(active.migrationProviders).toEqual([]);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("loads bundled migration providers through compat config", async () => {
    mocks.loadPluginRegistrySnapshot.mockReturnValue(
      createMockPluginIndex([
        {
          pluginId: "migrate-hermes",
          origin: "bundled",
          enabled: true,
        },
      ]),
    );
    mocks.loadPluginManifestRegistry.mockImplementation(() => ({
      diagnostics: [],
      plugins: [
        {
          id: "migrate-hermes",
          origin: "bundled",
          contracts: { migrationProviders: ["hermes"] },
        },
      ],
    }));

    await withPluginMigrationProviders({ cfg: { plugins: { enabled: false } } }, async () => {});

    const standaloneParams = requireMockCallArg(
      mocks.acquirePluginRegistryForInspection,
      "acquirePluginRegistryForInspection",
    ) as {
      onlyPluginIds?: unknown;
      config?: OpenClawConfig;
    };
    expect(standaloneParams.onlyPluginIds).toEqual(["migrate-hermes"]);
    expect(standaloneParams.config?.plugins?.enabled).toBe(true);
    expect(standaloneParams.config?.plugins?.entries).toEqual({
      "migrate-hermes": { enabled: true },
    });
  });

  it("discovers bundled migration contracts missing from a pruned persisted index", async () => {
    mocks.listBundledPluginMetadata.mockReturnValue([
      {
        manifest: {
          id: "migrate-hermes",
          contracts: { migrationProviders: ["hermes"] },
        },
        dirName: "missing-migration-fixture",
      },
    ] as never);

    await withPluginMigrationProviders({ providerId: "hermes" }, async () => {});

    const standaloneParams = requireMockCallArg(
      mocks.acquirePluginRegistryForInspection,
      "acquirePluginRegistryForInspection",
    );
    expect(standaloneParams.onlyPluginIds).toEqual(["migrate-hermes"]);
  });

  it("loads configured external migration-provider plugins from manifest contracts", async () => {
    const cfg = {
      plugins: {
        entries: {
          "external-migration": { enabled: true },
          "disabled-external-migration": { enabled: false },
        },
      },
    } as OpenClawConfig;
    const provider = createMigrationProvider("external-import");
    const active = createEmptyPluginRegistry();
    const loaded = createOwnedMigrationRegistry("external-migration", provider);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : undefined,
    );
    mocks.acquirePluginRegistryForInspection.mockResolvedValue({
      registry: loaded,
      release: mocks.release,
    });
    mocks.loadPluginRegistrySnapshot.mockReturnValue(
      createMockPluginIndex([
        {
          pluginId: "external-migration",
          origin: "installed",
          enabled: true,
        },
        {
          pluginId: "disabled-external-migration",
          origin: "installed",
          enabled: false,
        },
      ]),
    );
    mocks.loadPluginManifestRegistry.mockImplementation((params?: Record<string, unknown>) => ({
      diagnostics: [],
      plugins: params?.includeDisabled
        ? [
            {
              id: "external-migration",
              origin: "installed",
              contracts: { migrationProviders: ["external-import"] },
            },
            {
              id: "disabled-external-migration",
              origin: "installed",
              contracts: { migrationProviders: ["external-import"] },
            },
          ]
        : [
            {
              id: "external-migration",
              origin: "installed",
              contracts: { migrationProviders: ["external-import"] },
            },
          ],
    }));

    await withPluginMigrationProviders(
      { providerId: "external-import", cfg },
      async (providers) => {
        const resolved = providers.find((entry) => entry.id === "external-import");
        expect(resolved?.id).toBe(provider.id);
        provider.plan.mockImplementationOnce(() => {
          expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(loaded);
          return {} as never;
        });
        await resolved?.plan({} as never);
        expect(provider.plan).toHaveBeenCalledOnce();
      },
    );
    expect(mocks.loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledWith({
      config: cfg,
      env: process.env,
    });
    const manifestParams = requireMockCallArg(
      mocks.loadPluginManifestRegistry,
      "loadPluginManifestRegistry",
    ) as {
      index?: MockPluginIndex;
      config?: OpenClawConfig;
      env?: NodeJS.ProcessEnv;
      includeDisabled?: unknown;
    };
    expect(manifestParams.index?.plugins.map((plugin) => plugin.pluginId)).toEqual([
      "external-migration",
      "disabled-external-migration",
    ]);
    expect(manifestParams.config).toBe(cfg);
    expect(manifestParams.env).toBe(process.env);
    expect(manifestParams.includeDisabled).toBe(true);
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenNthCalledWith(1);
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      onlyPluginIds: ["external-migration"],
    });
  });

  it("discovers newly bundled migration providers from current metadata", async () => {
    const provider = createMigrationProvider("hermes");
    const active = createEmptyPluginRegistry();
    const loaded = createOwnedMigrationRegistry("migrate-hermes", provider);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : undefined,
    );
    mocks.acquirePluginRegistryForInspection.mockResolvedValue({
      registry: loaded,
      release: mocks.release,
    });
    mocks.listBundledPluginMetadata.mockReturnValue([
      {
        manifest: {
          id: "migrate-hermes",
          contracts: { migrationProviders: ["hermes"] },
        },
        dirName: "missing-migration-fixture",
      },
    ] as never);

    await withPluginMigrationProviders({ providerId: "hermes" }, async (providers) => {
      expect(providers.map((entry) => entry.id)).toEqual(["hermes"]);
      await providers[0]?.plan({
        config: {},
        stateDir: tempDirs.make("openclaw-bundled-migration-"),
        logger: { info() {}, warn() {}, error() {} },
      });
      expect(provider.plan).toHaveBeenCalledOnce();
    });
    expect(mocks.listBundledPluginMetadata).toHaveBeenCalledWith({
      includeChannelConfigs: false,
    });
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      onlyPluginIds: ["migrate-hermes"],
    });
  });

  it("lists configured external migration providers alongside active providers", async () => {
    const activeProvider = createMigrationProvider("active-import");
    const externalProvider = createMigrationProvider("external-import");
    const active = createEmptyPluginRegistry();
    active.migrationProviders.push({
      pluginId: "active-migration",
      pluginName: "Active Migration",
      source: "test",
      provider: activeProvider,
    } as never);
    const loaded = createOwnedMigrationRegistry("external-migration", externalProvider);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : undefined,
    );
    mocks.acquirePluginRegistryForInspection.mockResolvedValue({
      registry: loaded,
      release: mocks.release,
    });
    mocks.loadPluginRegistrySnapshot.mockReturnValue(
      createMockPluginIndex([
        {
          pluginId: "external-migration",
          origin: "installed",
          enabled: true,
        },
      ]),
    );
    mocks.loadPluginManifestRegistry.mockImplementation((params?: Record<string, unknown>) => ({
      diagnostics: [],
      plugins: params?.includeDisabled
        ? [
            {
              id: "external-migration",
              origin: "installed",
              contracts: { migrationProviders: ["external-import"] },
            },
          ]
        : [
            {
              id: "external-migration",
              origin: "installed",
              contracts: { migrationProviders: ["external-import"] },
            },
          ],
    }));

    await withPluginMigrationProviders({}, async (providers) => {
      expect(providers.map((provider) => provider.id)).toEqual([
        "active-import",
        "external-import",
      ]);
      expect(providers[0]).toBe(activeProvider);
    });
  });
});
