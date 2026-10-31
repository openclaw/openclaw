import { nativePluginBindings } from "./loader-runtime-load.js";
export const {
  isPluginProvidersLoadInFlight,
  resolvePluginProviderRegistryCore,
  resolvePluginProvidersCore,
  withPluginProviderRegistry,
  withPluginProviders,
} = nativePluginBindings.providerRegistry;
