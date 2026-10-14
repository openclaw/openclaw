import { nativePluginBindings } from "./loader-runtime-load.js";
export const {
  isProviderApiKeyConfiguredAsync,
  listUsableProviderAuthProfileIdsAsync,
  isProviderAuthProfileConfiguredAsync,
  resolveProviderAuthProfileApiKey,
} = nativePluginBindings.authAvailability;

/** @deprecated Use isProviderApiKeyConfiguredAsync. Retained until an announced stable removal window. */
export const isProviderApiKeyConfigured =
  nativePluginBindings.authAvailability.isProviderApiKeyConfigured;
/** @deprecated Use listUsableProviderAuthProfileIdsAsync. Retained until an announced stable removal window. */
export const listUsableProviderAuthProfileIds =
  nativePluginBindings.authAvailability.listUsableProviderAuthProfileIds;
/** @deprecated Use isProviderAuthProfileConfiguredAsync. Retained until an announced stable removal window. */
export const isProviderAuthProfileConfigured =
  nativePluginBindings.authAvailability.isProviderAuthProfileConfigured;
