// Standalone runtime registry loader builds plugin runtime registries outside gateway startup.
import {
  type ActiveRuntimePluginRegistrySurface,
  getLoadedRuntimePluginRegistry,
} from "../active-runtime-registry.js";
import {
  resolveRequiredFinalToolInputPolicyOwnerIds,
} from "../final-tool-input-policy-requirements.js";
import { loadOpenClawPlugins, type PluginLoadOptions } from "../loader.js";
import { normalizePluginIdScope } from "../plugin-scope.js";
import type { PluginRegistry } from "../registry-types.js";
import { pinActivePluginChannelRegistry, pinActivePluginHttpRouteRegistry } from "../runtime.js";

function includeRequiredFinalToolInputPolicyOwners(
  loadOptions: PluginLoadOptions,
): PluginLoadOptions {
  const requestedPluginIds = normalizePluginIdScope(loadOptions.onlyPluginIds);
  if (requestedPluginIds === undefined) {
    return loadOptions;
  }
  const requiredPolicyOwnerIds =
    normalizePluginIdScope([
      ...resolveRequiredFinalToolInputPolicyOwnerIds(loadOptions.config),
      ...resolveRequiredFinalToolInputPolicyOwnerIds(loadOptions.activationSourceConfig),
    ]) ?? [];
  if (requiredPolicyOwnerIds.length === 0) {
    return loadOptions;
  }
  const onlyPluginIds =
    normalizePluginIdScope([...requestedPluginIds, ...requiredPolicyOwnerIds]) ?? [];
  if (
    onlyPluginIds.length === requestedPluginIds.length &&
    onlyPluginIds.every((pluginId, index) => pluginId === requestedPluginIds[index])
  ) {
    return loadOptions;
  }
  // Scoped standalone loads must carry operator-required policy owners through
  // compatibility lookup and cold load; otherwise a fresh registry omits a
  // security dependency that active-registry checks treat as mandatory.
  return { ...loadOptions, onlyPluginIds };
}

export function ensureStandaloneRuntimePluginRegistryLoaded(params: {
  loadOptions: PluginLoadOptions;
  forceLoad?: boolean;
  requiredPluginIds?: readonly string[];
  surface?: ActiveRuntimePluginRegistrySurface;
}): PluginRegistry | undefined {
  const loadOptions = includeRequiredFinalToolInputPolicyOwners(params.loadOptions);
  const requiredPluginIds = params.requiredPluginIds ?? loadOptions.onlyPluginIds;
  const surface = params.surface ?? "active";
  if (!params.forceLoad) {
    const existing = getLoadedRuntimePluginRegistry({
      env: loadOptions.env,
      loadOptions,
      workspaceDir: loadOptions.workspaceDir,
      requiredPluginIds,
      surface,
    });
    if (existing) {
      return existing;
    }
  }

  const effectiveLoadOptions = params.forceLoad
    ? { ...loadOptions, cache: false }
    : loadOptions;
  const registry = loadOpenClawPlugins(effectiveLoadOptions);
  if (loadOptions.activate !== false) {
    switch (surface) {
      case "active":
        break;
      case "channel":
        pinActivePluginChannelRegistry(registry);
        break;
      case "http-route":
        pinActivePluginHttpRouteRegistry(registry);
        break;
    }
    return registry;
  }
  // activate:false is always a request-local snapshot. Promoting it here would bypass the
  // loader's validated, sealed activation path and could replace live security policies.
  return registry;
}
