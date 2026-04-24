import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { ProviderPlugin } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadPluginManifestRegistry: vi.fn(),
  resolveDiscoveredProviderPluginIds: vi.fn(),
  resolvePluginProviders: vi.fn(),
  loadSource: vi.fn(),
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry: mocks.loadPluginManifestRegistry,
}));

vi.mock("./providers.js", () => ({
  resolveDiscoveredProviderPluginIds: mocks.resolveDiscoveredProviderPluginIds,
}));

vi.mock("./providers.runtime.js", () => ({
  resolvePluginProviders: mocks.resolvePluginProviders,
}));

vi.mock("./source-loader.js", () => ({
  createPluginSourceLoader: () => mocks.loadSource,
}));

import { resolvePluginDiscoveryProvidersRuntime } from "./provider-discovery.runtime.js";

function createManifestPlugin(id: string): PluginManifestRecord {
  return {
    id,
    enabledByDefault: true,
    channels: [],
    providers: [id],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: `/tmp/${id}`,
    source: "bundled",
    manifestPath: `/tmp/${id}/openclaw.plugin.json`,
    providerDiscoverySource: `/tmp/${id}/provider-discovery.ts`,
  };
}

function createProvider(params: { id: string; mode: "static" | "catalog" }): ProviderPlugin {
  const hook = {
    run: async () => ({
      provider: {
        baseUrl: "https://example.test/v1",
        models: [],
      },
    }),
  };
  return {
    id: params.id,
    label: params.id,
    auth: [],
    ...(params.mode === "static" ? { staticCatalog: hook } : { catalog: hook }),
  };
}

describe("resolvePluginDiscoveryProvidersRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["deepseek"]);
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [createManifestPlugin("deepseek")],
      diagnostics: [],
    });
  });

  it("falls back to full provider plugins when discovery entries only expose static catalogs", () => {
    const fullProvider = createProvider({ id: "deepseek", mode: "catalog" });
    mocks.loadSource.mockReturnValue(createProvider({ id: "deepseek", mode: "static" }));
    mocks.resolvePluginProviders.mockReturnValue([fullProvider]);

    expect(resolvePluginDiscoveryProvidersRuntime({})).toEqual([fullProvider]);
    expect(mocks.resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        bundledProviderAllowlistCompat: true,
      }),
    );
  });

  it("falls back to full provider plugins for mixed live and static-only entries", () => {
    const fullProviders = [
      createProvider({ id: "codex", mode: "catalog" }),
      createProvider({ id: "deepseek", mode: "catalog" }),
    ];
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["codex", "deepseek"]);
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [createManifestPlugin("codex"), createManifestPlugin("deepseek")],
      diagnostics: [],
    });
    mocks.loadSource.mockImplementation((modulePath: string) =>
      modulePath.includes("/codex/")
        ? createProvider({ id: "codex", mode: "catalog" })
        : createProvider({ id: "deepseek", mode: "static" }),
    );
    mocks.resolvePluginProviders.mockReturnValue(fullProviders);

    expect(resolvePluginDiscoveryProvidersRuntime({})).toEqual(fullProviders);
  });

  it("returns static-only discovery entries for callers that explicitly request them", () => {
    const staticProvider = createProvider({ id: "deepseek", mode: "static" });
    mocks.loadSource.mockReturnValue(staticProvider);

    expect(resolvePluginDiscoveryProvidersRuntime({ discoveryEntriesOnly: true })).toEqual([
      expect.objectContaining({
        id: "deepseek",
        pluginId: "deepseek",
        staticCatalog: staticProvider.staticCatalog,
      }),
    ]);
    expect(mocks.resolvePluginProviders).not.toHaveBeenCalled();
  });
});
