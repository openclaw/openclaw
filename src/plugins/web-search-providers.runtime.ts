// Runtime bridge for web-search providers supplied by plugins.
import type { PluginWebSearchProviderEntry } from "./types.js";
import {
  resolveBundledWebSearchProvidersFromPublicArtifacts,
  resolveEnabledBundledWebSearchProvidersFromPublicArtifacts,
} from "./web-provider-public-artifacts.js";
import {
  mapRegistryProviders,
  resolveBundledWebProviderResolutionConfig,
  resolveManifestDeclaredWebProviderCandidatePluginIds,
} from "./web-provider-resolution-shared.js";
import {
  resolvePluginWebProviders,
  type ResolvePluginWebProvidersParams,
  type ResolveRuntimeWebProvidersParams,
  type WebProviderRuntimeResolution,
} from "./web-provider-runtime-shared.js";

const providerResolution = {
  resolveBundledResolutionConfig: (params) =>
    resolveBundledWebProviderResolutionConfig({ ...params, contract: "webSearchProviders" }),
  resolveCandidatePluginIds: (params) =>
    resolveManifestDeclaredWebProviderCandidatePluginIds({
      ...params,
      contract: "webSearchProviders",
      configKey: "webSearch",
    }),
  mapRegistryProviders: ({ registry, onlyPluginIds }) =>
    mapRegistryProviders({ entries: registry.webSearchProviders, onlyPluginIds }),
} satisfies WebProviderRuntimeResolution<PluginWebSearchProviderEntry>;

function resolveLazyBundledWebSearchProviders(
  params: Parameters<typeof resolveEnabledBundledWebSearchProvidersFromPublicArtifacts>[0],
): PluginWebSearchProviderEntry[] | null {
  const providers = resolveEnabledBundledWebSearchProvidersFromPublicArtifacts(params);
  return (
    providers?.map((provider) => {
      const lazyProvider = Object.assign({}, provider);
      lazyProvider.createTool = (context) => {
        // Public descriptors can have setup-only factories; execution belongs to the scoped registry.
        const runtime = resolvePluginWebProviders(
          { ...params, onlyPluginIds: [provider.pluginId] },
          providerResolution,
        ).find((entry) => entry.pluginId === provider.pluginId && entry.id === provider.id);
        return runtime?.createTool(context) ?? null;
      };
      return lazyProvider;
    }) ?? null
  );
}

/** Resolves web search providers, activating plugin runtimes when requested. */
export function resolvePluginWebSearchProviders(
  params: ResolvePluginWebProvidersParams,
): PluginWebSearchProviderEntry[] {
  return resolvePluginWebProviders(params, {
    ...providerResolution,
    resolveBundledPublicArtifactProviders: resolveBundledWebSearchProvidersFromPublicArtifacts,
  });
}

/** Resolves already-eligible runtime web search providers without setup-mode activation. */
export function resolveRuntimeWebSearchProviders(
  params: ResolveRuntimeWebProvidersParams,
): PluginWebSearchProviderEntry[] {
  return resolvePluginWebProviders(params, {
    ...providerResolution,
    resolveBundledRuntimeArtifactProviders: resolveLazyBundledWebSearchProviders,
  });
}
