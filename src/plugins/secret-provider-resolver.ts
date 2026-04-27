import { resolveBundledPluginIdForSecretProviderSource } from "./contracts/registry.js";
import { loadBundledSecretProviderEntriesFromDir } from "./secret-provider-public-artifacts.js";
import type { PluginSecretProviderEntry } from "./secret-provider-types.js";

// Dispatch shape vs document-extractor: this seam intentionally has no
// `secret-providers.runtime.ts` (no runtime registry materialization). The
// secrets resolver at `src/secrets/resolve.ts` dispatches directly into this
// helper via dynamic import the first time a non-built-in source is referenced.
// That keeps the cold path manifest-only and avoids materializing an unused
// runtime registry; document-extractor takes a different shape because its
// caller iterates all enabled extractors per request.
//
// Cache is per-source. The lookup is currently fully synchronous after the
// initial dynamic import in `resolve.ts`, so concurrent first-time lookups for
// the same source cannot double-load the artifact today. If a future refactor
// makes `loadBundledSecretProviderEntriesFromDir` async, switch this Map to
// cache promises (`Map<string, Promise<...>>`) to avoid a load race.
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
