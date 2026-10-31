import { nativePluginBindings } from "./loader-runtime-load.js";
export const {
  attachModelProviderRuntimePluginHandle,
  getModelProviderRuntimePluginHandle,
  resolveLoadedProviderPluginsForHooks,
  resolveProviderPluginsForHooks,
  resolveProviderRuntimePlugin,
  withProviderRuntimePlugin,
  resolveLoadedProviderRuntimePlugin,
  resolveProviderHookPlugin,
  resolveProviderRuntimePluginHandle,
  ensureProviderRuntimePluginHandle,
  resolveProviderAuthProfileId,
  resolveProviderFollowupFallbackRoute,
  wrapProviderSimpleCompletionStreamFn,
} = nativePluginBindings.providerHooks;
export type { ProviderRuntimePluginHandle } from "./provider-hook-runtime-core.js";
