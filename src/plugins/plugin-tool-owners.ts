// Live tool-owner reuse for plugin tool assembly. Metadata completion can
// surface owners that a narrowed prepared generation never admitted; without
// reuse, every assembly would classify those owners as missing and re-import
// already-admitted plugins synchronously on the caller's thread through the
// discovery path (toolDiscovery disables runtime-registration borrowing and
// uses a different cache identity), rebuilding their stores each time.
import {
  createRuntimePluginManifestLookup,
  getLoadedRuntimePluginRegistry,
} from "./active-runtime-registry.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import type { PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistryWorkspaceDir } from "./runtime.js";
import { getPluginRuntimeLoadContextState } from "./runtime/load-context-state.js";

/**
 * Collect live registrations for the requested plugin ids, preferring the
 * serving registry and then the host's retained full registry (the Gateway's
 * startup registrations). Owners already registered by the host resolve through
 * that retained registry; the discovery-path cold load stays reserved for
 * genuinely absent standalone owners.
 *
 * Reuse constraints:
 * - Matching disabled/error prepared records are settled generation outcomes
 *   (#164594) and are never overridden; retained registrations cannot revive
 *   an owner the prepared generation already settled as disabled or failed.
 * - The retained registry must share the prepared generation's registration
 *   inputs (registration config key) and workspace. A caller with different
 *   plugin configuration would otherwise receive closures registered under
 *   another config; such callers keep cold loading.
 */
export function collectRetainedToolOwners(params: {
  onlyPluginIds: readonly string[];
  snapshotPlugins: readonly PluginManifestRecord[];
  runtimeRegistry?: PluginRegistry;
  preparedRegistry?: PluginRegistry;
  settledPreparedPluginIds?: ReadonlySet<string>;
  workspaceDir?: string;
}): Map<string, { registry: PluginRegistry }> {
  const retainedRegistry =
    params.runtimeRegistry && params.runtimeRegistry === params.preparedRegistry
      ? resolveCompatibleRetainedRegistry({
          runtimeRegistry: params.runtimeRegistry,
          preparedRegistry: params.preparedRegistry,
          workspaceDir: params.workspaceDir,
        })
      : undefined;
  const sources = [
    ...(params.runtimeRegistry
      ? [
          {
            registry: params.runtimeRegistry,
            lookup: createRuntimePluginManifestLookup(
              params.runtimeRegistry,
              params.snapshotPlugins,
            ),
          },
        ]
      : []),
    ...(retainedRegistry && retainedRegistry !== params.runtimeRegistry
      ? [
          {
            registry: retainedRegistry,
            lookup: createRuntimePluginManifestLookup(retainedRegistry, params.snapshotPlugins),
          },
        ]
      : []),
  ];
  const owners = new Map<string, { registry: PluginRegistry }>();
  for (const pluginId of params.onlyPluginIds) {
    if (params.settledPreparedPluginIds?.has(pluginId)) {
      continue;
    }
    for (const source of sources) {
      const record = source.lookup(pluginId);
      const instance = record && getPluginInstance(record);
      if (
        instance &&
        (instance.toolRegistrationComplete ||
          source.registry.tools.some((entry) => entry.pluginId === pluginId))
      ) {
        owners.set(pluginId, { registry: source.registry });
        break;
      }
    }
  }
  return owners;
}

/**
 * The host's retained registry is only reusable when it was built from the same
 * registration inputs as the prepared generation: same workspace and same
 * registration config key (the plugin config captured by registered closures).
 * Registries without recorded load-context state cannot prove compatibility and
 * are not reused.
 */
function resolveCompatibleRetainedRegistry(params: {
  runtimeRegistry: PluginRegistry;
  preparedRegistry?: PluginRegistry;
  workspaceDir?: string;
}): PluginRegistry | undefined {
  const candidate = getLoadedRuntimePluginRegistry({ workspaceDir: params.workspaceDir });
  if (!candidate || candidate === params.runtimeRegistry) {
    return undefined;
  }
  const preparedState = getPluginRuntimeLoadContextState(params.preparedRegistry);
  const retainedState = getPluginRuntimeLoadContextState(candidate);
  if (!preparedState || !retainedState) {
    return undefined;
  }
  if (preparedState.registrationConfigKey !== retainedState.registrationConfigKey) {
    return undefined;
  }
  const activeWorkspaceDir = getActivePluginRegistryWorkspaceDir();
  if ((activeWorkspaceDir ?? undefined) !== (params.workspaceDir ?? undefined)) {
    return undefined;
  }
  return candidate;
}
