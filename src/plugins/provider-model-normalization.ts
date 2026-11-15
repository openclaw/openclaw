/** Batch-local provider selection for catalog model normalization. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  ensureProviderRuntimePluginHandle,
  resolveProviderPluginsForHooks,
  type ProviderRuntimePluginHandle,
} from "./provider-hook-runtime.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import {
  applyProviderResolvedTransportWithPlugin,
  normalizeProviderResolvedModelWithPlugin,
} from "./provider-runtime.js";
import type { ProviderNormalizeResolvedModelContext, ProviderPlugin } from "./types.js";

/** Reuses provider selection only within one synchronous catalog normalization pass. */
export function createProviderModelNormalizer(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const handles = new Map<string, ProviderRuntimePluginHandle>();
  let fallbackPlugins: readonly ProviderPlugin[] | undefined;
  const resolveFallbackPlugins = () => (fallbackPlugins ??= resolveProviderPluginsForHooks(params));
  const resolveHandle = (provider: string, modelId: string) => {
    const handle = ensureProviderRuntimePluginHandle({
      ...params,
      provider,
      modelId,
      runtimeHandle: handles.get(provider),
    });
    handles.set(provider, handle);
    return handle;
  };
  return (context: ProviderNormalizeResolvedModelContext): ProviderRuntimeModel => {
    const provider = context.provider;
    const runtimeHandle = resolveHandle(provider, context.modelId);
    const model =
      normalizeProviderResolvedModelWithPlugin({ ...params, provider, runtimeHandle, context }) ??
      context.model;
    const transportProvider = context.model.provider;
    return (
      applyProviderResolvedTransportWithPlugin({
        ...params,
        provider: transportProvider,
        runtimeHandle: resolveHandle(transportProvider, context.model.id),
        resolveFallbackPlugins,
        context: { ...context, provider: transportProvider, modelId: context.model.id, model },
      }) ?? model
    );
  };
}
