// Public provider-catalog runtime seams for provider plugin contract tests.
import { getLegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { resolvePluginProvidersCore } from "../plugins/providers.runtime.js";
import { getPluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";

export { augmentModelCatalogWithProviderPlugins } from "../plugins/provider-runtime.js";
export {
  resolveCatalogHookProviderPluginIds,
  resolveOwningPluginIdsForProvider,
} from "../plugins/providers.js";
export { isPluginProvidersLoadInFlight } from "../plugins/providers.runtime.js";

/** Bare provider callbacks retain borrowed resources until their SDK host closes. */
function resolvePluginProvidersForSdk(params: Parameters<typeof resolvePluginProvidersCore>[0]) {
  const selected: {
    borrowed?: {
      host: ReturnType<typeof getLegacyPluginSdkResourceHost>;
      source: NonNullable<ReturnType<typeof getPluginRegistryInspectionResources>>;
      claim: { release: () => Promise<void> };
    };
  } = {};
  try {
    const providers = resolvePluginProvidersCore(params, (registry) => {
      const source = getPluginRegistryInspectionResources(registry);
      if (source) {
        const host = getLegacyPluginSdkResourceHost();
        host.assertOpen();
        selected.borrowed = { host, source, claim: source.retain() };
      }
    });
    if (selected.borrowed) {
      selected.borrowed.host.adopt(selected.borrowed.source, selected.borrowed.claim);
      selected.borrowed = undefined;
    }
    return providers;
  } catch (error) {
    if (selected.borrowed) {
      selected.borrowed.host.releaseClaim(selected.borrowed.claim);
    }
    throw error;
  }
}

export { resolvePluginProvidersForSdk as resolvePluginProviders };
