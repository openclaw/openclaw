import { createLegacyPluginSdkProviderProjection } from "../plugins/legacy-sdk-provider-projection.js";
import { resolvePluginProvidersCore } from "../plugins/providers.runtime.js";

export { augmentModelCatalogWithProviderPlugins } from "../plugins/provider-runtime.js";
export {
  resolveCatalogHookProviderPluginIds,
  resolveOwningPluginIdsForProvider,
} from "../plugins/providers.js";
export { isPluginProvidersLoadInFlight } from "../plugins/providers.runtime.js";

/** Bare provider callbacks retain borrowed resources until their SDK host closes. */
function resolvePluginProvidersForSdk(params: Parameters<typeof resolvePluginProvidersCore>[0]) {
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

export { resolvePluginProvidersForSdk as resolvePluginProviders };
