// Merges a standalone (publish:false) plugin registry, built for a specific
// set of missing plugin ids, into an already-active plugin registry without
// touching that active registry's existing entries. Used by scoped harness
// activation (see ensureScopedPluginsLoadedPreservingActive) so a plugin id
// that isn't yet loaded can be added to the live registry without evicting
// (and re-registering) every other plugin already active in it.
import type { PluginRecord, PluginRegistry } from "./registry-types.js";

function hasStringPluginId(value: unknown): value is { pluginId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { pluginId?: unknown }).pluginId === "string"
  );
}

function mergePluginRecords(
  target: PluginRecord[],
  source: readonly PluginRecord[],
  missingPluginIds: ReadonlySet<string>,
): void {
  for (const record of source) {
    if (!missingPluginIds.has(record.id)) {
      continue;
    }
    // Replace rather than duplicate: a stale disabled/error record can already
    // exist for a plugin id that previously failed to load in the active
    // registry.
    const staleIndex = target.findIndex((existing) => existing.id === record.id);
    if (staleIndex >= 0) {
      target.splice(staleIndex, 1);
    }
    target.push(record);
  }
}

/**
 * Mutates `target` (the live active registry) in place, copying in every
 * registration from `source` (a standalone registry loaded with
 * `onlyPluginIds: missingPluginIds, publish: false`) that belongs to one of
 * `missingPluginIds`. Entries already present in `target` are left untouched
 * — this never re-adds or duplicates a plugin id `target` already has.
 */
export function mergeMissingPluginRegistryInto(
  target: PluginRegistry,
  source: PluginRegistry,
  missingPluginIds: readonly string[],
): void {
  const missing = new Set(missingPluginIds);
  if (missing.size === 0) {
    return;
  }

  mergePluginRecords(target.plugins, source.plugins, missing);

  for (const key of Object.keys(target) as (keyof PluginRegistry)[]) {
    if (key === "plugins") {
      continue;
    }
    const targetValue = target[key];
    const sourceValue = source[key];
    if (!Array.isArray(targetValue) || !Array.isArray(sourceValue)) {
      // Non-array surfaces (workerProviders is a Map, gatewayHandlers is a
      // plain object keyed by method name, coreGatewayMethodNames is a flat
      // string[] with no per-entry pluginId) are handled explicitly below.
      continue;
    }
    for (const entry of sourceValue) {
      if (hasStringPluginId(entry) && missing.has(entry.pluginId)) {
        (targetValue as unknown[]).push(entry);
      }
    }
  }

  for (const [providerId, registration] of source.workerProviders) {
    if (missing.has(registration.pluginId) && !target.workerProviders.has(providerId)) {
      target.workerProviders.set(providerId, registration);
    }
  }

  for (const [methodName, handler] of Object.entries(source.gatewayHandlers)) {
    if (!(methodName in target.gatewayHandlers)) {
      target.gatewayHandlers[methodName] = handler;
    }
  }
}
