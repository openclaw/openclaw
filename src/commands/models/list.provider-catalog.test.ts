import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadProviderCatalogModelsForList,
  resolveProviderCatalogPluginIdsForFilter,
} from "./list.provider-catalog.js";

const baseParams = {
  cfg: {
    plugins: {
      entries: {
        chutes: { enabled: true },
        moonshot: { enabled: true },
      },
    },
  },
  agentDir: "/tmp/openclaw-provider-catalog-test",
  env: {
    ...process.env,
    CHUTES_API_KEY: "",
    MOONSHOT_API_KEY: "",
  },
};

describe("loadProviderCatalogModelsForList", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not use live provider discovery for display-only rows", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("blocked fetch"));

    await loadProviderCatalogModelsForList({
      ...baseParams,
      providerFilter: "chutes",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("includes unauthenticated Moonshot static catalog rows", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("blocked fetch"));

    const rows = await loadProviderCatalogModelsForList({
      ...baseParams,
      providerFilter: "moonshot",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows.map((row) => `${row.provider}/${row.id}`)).toEqual(
      expect.arrayContaining(["moonshot/kimi-k2.6"]),
    );
  });

  it("recognizes bundled provider hook aliases before the unknown-provider short-circuit", async () => {
    await expect(
      resolveProviderCatalogPluginIdsForFilter({
        cfg: baseParams.cfg,
        env: baseParams.env,
        providerFilter: "azure-openai-responses",
      }),
    ).resolves.toEqual(["openai"]);
  });

  it("does not execute workspace provider static catalogs", async () => {
    const providers = await import("../../plugins/providers.js");
    const discovery = await import("../../plugins/provider-discovery.js");
    const workspaceStaticCatalog = vi.fn(async () => ({
      provider: { baseUrl: "https://workspace.example/v1", models: [] },
    }));
    vi.spyOn(providers, "resolveBundledProviderCompatPluginIds").mockReturnValue(["bundled-demo"]);
    vi.spyOn(discovery, "resolvePluginDiscoveryProviders").mockResolvedValue([
      {
        id: "bundled-demo",
        pluginId: "bundled-demo",
        label: "Bundled Demo",
        auth: [],
        staticCatalog: {
          run: async () => null,
        },
      },
      {
        id: "workspace-demo",
        pluginId: "workspace-demo",
        label: "Workspace Demo",
        auth: [],
        staticCatalog: {
          run: workspaceStaticCatalog,
        },
      },
    ]);

    const rows = await loadProviderCatalogModelsForList({
      ...baseParams,
    });

    expect(discovery.resolvePluginDiscoveryProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["bundled-demo"],
        includeUntrustedWorkspacePlugins: false,
      }),
    );
    expect(workspaceStaticCatalog).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  it("keeps unknown provider filters eligible for early empty results", async () => {
    await expect(
      resolveProviderCatalogPluginIdsForFilter({
        cfg: baseParams.cfg,
        env: baseParams.env,
        providerFilter: "unknown-provider-for-catalog-test",
      }),
    ).resolves.toBeUndefined();
  });
});
