import { BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS } from "./contracts/inventory/bundled-capability-metadata.js";
import { loadBundledSecretProviderEntriesFromDir } from "./secret-provider-public-artifacts.js";
import type { PluginSecretProviderEntry } from "./secret-provider-types.js";

const cache = new Map<string, PluginSecretProviderEntry>();

export function _resetSecretProviderResolverCache(): void {
  cache.clear();
}

/**
 * Find which bundled plugin owns the given secret-provider source id (e.g. "gcp"),
 * lazy-load its public artifact, and return the matching SecretProviderPlugin entry.
 *
 * Returns undefined if no bundled plugin declares the source, or if the plugin's
 * artifact does not export a matching factory.
 */
export async function resolveBundledSecretProviderForSource(
  source: string,
): Promise<PluginSecretProviderEntry | undefined> {
  const cached = cache.get(source);
  if (cached) {
    return cached;
  }

  for (const snapshot of BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS) {
    if (!snapshot.secretProviderIds.includes(source)) {
      continue;
    }
    let entries: PluginSecretProviderEntry[] | null;
    try {
      entries = loadBundledSecretProviderEntriesFromDir({
        dirName: snapshot.pluginId,
        pluginId: snapshot.pluginId,
      });
    } catch (err) {
      throw new Error(
        `Plugin "${snapshot.pluginId}" declares secret provider source "${source}" but its artifact failed to load.`,
        { cause: err },
      );
    }
    if (!entries) {
      continue;
    }
    const match = entries.find((entry) => entry.id === source);
    if (match) {
      cache.set(source, match);
      return match;
    }
  }
  return undefined;
}
