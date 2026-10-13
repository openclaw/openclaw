import { createLegacyPluginSdkProviderProjection } from "../plugins/legacy-sdk-provider-projection.js";
import {
  resolvePluginProvidersCore,
  resolvePluginProvidersCoreAsync,
} from "../plugins/providers.runtime.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";

export { augmentModelCatalogWithProviderPlugins } from "../plugins/provider-runtime.js";
export {
  resolveCatalogHookProviderPluginIds,
  resolveOwningPluginIdsForProvider,
} from "../plugins/providers.js";
export { isPluginProvidersLoadInFlight } from "../plugins/providers.runtime.js";

/**
 * @deprecated Await resolvePluginProvidersAsync; this requires an already loaded registry
 * and will be removed in a later release after stable deprecation.
 */
export function resolvePluginProviders(params: Parameters<typeof resolvePluginProvidersCore>[0]) {
  warnPluginSdkDeprecation({
    family: "provider-catalog-sync-discovery",
    method: "resolvePluginProviders",
    replacement: "resolvePluginProvidersAsync",
    compatibility: "The synchronous API requires an already prepared and loaded provider registry.",
  });
  using projection = createLegacyPluginSdkProviderProjection();
  const providers = resolvePluginProvidersCore(params, (registry) => {
    const project = projection.select(registry);
    return project
      ? (provider, pluginId) => Object.assign({}, project(provider, pluginId), { pluginId })
      : undefined;
  });
  projection.adopt();
  return providers;
}

/** Bare provider callbacks retain borrowed resources until their SDK host closes. */
export async function resolvePluginProvidersAsync(
  params: Parameters<typeof resolvePluginProvidersCoreAsync>[0],
) {
  using projection = createLegacyPluginSdkProviderProjection();
  const providers = await resolvePluginProvidersCoreAsync(params, (registry) => {
    const project = projection.select(registry);
    return project
      ? (provider, pluginId) => Object.assign({}, project(provider, pluginId), { pluginId })
      : undefined;
  });
  projection.adopt();
  return providers;
}
