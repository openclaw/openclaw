// Covers migration provider runtime hooks supplied by plugins.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

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
    const loaded = createEmptyPluginRegistry();
    loaded.migrationProviders.push({
      pluginId: "external-migration",
      pluginName: "External Migration",
      source: "test",
      provider,
    } as never);
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
        expect(resolved).not.toBe(provider);
        provider.plan.mockImplementationOnce(() => {
          expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(loaded);
          return {} as never;
        });
        await resolved?.plan({} as never);
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
    const loaded = createEmptyPluginRegistry();
    loaded.migrationProviders.push({
      pluginId: "migrate-hermes",
      pluginName: "Hermes Migration",
      source: "test",
      provider,
    } as never);
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
      expect(providers.find((entry) => entry.id === "hermes")).not.toBe(provider);
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
    const loaded = createEmptyPluginRegistry();
    loaded.migrationProviders.push({
      pluginId: "external-migration",
      pluginName: "External Migration",
      source: "test",
      provider: externalProvider,
    } as never);
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
