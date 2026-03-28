import { describe, expect, it } from "vitest";
import { BUNDLED_WEB_SEARCH_PLUGIN_IDS } from "./bundled-web-search-ids.js";
import {
  listBundledWebSearchProviders,
  resolveBundledWebSearchPluginIds,
} from "./bundled-web-search.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";

function resolveManifestBundledWebSearchPluginIds() {
  return loadPluginManifestRegistry({})
    .plugins.filter(
      (plugin) =>
        plugin.origin === "bundled" && (plugin.contracts?.webSearchProviders?.length ?? 0) > 0,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function resolveRegistryBundledWebSearchPluginIds() {
  return listBundledWebSearchProviders()
    .map(({ pluginId }) => pluginId)
    .filter((value, index, values) => values.indexOf(value) === index)
    .toSorted((left, right) => left.localeCompare(right));
}

function expectBundledWebSearchIds(actual: readonly string[], expected: readonly string[]) {
  expect(actual).toEqual(expected);
}

function expectBundledWebSearchAlignment(params: {
  actual: readonly string[];
  expected: readonly string[];
}) {
  expectBundledWebSearchIds(params.actual, params.expected);
}

describe("bundled web search metadata", () => {
  it.each([
    [
      "keeps bundled web search compat ids aligned with bundled manifests",
      resolveBundledWebSearchPluginIds({}),
      resolveManifestBundledWebSearchPluginIds(),
    ],
    [
      "keeps bundled web search fast-path ids aligned with the registry",
      [...BUNDLED_WEB_SEARCH_PLUGIN_IDS],
      resolveRegistryBundledWebSearchPluginIds(),
    ],
  ] as const)("%s", (_name, actual, expected) => {
    expectBundledWebSearchAlignment({ actual, expected });
  });
});
