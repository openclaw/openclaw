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
const logger = { info() {}, warn() {}, error() {} };
const createContext = (): MigrationProviderContext => ({
  config: {},
  stateDir: tempDirs.make("openclaw-migration-"),
  logger,
});
const writeJson = (root: string, file: string, value: unknown) =>
  fs.writeFileSync(path.join(root, file), JSON.stringify(value));

type MockManifestRegistry = { plugins: Array<Record<string, unknown>> };

type MockPluginIndex = {
  plugins: Array<{ pluginId: string; origin: string; enabled: boolean }>;
};

function createMockPluginIndex(plugins: MockPluginIndex["plugins"]): MockPluginIndex {
  return { plugins };
}

const mocks = vi.hoisted(() => ({
  resolveRuntimePluginRegistry: vi.fn<(params?: unknown) => PluginRegistry | undefined>(),
  loadPluginManifestRegistry: vi.fn<(params?: Record<string, unknown>) => MockManifestRegistry>(),
  loadPluginRegistrySnapshot: vi.fn<(_params?: unknown) => MockPluginIndex>(),
  acquirePluginRegistryForInspection: vi.fn(),
  release: vi.fn(async () => {}),
  listBundledPluginMetadata:
    vi.fn<typeof import("./bundled-plugin-metadata.js").listBundledPluginMetadata>(),
}));

vi.mock("./loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./loader.js")>()),
  resolveRuntimePluginRegistry: mocks.resolveRuntimePluginRegistry,
  acquirePluginRegistryForInspection: mocks.acquirePluginRegistryForInspection,
}));

// mock-isolation: Migration fixtures own the active registry without ambient plugin state.
vi.mock("./active-runtime-registry.js", () => ({
  getLoadedRuntimePluginRegistry: (params?: { requiredPluginIds?: string[] }) =>
    mocks.resolveRuntimePluginRegistry(params && { onlyPluginIds: params.requiredPluginIds }),
}));

// mock-isolation: Migration fixtures provide their installed index without filesystem discovery.
vi.mock("./plugin-registry-snapshot.js", () => ({
  loadPluginRegistrySnapshot: mocks.loadPluginRegistrySnapshot,
  loadPluginRegistrySnapshotWithMetadata: (params?: { index?: MockPluginIndex }) => ({
    source: params?.index ? "provided" : "derived",
    snapshot: params?.index ?? mocks.loadPluginRegistrySnapshot(),
    diagnostics: [],
  }),
}));

// mock-isolation: Migration fixtures bind metadata to their synthetic installed registry.
vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (params: { config?: OpenClawConfig; env?: NodeJS.ProcessEnv }) => {
    const index = mocks.loadPluginRegistrySnapshot();
    const manifestRegistry = mocks.loadPluginManifestRegistry({
      index,
      config: params.config,
      env: params.env,
      includeDisabled: true,
    });
    return { index, plugins: manifestRegistry.plugins };
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
  return { id, label: id, plan: vi.fn(), apply: vi.fn() };
}

function createOwnedMigrationRegistry(
  pluginId: string,
  provider: ReturnType<typeof createMigrationProvider>,
  initialize?: () => void,
) {
  const builder = createPluginRegistry({
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
    logger,
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

function mockInstalledProviders(
  entries: Array<{ pluginId: string; providerId: string; enabled?: boolean }>,
) {
  mocks.loadPluginRegistrySnapshot.mockReturnValue(
    createMockPluginIndex(
      entries.map(({ pluginId, enabled = true }) => ({ pluginId, origin: "installed", enabled })),
    ),
  );
  mocks.loadPluginManifestRegistry.mockImplementation((params) => ({
    plugins: entries
      .filter(({ enabled }) => params?.includeDisabled || enabled !== false)
      .map(({ pluginId, providerId }) => ({
        id: pluginId,
        origin: "installed",
        contracts: { migrationProviders: [providerId] },
      })),
  }));
}

function mockInspection(active: PluginRegistry, loaded: PluginRegistry) {
  mocks.resolveRuntimePluginRegistry.mockImplementation((params) =>
    params === undefined ? active : undefined,
  );
  mocks.acquirePluginRegistryForInspection.mockResolvedValue({
    registry: loaded,
    release: mocks.release,
  });
}

describe("migration provider runtime", () => {
  beforeEach(async () => {
    clearPluginMetadataLifecycleCaches();
    vi.resetModules();
    vi.clearAllMocks();
    mocks.resolveRuntimePluginRegistry.mockReturnValue(undefined);
    mocks.loadPluginManifestRegistry.mockReturnValue({ plugins: [] });
    mocks.loadPluginRegistrySnapshot.mockReturnValue(createMockPluginIndex([]));
    mocks.acquirePluginRegistryForInspection.mockResolvedValue({
      registry: createEmptyPluginRegistry(),
      release: mocks.release,
    });
    mocks.listBundledPluginMetadata.mockReturnValue([]);
    ({ withPluginMigrationProviders } = await import("./migration-provider-runtime.js"));
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
      mockInstalledProviders([{ pluginId: "managed-migration", providerId: provider.id }]);
      mocks.resolveRuntimePluginRegistry.mockReturnValue(
        route === "acquired registry" ? undefined : registry,
      );
      mocks.acquirePluginRegistryForInspection.mockResolvedValue({
        registry,
        release: mocks.release,
      });
      const context = createContext();
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
            const expectRetired = () => {
              expect(() => retainedPlan(context)).toThrow(
                "Plugin managed-migration was reloaded or disabled; use its current tools.",
              );
              expect(provider.plan).toHaveBeenCalledTimes(3);
            };
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
            expectRetired();
            resume.resolve();
            await expect(pending).resolves.toBe(runtime.plan);
            await retirement;
            expect(cleaned).toHaveBeenCalledOnce();
            expectRetired();
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
    ["global", "enabled"],
    ["global", "disabled"],
    ["global", "denied"],
    ["bundled", "enabled"],
    ["bundled", "disabled"],
    ["bundled", "denied"],
  ] as const)(
    "enforces %s owner policy %s before executing a public artifact",
    async (origin, policy) => {
      const allowed = policy === "enabled";
      const scanDir = tempDirs.make("openclaw-migration-artifact-");
      const rootDir = path.join(scanDir, "fixture-dir");
      const executedPath = path.join(scanDir, "artifact-executed");
      fs.mkdirSync(rootDir);
      writeJson(rootDir, "package.json", {
        name: "@openclaw/fixture",
        version: "1.0.0",
        type: "module",
        openclaw: { extensions: ["./index.js"] },
      });
      writeJson(rootDir, "openclaw.plugin.json", {
        id: "fixture",
        contracts: { migrationProviders: ["fixture-import"] },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      });
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
            plan() {}, apply() {} };
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

  it.each(["external", "bundled"] as const)("discovers %s migration providers", async (origin) => {
    const pluginId = "fixture-migration";
    const provider = createMigrationProvider("fixture-import");
    const loaded = createOwnedMigrationRegistry(pluginId, provider);
    mockInspection(createEmptyPluginRegistry(), loaded);
    const cfg: OpenClawConfig = {
      plugins: { entries: { [pluginId]: { enabled: true }, disabled: { enabled: false } } },
    };
    if (origin === "external") {
      mockInstalledProviders([
        { pluginId, providerId: provider.id },
        { pluginId: "disabled", providerId: provider.id, enabled: false },
      ]);
    } else {
      mocks.listBundledPluginMetadata.mockReturnValue([
        {
          manifest: { id: pluginId, contracts: { migrationProviders: [provider.id] } },
          dirName: "missing-migration-fixture",
        },
      ] as never);
    }
    const params = { providerId: provider.id, cfg: origin === "external" ? cfg : undefined };
    await withPluginMigrationProviders(params, async (providers) => {
      expect(providers.map((entry) => entry.id)).toEqual([provider.id]);
      provider.plan.mockImplementationOnce(() => {
        expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(loaded);
      });
      await providers[0]?.plan(createContext());
      expect(provider.plan).toHaveBeenCalledOnce();
    });
    if (origin === "bundled") {
      expect(mocks.listBundledPluginMetadata).toHaveBeenCalledWith({
        includeChannelConfigs: false,
      });
    }
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      onlyPluginIds: [pluginId],
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
    mockInspection(active, loaded);
    mockInstalledProviders([{ pluginId: "external-migration", providerId: "external-import" }]);

    await withPluginMigrationProviders({}, async (providers) => {
      expect(providers.map((provider) => provider.id)).toEqual([
        "active-import",
        "external-import",
      ]);
      expect(providers[0]).toBe(activeProvider);
    });
  });
});
