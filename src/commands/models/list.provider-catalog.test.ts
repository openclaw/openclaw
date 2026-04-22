import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderPlugin } from "../../plugins/types.js";
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
    vi.useRealTimers();
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

  it("skips static catalogs that exceed the display budget", async () => {
    vi.useFakeTimers();
    const hungProvider = {
      id: "hung",
      label: "Hung",
      auth: [],
      staticCatalog: {
        run: async () => new Promise<never>(() => {}),
      },
    } satisfies ProviderPlugin;
    const healthyProvider = {
      id: "healthy",
      label: "Healthy",
      auth: [],
      staticCatalog: {
        run: async () => ({
          provider: {
            baseUrl: "https://healthy.example/v1",
            models: [{ id: "healthy-model", name: "Healthy Model" }],
          },
        }),
      },
    } satisfies ProviderPlugin;
    const discovery = await import("../../plugins/provider-discovery.js");
    vi.spyOn(discovery, "resolvePluginDiscoveryProviders").mockResolvedValue([
      hungProvider,
      healthyProvider,
    ]);

    const rowsPromise = loadProviderCatalogModelsForList({
      ...baseParams,
    });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(rowsPromise).resolves.toEqual([
      expect.objectContaining({
        provider: "healthy",
        id: "healthy-model",
      }),
    ]);
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

  it("recognizes trusted workspace provider aliases before the unknown-provider short-circuit", async () => {
    const manifestRegistry = await import("../../plugins/manifest-registry.js");
    const providers = await import("../../plugins/providers.js");
    const discovery = await import("../../plugins/provider-discovery.js");
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "workspace-demo",
          origin: "workspace",
          providers: ["workspace-demo"],
          cliBackends: [],
        },
      ],
      diagnostics: [],
    } as never);
    vi.spyOn(providers, "resolveDiscoveredProviderPluginIds").mockReturnValue(["workspace-demo"]);
    vi.spyOn(discovery, "resolvePluginDiscoveryProviders").mockResolvedValue([
      {
        id: "workspace-demo",
        pluginId: "workspace-demo",
        label: "Workspace Demo",
        aliases: ["workspace-demo-alias"],
        auth: [],
        staticCatalog: {
          run: async () => ({
            provider: {
              baseUrl: "https://workspace.example/v1",
              models: [],
            },
          }),
        },
      },
    ]);

    await expect(
      resolveProviderCatalogPluginIdsForFilter({
        cfg: baseParams.cfg,
        env: baseParams.env,
        providerFilter: "workspace-demo-alias",
      }),
    ).resolves.toEqual(["workspace-demo"]);
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
