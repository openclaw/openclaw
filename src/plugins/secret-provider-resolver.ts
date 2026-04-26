import { resolveBundledPluginIdForSecretProviderSource } from "./contracts/registry.js";
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

  const pluginId = resolveBundledPluginIdForSecretProviderSource(source);
  if (!pluginId) {
    return undefined;
  }

  let entries: PluginSecretProviderEntry[] | null;
  try {
    entries = loadBundledSecretProviderEntriesFromDir({
      dirName: pluginId,
      pluginId,
    });
  } catch (err) {
    throw new Error(
      `Plugin "${pluginId}" declares secret provider source "${source}" but its artifact failed to load.`,
      { cause: err },
    );
  }
  if (!entries) {
    return undefined;
  }

  const match = entries.find((entry) => entry.id === source);
  if (!match) {
    return undefined;
  }
  cache.set(source, match);
  return match;
}
