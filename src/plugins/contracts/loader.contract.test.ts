import { beforeEach, describe, expect, it, vi } from "vitest";
import { withBundledPluginAllowlistCompat } from "../bundled-compat.js";
import { __testing as providerTesting } from "../providers.js";
import { resolvePluginWebSearchProviders } from "../web-search-providers.js";
import {
  providerContractPluginIds,
  webSearchProviderContractRegistry,
} from "./registry.js";

function uniqueSortedPluginIds(values: string[]) {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function normalizeProviderContractPluginId(pluginId: string) {
  return pluginId === "kimi-coding" ? "kimi" : pluginId;
}

describe("plugin loader contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps bundled provider compatibility wired to the provider registry", () => {
    const providerPluginIds = uniqueSortedPluginIds(
      providerContractPluginIds.map(normalizeProviderContractPluginId),
    );
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

    expect(uniqueSortedPluginIds(compatPluginIds)).toEqual(
      expect.arrayContaining(providerPluginIds),
    );
    expect(compatConfig?.plugins?.allow).toEqual(expect.arrayContaining(providerPluginIds));
  });

  it("keeps vitest bundled provider enablement wired to the provider registry", () => {
    const providerPluginIds = uniqueSortedPluginIds(
      providerContractPluginIds.map(normalizeProviderContractPluginId),
    );
    const compatConfig = providerTesting.withBundledProviderVitestCompat({
      config: undefined,
      pluginIds: providerPluginIds,
      env: { VITEST: "1" } as NodeJS.ProcessEnv,
    });

    expect(compatConfig?.plugins).toMatchObject({
      enabled: true,
      allow: expect.arrayContaining(providerPluginIds),
    });
  });

  it("keeps bundled web search loading scoped to the web search registry", () => {
    const webSearchPluginIds = uniqueSortedPluginIds(
      webSearchProviderContractRegistry.map((entry) => entry.pluginId),
    );

    const providers = resolvePluginWebSearchProviders({});

    expect(uniqueSortedPluginIds(providers.map((provider) => provider.pluginId))).toEqual(
      webSearchPluginIds,
    );
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
  });
});
