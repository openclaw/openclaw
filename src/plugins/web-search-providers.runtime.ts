import type { PluginWebSearchProviderEntry } from "./types.js";
import { resolveBundledWebSearchProvidersFromPublicArtifacts } from "./web-provider-public-artifacts.js";
import {
  mapRegistryProviders,
  resolveBundledWebProviderResolutionConfig,
  resolveManifestDeclaredWebProviderCandidatePluginIds,
} from "./web-provider-resolution-shared.js";
import {
  resolvePluginWebProviders,
  resolvePluginWebProvidersAsync,
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
    mapRegistryProviders({ registry, entries: registry.webSearchProviders, onlyPluginIds }),
} satisfies WebProviderRuntimeResolution<PluginWebSearchProviderEntry>;

/** @deprecated Use resolvePluginWebSearchProvidersAsync for cold discovery. */
export function resolvePluginWebSearchProviders(
  params: Omit<ResolvePluginWebProvidersParams, "sandboxed">,
): PluginWebSearchProviderEntry[] {
  return resolvePluginWebProviders(params, {
    ...providerResolution,
    resolveBundledPublicArtifactProviders: resolveBundledWebSearchProvidersFromPublicArtifacts,
  });
}

/** @deprecated Use resolveRuntimeWebSearchProvidersAsync for cold discovery. */
export function resolveRuntimeWebSearchProviders(
  params: ResolveRuntimeWebProvidersParams,
): PluginWebSearchProviderEntry[] {
  return resolvePluginWebProviders(params, providerResolution);
}

/** Resolves plugin web search providers after preparing worker-owned metadata. */
export function resolvePluginWebSearchProvidersAsync(
  params: Omit<ResolvePluginWebProvidersParams, "sandboxed">,
): Promise<PluginWebSearchProviderEntry[]> {
  return resolvePluginWebProvidersAsync(params, {
    ...providerResolution,
    resolveBundledPublicArtifactProviders: resolveBundledWebSearchProvidersFromPublicArtifacts,
  });
}

/** Resolves executable providers before their synchronous tool factories are consumed. */
export function resolveRuntimeWebSearchProvidersAsync(
  params: ResolveRuntimeWebProvidersParams,
): Promise<PluginWebSearchProviderEntry[]> {
  return resolvePluginWebProvidersAsync(params, providerResolution);
}
