import { nativePluginBindings } from "./loader-runtime-load.js";
export const {
  isProviderApiKeyConfigured,
  isProviderApiKeyConfiguredAsync,
  listUsableProviderAuthProfileIds,
  listUsableProviderAuthProfileIdsAsync,
  isProviderAuthProfileConfigured,
  isProviderAuthProfileConfiguredAsync,
  resolveProviderAuthProfileApiKey,
} = nativePluginBindings.authAvailability;
