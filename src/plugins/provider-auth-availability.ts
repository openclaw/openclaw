import { nativePluginBindings } from "./loader-runtime-load.js";
export const {
  isProviderApiKeyConfiguredAsync,
  listUsableProviderAuthProfileIdsAsync,
  isProviderAuthProfileConfiguredAsync,
  resolveProviderAuthProfileApiKey,
} = nativePluginBindings.authAvailability;

/** @deprecated Use isProviderApiKeyConfiguredAsync. Removed at the next Plugin SDK major. */
export const isProviderApiKeyConfigured =
  nativePluginBindings.authAvailability.isProviderApiKeyConfigured;
/** @deprecated Use listUsableProviderAuthProfileIdsAsync. Removed at the next Plugin SDK major. */
export const listUsableProviderAuthProfileIds =
  nativePluginBindings.authAvailability.listUsableProviderAuthProfileIds;
/** @deprecated Use isProviderAuthProfileConfiguredAsync. Removed at the next Plugin SDK major. */
export const isProviderAuthProfileConfigured =
  nativePluginBindings.authAvailability.isProviderAuthProfileConfigured;
