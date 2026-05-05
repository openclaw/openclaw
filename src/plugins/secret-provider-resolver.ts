import type { OpenClawConfig } from "../config/types.js";
import { resolveBundledPluginIdForSecretProviderSource } from "./contracts/registry.js";
import { isPluginEnabled } from "./plugin-registry-snapshot.js";
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
// Cache rules:
//   - Successful artifact loads are cached by source id (the artifact itself
//     does not change at runtime).
//   - `null` is a sentinel for "no bundled plugin owns this source" or "the
//     plugin's artifact does not export a matching factory" — both stable
//     conditions safe to cache.
//   - Activation results (whether the owning plugin is currently enabled) are
//     NEVER cached — config can change between calls (e.g. operator toggles a
//     plugin) so we recheck `isPluginEnabled` on every lookup.
//
// If a future refactor makes `loadBundledSecretProviderEntriesFromDir` async,
// switch this Map to cache promises (`Map<string, Promise<...>>`) to avoid a
// load race.
const cache = new Map<string, PluginSecretProviderEntry | null>();

export function _resetSecretProviderResolverCache(): void {
  cache.clear();
}

/**
 * Find which bundled plugin owns the given secret-provider source id (e.g.
 * "gcp"), verify that the owning plugin is enabled in the current config, and
 * lazy-load its public artifact.
 *
 * Returns undefined when:
 *   - no bundled plugin declares the source
 *   - the owning plugin is disabled (global `plugins.enabled: false`,
 *     denylist, entry `enabled: false`, allowlist miss for default-off, etc.)
 *   - the plugin's artifact does not export a matching factory
 *
 * The activation gate is a security boundary: a SecretRef referencing a
 * source whose owning plugin is disabled must not execute that plugin's
 * artifact, since the artifact can spawn credential CLIs (`secret-tool`,
 * `security`) or open cloud SDK clients.
 */
export async function resolveBundledSecretProviderForSource(
  source: string,
  config: OpenClawConfig,
): Promise<PluginSecretProviderEntry | undefined> {
  if (cache.has(source)) {
    const cached = cache.get(source);
    if (cached === null || cached === undefined) {
      return undefined;
    }
    // Recheck activation on cache hit — the artifact is cached but the
    // plugin's enabled state is not.
    if (!isPluginEnabled({ pluginId: cached.pluginId, config })) {
      return undefined;
    }
    return cached;
  }

  const pluginId = resolveBundledPluginIdForSecretProviderSource(source);
  if (!pluginId) {
    cache.set(source, null);
    return undefined;
  }

  // Activation gate: bail out before loading the artifact when the owning
  // plugin is not enabled. Don't cache this — config can change between calls.
  if (!isPluginEnabled({ pluginId, config })) {
    return undefined;
  }

  let entries: PluginSecretProviderEntry[] | null;
  try {
    entries = loadBundledSecretProviderEntriesFromDir({
      dirName: pluginId,
      pluginId,
    });
  } catch (err) {
    // Don't cache load failures — they may be transient (missing dep, etc).
    throw new Error(
      `Plugin "${pluginId}" declares secret provider source "${source}" but its artifact failed to load.`,
      { cause: err },
    );
  }
  if (!entries) {
    cache.set(source, null);
    return undefined;
  }

  const match = entries.find((entry) => entry.id === source);
  if (!match) {
    cache.set(source, null);
    return undefined;
  }
  cache.set(source, match);
  return match;
}
