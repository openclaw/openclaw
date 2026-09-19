/** Runtime resolver for plugin-contributed web fetch providers. */
import type { PluginWebFetchProviderEntry } from "./types.js";
import {
  resolveBundledRuntimeWebFetchProvidersFromPublicArtifacts,
  resolveBundledWebFetchProvidersFromPublicArtifacts,
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
    resolveBundledWebProviderResolutionConfig({ ...params, contract: "webFetchProviders" }),
  resolveCandidatePluginIds: (params) =>
    resolveManifestDeclaredWebProviderCandidatePluginIds({
      ...params,
      contract: "webFetchProviders",
      configKey: "webFetch",
    }),
  mapRegistryProviders: ({ registry, onlyPluginIds }) =>
    mapRegistryProviders({ entries: registry.webFetchProviders, onlyPluginIds }),
} satisfies WebProviderRuntimeResolution<PluginWebFetchProviderEntry>;

/** Resolves web fetch providers, activating plugin runtimes when requested. */
export function resolvePluginWebFetchProviders(
  params: ResolvePluginWebProvidersParams,
): PluginWebFetchProviderEntry[] {
  return resolvePluginWebProviders(params, {
    ...providerResolution,
    resolveBundledPublicArtifactProviders: resolveBundledWebFetchProvidersFromPublicArtifacts,
    resolveBundledRuntimeArtifactProviders:
      resolveBundledRuntimeWebFetchProvidersFromPublicArtifacts,
  });
}

/** Resolves already-eligible runtime web fetch providers without setup-mode activation. */
export function resolveRuntimeWebFetchProviders(
  params: ResolveRuntimeWebProvidersParams,
): PluginWebFetchProviderEntry[] {
  return resolvePluginWebProviders(params, {
    ...providerResolution,
    resolveBundledRuntimeArtifactProviders:
      resolveBundledRuntimeWebFetchProvidersFromPublicArtifacts,
  });
}
