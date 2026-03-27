import { BUNDLED_WEB_SEARCH_PROVIDER_PLUGIN_IDS } from "./bundled-capability-metadata.js";

export function resolveBundledWebSearchPluginId(
  providerId: string | undefined,
): string | undefined {
  if (!providerId) {
    return undefined;
  }
  const normalizedProviderId = providerId.trim().toLowerCase();
  if (!(normalizedProviderId in BUNDLED_WEB_SEARCH_PROVIDER_PLUGIN_IDS)) {
    return undefined;
  }
  return BUNDLED_WEB_SEARCH_PROVIDER_PLUGIN_IDS[
    normalizedProviderId as keyof typeof BUNDLED_WEB_SEARCH_PROVIDER_PLUGIN_IDS
  ];
}
