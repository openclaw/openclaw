import { describe, expect, it } from "vitest";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import {
  hasBundledWebFetchProviderPublicArtifact,
  hasBundledWebSearchProviderPublicArtifact,
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
} from "./web-provider-public-artifacts.explicit.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function supportsSecretRefWebSearchApiKey(
  plugin: ReturnType<typeof loadPluginManifestRegistry>["plugins"][number],
): boolean {
  const configProperties = isRecord(plugin.configSchema?.["properties"])
    ? plugin.configSchema["properties"]
    : undefined;
  const webSearch = configProperties?.["webSearch"];
  if (!isRecord(webSearch)) {
    return false;
  }
  const properties = isRecord(webSearch["properties"]) ? webSearch["properties"] : undefined;
  const apiKey = properties?.["apiKey"];
  if (!isRecord(apiKey)) {
    return false;
  }
  const typeValue = apiKey["type"];
  return Array.isArray(typeValue) && typeValue.includes("object");
}

const registry = loadPluginManifestRegistry();

function bundledPluginIdsWithContract(
  contract: "webSearchProviders" | "webFetchProviders",
): string[] {
  return registry.plugins
    .filter(
      (plugin) => plugin.origin === "bundled" && (plugin.contracts?.[contract]?.length ?? 0) > 0,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function ownerPluginIdForContractValue(
  contract: "webSearchProviders" | "webFetchProviders",
  value: string,
): string | undefined {
  const normalized = value.toLowerCase();
  return registry.plugins.find(
    (plugin) =>
      plugin.origin === "bundled" &&
      plugin.contracts?.[contract]?.some((candidate) => candidate.toLowerCase() === normalized),
  )?.id;
}

describe("web provider public artifacts", () => {
  it("has a public artifact for every bundled web search provider declared in manifests", () => {
    const pluginIds = bundledPluginIdsWithContract("webSearchProviders");

    expect(pluginIds).not.toHaveLength(0);
    for (const pluginId of pluginIds) {
      expect(hasBundledWebSearchProviderPublicArtifact(pluginId)).toBe(true);
    }
  });

  it("keeps public web search artifacts mapped to their manifest owner plugin", () => {
    const pluginIds = bundledPluginIdsWithContract("webSearchProviders");

    const providers = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({
      onlyPluginIds: pluginIds,
    });

    expect(providers).not.toBeNull();
    for (const provider of providers ?? []) {
      expect(ownerPluginIdForContractValue("webSearchProviders", provider.id)).toBe(
        provider.pluginId,
      );
    }
  });

  it("registers compatibility runtime paths for bundled SecretRef-capable web search providers", () => {
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
    const actualPluginIds = registry.plugins
      .filter(
        (plugin) =>
          plugin.origin === "bundled" &&
          (plugin.contracts?.webSearchProviders?.length ?? 0) > 0 &&
          (plugin.configContracts?.compatibilityRuntimePaths ?? []).includes(
            "tools.web.search.apiKey",
          ),
      )
      .map((plugin) => plugin.id)
      .toSorted((left, right) => left.localeCompare(right));
    expect(actualPluginIds).toEqual(expectedPluginIds);
  });

  it("has a public artifact for every bundled web fetch provider declared in manifests", () => {
    const pluginIds = bundledPluginIdsWithContract("webFetchProviders");

    expect(pluginIds).not.toHaveLength(0);
    for (const pluginId of pluginIds) {
      expect(hasBundledWebFetchProviderPublicArtifact(pluginId)).toBe(true);
    }
  });
});
