import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withBundledPluginAllowlistCompat } from "../bundled-compat.js";
import { resolveBundledWebSearchPluginIds } from "../bundled-web-search.js";
import { loadPluginManifestRegistry } from "../manifest-registry.js";
import { __testing as providerTesting } from "../providers.js";
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
  let providerPluginIds: string[];
  let manifestProviderPluginIds: string[];
  let compatPluginIds: string[];
  let compatConfig: ReturnType<typeof withBundledPluginAllowlistCompat>;
  let vitestCompatConfig: ReturnType<typeof providerTesting.withBundledProviderVitestCompat>;
  let webSearchPluginIds: string[];
  let bundledWebSearchPluginIds: string[];
  let webSearchAllowlistCompatConfig: ReturnType<typeof withBundledPluginAllowlistCompat>;

  beforeAll(() => {
    providerPluginIds = uniqueSortedStrings(providerContractCompatPluginIds);
    manifestProviderPluginIds = resolveBundledManifestProviderPluginIds();
    compatPluginIds = providerTesting.resolveBundledProviderCompatPluginIds({
      config: {
        plugins: {
          allow: ["openrouter"],
        },
      },
    });
    compatConfig = withBundledPluginAllowlistCompat({
      config: {
        plugins: {
          allow: ["openrouter"],
        },
      },
      pluginIds: compatPluginIds,
    });
    vitestCompatConfig = providerTesting.withBundledProviderVitestCompat({
      config: undefined,
      pluginIds: providerPluginIds,
      env: { VITEST: "1" } as NodeJS.ProcessEnv,
    });
    webSearchPluginIds = uniqueSortedStrings(
      webSearchProviderContractRegistry.map((entry) => entry.pluginId),
    );
    bundledWebSearchPluginIds = uniqueSortedStrings(resolveBundledWebSearchPluginIds({}));
    webSearchAllowlistCompatConfig = withBundledPluginAllowlistCompat({
      config: {
        plugins: {
          allow: ["openrouter"],
        },
      },
      pluginIds: webSearchPluginIds,
    });
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps bundled provider compatibility wired to the provider registry", () => {
    expect(providerPluginIds).toEqual(manifestProviderPluginIds);
    expect(uniqueSortedStrings(compatPluginIds)).toEqual(manifestProviderPluginIds);
    expect(uniqueSortedStrings(compatPluginIds)).toEqual(expect.arrayContaining(providerPluginIds));
    expect(compatConfig?.plugins?.allow).toEqual(expect.arrayContaining(providerPluginIds));
  });

  it("keeps vitest bundled provider enablement wired to the provider registry", () => {
    expect(providerPluginIds).toEqual(manifestProviderPluginIds);
    expect(vitestCompatConfig?.plugins).toMatchObject({
      enabled: true,
      allow: expect.arrayContaining(providerPluginIds),
    });
  });

  it("keeps bundled web search loading scoped to the web search registry", () => {
    expect(bundledWebSearchPluginIds).toEqual(webSearchPluginIds);
  });

  it("keeps bundled web search allowlist compatibility wired to the web search registry", () => {
    expect(webSearchAllowlistCompatConfig?.plugins?.allow).toEqual(
      expect.arrayContaining(webSearchPluginIds),
    );
  });
});
