import { BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS } from "./bundled-capability-metadata.js";

const bundledWebFetchProviderPluginIds = Object.fromEntries(
  BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.flatMap((entry) =>
    entry.webFetchProviderIds.map((providerId) => [providerId, entry.pluginId] as const),
  ).toSorted(([left], [right]) => left.localeCompare(right)),
) as Readonly<Record<string, string>>;

export function resolveBundledWebFetchPluginId(providerId: string | undefined): string | undefined {
  if (!providerId) {
    return undefined;
  }
  const normalizedProviderId = providerId.trim().toLowerCase();
  if (!(normalizedProviderId in bundledWebFetchProviderPluginIds)) {
    return undefined;
  }
  return bundledWebFetchProviderPluginIds[normalizedProviderId];
}
