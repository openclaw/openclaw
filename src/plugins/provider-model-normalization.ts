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
  normalizeProviderTransportWithPlugin,
} from "./provider-runtime.js";
import type { ProviderNormalizeResolvedModelContext, ProviderPlugin } from "./types.js";

/** Reuses provider selection only within one synchronous catalog normalization pass. */
function createProviderModelNormalizationContext(params: {
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
  return { resolveHandle, resolveFallbackPlugins };
}

export function createProviderModelNormalizationHooks(
  params: Parameters<typeof createProviderModelNormalizationContext>[0],
) {
  const { resolveHandle, resolveFallbackPlugins } = createProviderModelNormalizationContext(params);
  return {
    normalizeProviderResolvedModelWithPlugin: (
      input: Parameters<typeof normalizeProviderResolvedModelWithPlugin>[0],
    ) =>
      normalizeProviderResolvedModelWithPlugin({
        ...input,
        runtimeHandle: resolveHandle(input.provider, input.context.modelId),
      }),
    normalizeProviderTransportWithPlugin: (
      input: Parameters<typeof normalizeProviderTransportWithPlugin>[0],
    ) =>
      normalizeProviderTransportWithPlugin({
        ...input,
        runtimeHandle: resolveHandle(input.provider, input.modelId ?? input.context.modelId ?? ""),
        resolveFallbackPlugins,
      }),
    applyProviderResolvedTransportWithPlugin: (
      input: Parameters<typeof applyProviderResolvedTransportWithPlugin>[0],
    ) =>
      applyProviderResolvedTransportWithPlugin({
        ...input,
        runtimeHandle: resolveHandle(input.provider, input.context.modelId),
        resolveFallbackPlugins,
      }),
  };
}

export function createProviderModelNormalizer(
  params: Parameters<typeof createProviderModelNormalizationHooks>[0],
) {
  const { resolveHandle, resolveFallbackPlugins } = createProviderModelNormalizationContext(params);
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
