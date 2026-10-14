import { nativePluginBindings } from "./loader-runtime-load.js";
export const {
  isProviderApiKeyConfiguredAsync,
  listUsableProviderAuthProfileIdsAsync,
  isProviderAuthProfileConfiguredAsync,
  resolveProviderAuthProfileApiKey,
} = nativePluginBindings.authAvailability;

/** @deprecated Use isProviderApiKeyConfiguredAsync. Final compatibility day: 2026-12-31. */
export const isProviderApiKeyConfigured =
  nativePluginBindings.authAvailability.isProviderApiKeyConfigured;
/** @deprecated Use listUsableProviderAuthProfileIdsAsync. Final compatibility day: 2026-12-31. */
export const listUsableProviderAuthProfileIds =
  nativePluginBindings.authAvailability.listUsableProviderAuthProfileIds;
/** @deprecated Use isProviderAuthProfileConfiguredAsync. Final compatibility day: 2026-12-31. */
export const isProviderAuthProfileConfigured =
  nativePluginBindings.authAvailability.isProviderAuthProfileConfigured;
