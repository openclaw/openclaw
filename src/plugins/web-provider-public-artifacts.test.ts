import { describe, expect, it } from "vitest";
import {
  loadPluginManifestRegistry,
  resolveManifestContractOwnerPluginId,
  resolveManifestContractPluginIds,
  resolveManifestContractPluginIdsByCompatibilityRuntimePath,
} from "./manifest-registry.js";
import {
  hasBundledWebFetchProviderPublicArtifact,
  hasBundledWebSearchProviderPublicArtifact,
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
} from "./web-provider-public-artifacts.explicit.js";

function supportsSecretRefWebSearchApiKey(
  plugin: ReturnType<typeof loadPluginManifestRegistry>["plugins"][number],
): boolean {
  const webSearch = plugin.configSchema?.properties?.webSearch;
  if (!webSearch || typeof webSearch !== "object" || Array.isArray(webSearch)) {
    return false;
  }
  const properties =
    "properties" in webSearch &&
    webSearch.properties &&
    typeof webSearch.properties === "object" &&
    !Array.isArray(webSearch.properties)
      ? webSearch.properties
      : undefined;
  const apiKey = properties?.apiKey;
  if (!apiKey || typeof apiKey !== "object" || Array.isArray(apiKey)) {
    return false;
  }
  const typeValue = "type" in apiKey ? apiKey.type : undefined;
  return Array.isArray(typeValue) && typeValue.includes("object");
}

describe("web provider public artifacts", () => {
  it("has a public artifact for every bundled web search provider declared in manifests", () => {
    const pluginIds = resolveManifestContractPluginIds({
      contract: "webSearchProviders",
      origin: "bundled",
    });

    expect(pluginIds).not.toHaveLength(0);
    for (const pluginId of pluginIds) {
      expect(hasBundledWebSearchProviderPublicArtifact(pluginId)).toBe(true);
    }
  });

  it("keeps public web search artifacts mapped to their manifest owner plugin", () => {
    const pluginIds = resolveManifestContractPluginIds({
      contract: "webSearchProviders",
      origin: "bundled",
    });

    const providers = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({
      onlyPluginIds: pluginIds,
    });

    expect(providers).not.toBeNull();
    for (const provider of providers ?? []) {
      expect(
        resolveManifestContractOwnerPluginId({
          contract: "webSearchProviders",
          value: provider.id,
          origin: "bundled",
        }),
      ).toBe(provider.pluginId);
    }
  });

  it("registers compatibility runtime paths for bundled SecretRef-capable web search providers", () => {
    const registry = loadPluginManifestRegistry({ cache: false });
    const expectedPluginIds = registry.plugins
      .filter(
        (plugin) =>
          plugin.origin === "bundled" &&
          (plugin.contracts?.webSearchProviders?.length ?? 0) > 0 &&
          supportsSecretRefWebSearchApiKey(plugin),
      )
      .map((plugin) => plugin.id)
      .toSorted((left, right) => left.localeCompare(right));

    expect(expectedPluginIds).not.toHaveLength(0);
    expect(
      resolveManifestContractPluginIdsByCompatibilityRuntimePath({
        contract: "webSearchProviders",
        path: "tools.web.search.apiKey",
        origin: "bundled",
      }),
    ).toEqual(expectedPluginIds);
  });

  it("has a public artifact for every bundled web fetch provider declared in manifests", () => {
    const pluginIds = resolveManifestContractPluginIds({
      contract: "webFetchProviders",
      origin: "bundled",
    });

    expect(pluginIds).not.toHaveLength(0);
    for (const pluginId of pluginIds) {
      expect(hasBundledWebFetchProviderPublicArtifact(pluginId)).toBe(true);
    }
  });
});
