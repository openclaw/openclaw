import { normalizeProviderId } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveProviderPluginsForHooks } from "./provider-hook-runtime.js";
import type { ProviderPlugin } from "./types.js";

type PreserveOrderProviderLike = {
  id: string;
  aliases?: string[];
  hookAliases?: string[];
  catalog?: { preserveDiscoveryOrder?: boolean };
};

/**
 * Collect the set of normalized provider ids whose plugin catalog opts into
 * preserveDiscoveryOrder, including each plugin's aliases and hookAliases.
 *
 * Used by list/browse sort paths that keep a provider's curated upstream order
 * intact while still grouping by provider id. Callers own plugin resolution
 * (filtered vs unfiltered) and the error handling around a failed resolution.
 */
export function collectPreserveDiscoveryOrderProviders(
  plugins: Iterable<PreserveOrderProviderLike>,
): Set<string> {
  const result = new Set<string>();
  for (const plugin of plugins) {
    if (plugin.catalog?.preserveDiscoveryOrder !== true) {
      continue;
    }
    for (const id of [plugin.id, ...(plugin.aliases ?? []), ...(plugin.hookAliases ?? [])]) {
      const normalized = normalizeProviderId(id);
      if (normalized) {
        result.add(normalized);
      }
    }
  }
  return result;
}

const preserveOrderLog = createSubsystemLogger("provider-preserve-order");
let hasLoggedPreserveOrderLookupError = false;

export function resetPreserveDiscoveryOrderLookupLogForTest(): void {
  hasLoggedPreserveOrderLookupError = false;
}

/**
 * Resolve the set of normalized provider ids that opt into
 * ProviderPluginCatalog.preserveDiscoveryOrder across every bundled provider
 * plugin.
 *
 * The result is only consulted by sort comparators, which skip providers that
 * aren't in the list being sorted — so returning "too many" ids is harmless.
 * That keeps the API tiny and lets all callers share one cached plugin lookup.
 *
 * Plugin resolution can throw (broken manifest, transient plugin-runtime
 * failure). Any throw is swallowed and dedupe-warn-logged once per process, and
 * the set is returned empty — callers fall back to the default alphabetical
 * sort. This degradation is invisible to users by design: the worst case is
 * losing curated ordering for one list invocation.
 */
export function resolvePreserveDiscoveryOrderProviders(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
}): Set<string> {
  let plugins: ProviderPlugin[] = [];
  try {
    plugins = resolveProviderPluginsForHooks({
      config: params.config,
      env: params.env,
      workspaceDir: params.workspaceDir,
    });
  } catch (error) {
    if (!hasLoggedPreserveOrderLookupError) {
      hasLoggedPreserveOrderLookupError = true;
      preserveOrderLog.warn(
        `Failed to resolve provider plugins for preserve-order flag: ${String(error)}`,
      );
    }
    return new Set<string>();
  }
  return collectPreserveDiscoveryOrderProviders(plugins);
}
