import { beforeEach, describe, expect, it, vi } from "vitest";
import { withBundledPluginAllowlistCompat } from "../bundled-compat.js";
import { loadPluginManifestRegistry } from "../manifest-registry.js";
import { __testing as providerTesting } from "../providers.js";
import { resolvePluginWebSearchProviders } from "../web-search-providers.js";
import { providerContractCompatPluginIds, webSearchProviderContractRegistry } from "./registry.js";
import { uniqueSortedStrings } from "./testkit.js";

function resolveBundledManifestProviderPluginIds() {
  return uniqueSortedStrings(
    loadPluginManifestRegistry({})
      .plugins.filter((plugin) => plugin.origin === "bundled" && plugin.providers.length > 0)
      .map((plugin) => plugin.id),
  );
}

describe("plugin loader contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps bundled provider compatibility wired to the provider registry", () => {
    const providerPluginIds = uniqueSortedStrings(providerContractCompatPluginIds);
    const manifestProviderPluginIds = resolveBundledManifestProviderPluginIds();
    const compatPluginIds = providerTesting.resolveBundledProviderCompatPluginIds({
      config: {
        plugins: {
          allow: ["openrouter"],
        },
      },
    });

    const compatConfig = withBundledPluginAllowlistCompat({
      config: {
        plugins: {
          allow: ["openrouter"],
        },
      },
      pluginIds: compatPluginIds,
    });

    expect(providerPluginIds).toEqual(manifestProviderPluginIds);
    expect(uniqueSortedStrings(compatPluginIds)).toEqual(manifestProviderPluginIds);
    expect(uniqueSortedStrings(compatPluginIds)).toEqual(expect.arrayContaining(providerPluginIds));
    expect(compatConfig?.plugins?.allow).toEqual(expect.arrayContaining(providerPluginIds));
  });

  it("keeps vitest bundled provider enablement wired to the provider registry", () => {
    const providerPluginIds = uniqueSortedStrings(providerContractCompatPluginIds);
    const manifestProviderPluginIds = resolveBundledManifestProviderPluginIds();
    const compatConfig = providerTesting.withBundledProviderVitestCompat({
      config: undefined,
      pluginIds: providerPluginIds,
      env: { VITEST: "1" } as NodeJS.ProcessEnv,
    });

    expect(providerPluginIds).toEqual(manifestProviderPluginIds);
    expect(compatConfig?.plugins).toMatchObject({
      enabled: true,
      allow: expect.arrayContaining(providerPluginIds),
    });
  });

  it("keeps bundled web search loading scoped to the web search registry", () => {
    const webSearchPluginIds = uniqueSortedStrings(
      webSearchProviderContractRegistry.map((entry) => entry.pluginId),
    );

    const providers = resolvePluginWebSearchProviders({});

    expect(uniqueSortedStrings(providers.map((provider) => provider.pluginId))).toEqual(
      webSearchPluginIds,
    );
  });

  it("keeps bundled web search allowlist compatibility wired to the web search registry", () => {
    const webSearchPluginIds = uniqueSortedStrings(
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

    expect(uniqueSortedStrings(providers.map((provider) => provider.pluginId))).toEqual(
      webSearchPluginIds,
    );
  });
});
