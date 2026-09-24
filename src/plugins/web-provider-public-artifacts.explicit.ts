// Extracts explicit public artifacts from web provider plugin manifests.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { loadBundledPublicArtifactEntries } from "./public-artifact-factories.js";
import type {
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
  WebFetchProviderPlugin,
  WebSearchProviderPlugin,
} from "./types.js";

const WEB_SEARCH_ARTIFACT_CANDIDATES = [
  "web-search-contract-api.js",
  "web-search-provider.js",
  "web-search.js",
] as const;
const WEB_FETCH_ARTIFACT_CANDIDATES = [
  "web-fetch-contract-api.js",
  "web-fetch-provider.js",
  "web-fetch.js",
] as const;
const WEB_FETCH_RUNTIME_ARTIFACT_CANDIDATES = ["web-fetch-provider.js", "web-fetch.js"] as const;

export type BundledExplicitWebProviderParams = {
  onlyPluginIds: readonly string[];
  env?: NodeJS.ProcessEnv;
  manifestRecords?: readonly PluginManifestRecord[];
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isWebProviderPlugin(
  value: unknown,
): value is WebSearchProviderPlugin | WebFetchProviderPlugin {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    typeof value.hint === "string" &&
    isStringArray(value.envVars) &&
    typeof value.placeholder === "string" &&
    typeof value.signupUrl === "string" &&
    typeof value.credentialPath === "string" &&
    typeof value.getCredentialValue === "function" &&
    typeof value.setCredentialValue === "function" &&
    typeof value.createTool === "function"
  );
}

function resolveBundledExplicitProviders<TProvider extends object>(
  params: BundledExplicitWebProviderParams & {
    artifactCandidates: readonly string[];
    suffix: string;
    isArtifact: (value: unknown) => value is TProvider;
  },
): Array<TProvider & { pluginId: string }> | null {
  const providers: Array<TProvider & { pluginId: string }> = [];
  const owners =
    params.manifestRecords && new Map(params.manifestRecords.map((record) => [record.id, record]));
  // Sorted plugin IDs plus each module's sorted factories preserve stable
  // plugin and factory ordering across all three explicit resolution paths.
  for (const pluginId of sortUniqueStrings(params.onlyPluginIds)) {
    const owner = owners?.get(pluginId);
    if (owners && owner?.origin !== "bundled") {
      return null;
    }
    const loadedProviders = loadBundledPublicArtifactEntries({
      ...params,
      dirName: pluginId,
      pluginId,
      owner,
      partialFailureLabel: "web providers",
    });
    if (!loadedProviders) {
      return null;
    }
    providers.push(...loadedProviders);
  }
  return providers;
}

export function resolveBundledExplicitWebSearchProvidersFromPublicArtifacts(
  params: BundledExplicitWebProviderParams,
): PluginWebSearchProviderEntry[] | null {
  return resolveBundledExplicitProviders({
    ...params,
    artifactCandidates: WEB_SEARCH_ARTIFACT_CANDIDATES,
    suffix: "WebSearchProvider",
    isArtifact: (value): value is WebSearchProviderPlugin => isWebProviderPlugin(value),
  });
}

export function resolveBundledExplicitWebFetchProvidersFromPublicArtifacts(
  params: BundledExplicitWebProviderParams,
): PluginWebFetchProviderEntry[] | null {
  return resolveBundledExplicitProviders({
    ...params,
    artifactCandidates: WEB_FETCH_ARTIFACT_CANDIDATES,
    suffix: "WebFetchProvider",
    isArtifact: (value): value is WebFetchProviderPlugin => isWebProviderPlugin(value),
  });
}

export function resolveBundledExplicitRuntimeWebFetchProvidersFromPublicArtifacts(
  params: BundledExplicitWebProviderParams,
): PluginWebFetchProviderEntry[] | null {
  return resolveBundledExplicitProviders({
    ...params,
    artifactCandidates: WEB_FETCH_RUNTIME_ARTIFACT_CANDIDATES,
    suffix: "WebFetchProvider",
    isArtifact: (value): value is WebFetchProviderPlugin => isWebProviderPlugin(value),
  });
}
