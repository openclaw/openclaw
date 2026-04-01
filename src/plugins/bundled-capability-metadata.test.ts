import { describe, expect, it } from "vitest";
import {
  BUNDLED_AUTO_ENABLE_PROVIDER_PLUGIN_IDS,
  BUNDLED_LEGACY_PLUGIN_ID_ALIASES,
  BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS,
} from "./bundled-capability-metadata.js";
import { listBundledPluginMetadata } from "./bundled-plugin-metadata.js";

function uniqueStrings(values: readonly string[] | undefined): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

describe("bundled capability metadata", () => {
  it("keeps contract snapshots aligned with bundled plugin manifests", () => {
    const expected = listBundledPluginMetadata()
      .map(({ manifest }) => ({
        pluginId: manifest.id,
        cliBackendIds: uniqueStrings(manifest.cliBackends),
        providerIds: uniqueStrings(manifest.providers),
        speechProviderIds: uniqueStrings(manifest.contracts?.speechProviders),
        mediaUnderstandingProviderIds: uniqueStrings(
          manifest.contracts?.mediaUnderstandingProviders,
        ),
        imageGenerationProviderIds: uniqueStrings(manifest.contracts?.imageGenerationProviders),
        webSearchProviderIds: uniqueStrings(manifest.contracts?.webSearchProviders),
        toolNames: uniqueStrings(manifest.contracts?.tools),
      }))
      .filter(
        (entry) =>
          entry.cliBackendIds.length > 0 ||
          entry.providerIds.length > 0 ||
          entry.speechProviderIds.length > 0 ||
          entry.mediaUnderstandingProviderIds.length > 0 ||
          entry.imageGenerationProviderIds.length > 0 ||
          entry.webSearchProviderIds.length > 0 ||
          entry.toolNames.length > 0,
      )
      .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));

    expect(BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS).toEqual(expected);
  });

  it("keeps lightweight alias maps aligned with bundled plugin manifests", () => {
    const manifests = listBundledPluginMetadata().map((entry) => entry.manifest);
    const expectedLegacyAliases = Object.fromEntries(
      manifests
        .flatMap((manifest) =>
          (manifest.legacyPluginIds ?? []).map((legacyPluginId) => [legacyPluginId, manifest.id]),
        )
        .toSorted(([left], [right]) => left.localeCompare(right)),
    );
    const expectedAutoEnableProviderPluginIds = Object.fromEntries(
      manifests
        .flatMap((manifest) =>
          (manifest.autoEnableWhenConfiguredProviders ?? []).map((providerId) => [
            providerId,
            manifest.id,
          ]),
        )
        .toSorted(([left], [right]) => left.localeCompare(right)),
    );

    expect(BUNDLED_LEGACY_PLUGIN_ID_ALIASES).toEqual(expectedLegacyAliases);
    expect(BUNDLED_AUTO_ENABLE_PROVIDER_PLUGIN_IDS).toEqual(expectedAutoEnableProviderPluginIds);
  });
});
