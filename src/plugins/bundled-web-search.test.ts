import { describe, expect, it } from "vitest";
import { BUNDLED_WEB_SEARCH_PLUGIN_IDS } from "./bundled-web-search-ids.js";
import {
  listBundledWebSearchProviders,
  resolveBundledWebSearchPluginIds,
} from "./bundled-web-search.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";

describe("bundled web search metadata", () => {
  it("keeps bundled web search compat ids aligned with bundled manifests", () => {
    const bundledWebSearchPluginIds = loadPluginManifestRegistry({})
      .plugins.filter(
        (plugin) =>
          plugin.origin === "bundled" && (plugin.contracts?.webSearchProviders?.length ?? 0) > 0,
      )
      .map((plugin) => plugin.id)
      .toSorted((left, right) => left.localeCompare(right));

    expect(resolveBundledWebSearchPluginIds({})).toEqual(bundledWebSearchPluginIds);
  });

  it("keeps bundled web search fast-path ids aligned with the registry", () => {
    expect([...BUNDLED_WEB_SEARCH_PLUGIN_IDS]).toEqual(
      listBundledWebSearchProviders()
        .map(({ pluginId }) => pluginId)
        .filter((value, index, values) => values.indexOf(value) === index)
        .toSorted((left, right) => left.localeCompare(right)),
    );
  });
});
