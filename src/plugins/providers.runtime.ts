import { nativePluginBindings } from "./loader-runtime-load.js";
export const {
  isPluginProvidersLoadInFlight,
  resolvePluginProvidersCore,
  resolvePluginProvidersCoreAsync,
} = nativePluginBindings.providerRegistry;
