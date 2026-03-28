import { BUNDLED_PLUGIN_METADATA } from "./bundled-plugin-metadata.js";

export type BundledPluginContractSnapshot = {
  pluginId: string;
  cliBackendIds: string[];
  providerIds: string[];
  speechProviderIds: string[];
  mediaUnderstandingProviderIds: string[];
  imageGenerationProviderIds: string[];
  webSearchProviderIds: string[];
  toolNames: string[];
};

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

export const BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS: readonly BundledPluginContractSnapshot[] =
  BUNDLED_PLUGIN_METADATA.map(({ manifest }) => ({
    pluginId: manifest.id,
    cliBackendIds: uniqueStrings(manifest.cliBackends),
    providerIds: uniqueStrings(manifest.providers),
    speechProviderIds: uniqueStrings(manifest.contracts?.speechProviders),
    mediaUnderstandingProviderIds: uniqueStrings(manifest.contracts?.mediaUnderstandingProviders),
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

function collectPluginIds(
  pick: (entry: BundledPluginContractSnapshot) => readonly string[],
): readonly string[] {
  return BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) => pick(entry).length > 0)
    .map((entry) => entry.pluginId)
    .toSorted((left, right) => left.localeCompare(right));
}

export const BUNDLED_PROVIDER_PLUGIN_IDS = collectPluginIds((entry) => entry.providerIds);

export const BUNDLED_SPEECH_PLUGIN_IDS = collectPluginIds((entry) => entry.speechProviderIds);

export const BUNDLED_MEDIA_UNDERSTANDING_PLUGIN_IDS = collectPluginIds(
  (entry) => entry.mediaUnderstandingProviderIds,
);

export const BUNDLED_IMAGE_GENERATION_PLUGIN_IDS = collectPluginIds(
  (entry) => entry.imageGenerationProviderIds,
);

export const BUNDLED_RUNTIME_CONTRACT_PLUGIN_IDS = [
  ...new Set(
    BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter(
      (entry) =>
        entry.providerIds.length > 0 ||
        entry.speechProviderIds.length > 0 ||
        entry.mediaUnderstandingProviderIds.length > 0 ||
        entry.imageGenerationProviderIds.length > 0 ||
        entry.webSearchProviderIds.length > 0,
    ).map((entry) => entry.pluginId),
  ),
].toSorted((left, right) => left.localeCompare(right));

export const BUNDLED_WEB_SEARCH_PLUGIN_IDS = collectPluginIds(
  (entry) => entry.webSearchProviderIds,
);

export const BUNDLED_WEB_SEARCH_PROVIDER_PLUGIN_IDS = Object.fromEntries(
  BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.flatMap((entry) =>
    entry.webSearchProviderIds.map((providerId) => [providerId, entry.pluginId] as const),
  ).toSorted(([left], [right]) => left.localeCompare(right)),
) as Readonly<Record<string, string>>;

export const BUNDLED_PROVIDER_PLUGIN_ID_ALIASES = Object.fromEntries(
  BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.flatMap((entry) =>
    entry.providerIds
      .filter((providerId) => providerId !== entry.pluginId)
      .map((providerId) => [providerId, entry.pluginId] as const),
  ).toSorted(([left], [right]) => left.localeCompare(right)),
) as Readonly<Record<string, string>>;

export const BUNDLED_LEGACY_PLUGIN_ID_ALIASES = Object.fromEntries(
  BUNDLED_PLUGIN_METADATA.flatMap(({ manifest }) =>
    (manifest.legacyPluginIds ?? []).map(
      (legacyPluginId) => [legacyPluginId, manifest.id] as const,
    ),
  ).toSorted(([left], [right]) => left.localeCompare(right)),
) as Readonly<Record<string, string>>;

export const BUNDLED_AUTO_ENABLE_PROVIDER_PLUGIN_IDS = Object.fromEntries(
  BUNDLED_PLUGIN_METADATA.flatMap(({ manifest }) =>
    (manifest.autoEnableWhenConfiguredProviders ?? []).map((providerId) => [
      providerId,
      manifest.id,
    ]),
  ).toSorted(([left], [right]) => left.localeCompare(right)),
) as Readonly<Record<string, string>>;
