import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerContractRegistry, webSearchProviderContractRegistry } from "./registry.js";

const loadOpenClawPluginsMock = vi.fn();

vi.mock("../loader.js", () => ({
  loadOpenClawPlugins: (...args: unknown[]) => loadOpenClawPluginsMock(...args),
}));

const { resolvePluginProviders } = await import("../providers.js");
const { resolvePluginWebSearchProviders } = await import("../web-search-providers.js");

function uniqueSortedPluginIds(values: string[]) {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

describe("plugin loader contract", () => {
  beforeEach(() => {
    loadOpenClawPluginsMock.mockReset();
    loadOpenClawPluginsMock.mockReturnValue({
      providers: [],
      mediaUnderstandingProviders: [],
      webSearchProviders: [],
    });
  });

  it("keeps bundled provider compatibility wired to the provider registry", () => {
    const providerPluginIds = uniqueSortedPluginIds(
      providerContractRegistry.map((entry) => entry.pluginId),
    );

    resolvePluginProviders({
      bundledProviderAllowlistCompat: true,
      config: {
        plugins: {
          allow: ["openrouter"],
        },
      },
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: expect.arrayContaining(providerPluginIds),
          }),
        }),
      }),
    );
  });

  it("keeps vitest bundled provider enablement wired to the provider registry", () => {
    const providerPluginIds = uniqueSortedPluginIds(
      providerContractRegistry.map((entry) => entry.pluginId),
    );

    resolvePluginProviders({
      bundledProviderVitestCompat: true,
      env: { VITEST: "1" } as NodeJS.ProcessEnv,
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            enabled: true,
            allow: expect.arrayContaining(providerPluginIds),
          }),
        }),
      }),
    );
  });

  it("keeps bundled web search loading scoped to the web search registry", () => {
    const webSearchPluginIds = uniqueSortedPluginIds(
      webSearchProviderContractRegistry.map((entry) => entry.pluginId),
    );

    const providers = resolvePluginWebSearchProviders({});

    expect(uniqueSortedPluginIds(providers.map((provider) => provider.pluginId))).toEqual(
      webSearchPluginIds,
    );
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("keeps bundled web search allowlist compatibility wired to the web search registry", () => {
    const webSearchPluginIds = uniqueSortedPluginIds(
      webSearchProviderContractRegistry.map((entry) => entry.pluginId),
    );

    const providers = resolvePluginWebSearchProviders({
      bundledAllowlistCompat: true,
      config: {
        plugins: {
          allow: ["openrouter"],
        },
      },
    });

    expect(uniqueSortedPluginIds(providers.map((provider) => provider.pluginId))).toEqual(
      webSearchPluginIds,
    );
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });
});
