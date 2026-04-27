import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRegistry } from "./registry-types.js";
import { createEmptyPluginRegistry } from "./registry.js";

type MockManifestRegistry = {
  plugins: Array<Record<string, unknown>>;
  diagnostics: unknown[];
};

function createEmptyMockManifestRegistry(): MockManifestRegistry {
  return { plugins: [], diagnostics: [] };
}

const mocks = vi.hoisted(() => ({
  resolveRuntimePluginRegistry: vi.fn<(params?: unknown) => PluginRegistry | undefined>(
    () => undefined,
  ),
  loadPluginManifestRegistry: vi.fn<(params?: Record<string, unknown>) => MockManifestRegistry>(
    () => createEmptyMockManifestRegistry(),
  ),
  withBundledPluginAllowlistCompat: vi.fn(
    ({ config }: { config?: OpenClawConfig; pluginIds: string[] }) => config,
  ),
  withBundledPluginEnablementCompat: vi.fn(
    ({ config }: { config?: OpenClawConfig; pluginIds: string[] }) => config,
  ),
  withBundledPluginVitestCompat: vi.fn(
    ({ config }: { config?: OpenClawConfig; pluginIds: string[] }) => config,
  ),
}));

vi.mock("./loader.js", () => ({
  resolveRuntimePluginRegistry: mocks.resolveRuntimePluginRegistry,
}));

vi.mock("./plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: mocks.loadPluginManifestRegistry,
}));

vi.mock("./bundled-compat.js", () => ({
  withBundledPluginAllowlistCompat: mocks.withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat: mocks.withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat: mocks.withBundledPluginVitestCompat,
}));

let resolvePluginMigrationProvider: typeof import("./migration-provider-runtime.js").resolvePluginMigrationProvider;
let resolvePluginMigrationProviders: typeof import("./migration-provider-runtime.js").resolvePluginMigrationProviders;

function createMigrationProvider(id: string) {
  return {
    id,
    label: id,
    plan: vi.fn(),
    apply: vi.fn(),
  };
}

describe("migration provider runtime", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.resolveRuntimePluginRegistry.mockReturnValue(createEmptyPluginRegistry());
    mocks.loadPluginManifestRegistry.mockReturnValue(createEmptyMockManifestRegistry());
    const runtime = await import("./migration-provider-runtime.js");
    resolvePluginMigrationProvider = runtime.resolvePluginMigrationProvider;
    resolvePluginMigrationProviders = runtime.resolvePluginMigrationProviders;
  });

  it("loads configured external migration-provider plugins from manifest contracts", () => {
    const cfg = {
      plugins: { entries: { "external-migration": { enabled: true } } },
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
      params === undefined ? active : loaded,
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

    const resolved = resolvePluginMigrationProvider({ providerId: "external-import", cfg });

    expect(resolved).toBe(provider);
    expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledWith({
      config: cfg,
      env: process.env,
      includeDisabled: true,
      preferPersisted: false,
    });
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith();
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: cfg,
      onlyPluginIds: ["external-migration"],
      activate: false,
    });
  });

  it("derives a fresh manifest registry so newly bundled migration providers are discoverable", () => {
    const provider = createMigrationProvider("hermes");
    const active = createEmptyPluginRegistry();
    const loaded = createEmptyPluginRegistry();
    loaded.migrationProviders.push({
      pluginId: "hermes-migration",
      pluginName: "Hermes Migration",
      source: "test",
      provider,
    } as never);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );
    mocks.loadPluginManifestRegistry.mockImplementation((params?: Record<string, unknown>) => {
      if (params?.preferPersisted !== false) {
        return createEmptyMockManifestRegistry();
      }
      return {
        diagnostics: [],
        plugins: [
          {
            id: "hermes-migration",
            origin: "bundled",
            contracts: { migrationProviders: ["hermes"] },
          },
        ],
      };
    });

    const resolved = resolvePluginMigrationProvider({ providerId: "hermes" });

    expect(resolved).toBe(provider);
    expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledWith({
      config: undefined,
      env: process.env,
      includeDisabled: true,
      preferPersisted: false,
    });
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      onlyPluginIds: ["hermes-migration"],
      activate: false,
    });
  });

  it("lists configured external migration providers alongside active providers", () => {
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
      params === undefined ? active : loaded,
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

    expect(resolvePluginMigrationProviders().map((provider) => provider.id)).toEqual([
      "active-import",
      "external-import",
    ]);
  });
});
