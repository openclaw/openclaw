import { isRecord } from "../utils.js";
import { loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader.js";
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isWebSearchProviderPlugin(value: unknown): value is WebSearchProviderPlugin {
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

function isWebFetchProviderPlugin(value: unknown): value is WebFetchProviderPlugin {
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

function collectProviderFactories<TProvider>(params: {
  mod: Record<string, unknown>;
  suffix: string;
  isProvider: (value: unknown) => value is TProvider;
}): TProvider[] {
  const providers: TProvider[] = [];
  for (const [name, exported] of Object.entries(params.mod).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      typeof exported !== "function" ||
      exported.length !== 0 ||
      !name.startsWith("create") ||
      !name.endsWith(params.suffix)
    ) {
      continue;
    }
    const candidate = exported();
    if (params.isProvider(candidate)) {
      providers.push(candidate);
    }
  }
  return providers;
}

function tryLoadBundledPublicArtifactModule(params: {
  dirName: string;
  artifactCandidates: readonly string[];
}): Record<string, unknown> | null {
  for (const artifactBasename of params.artifactCandidates) {
    try {
      return loadBundledPluginPublicArtifactModuleSync<Record<string, unknown>>({
        dirName: params.dirName,
        artifactBasename,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Unable to resolve bundled plugin public surface ")
      ) {
        continue;
      }
      throw error;
    }
  }
  return null;
}

function normalizeExplicitBundledPluginIds(pluginIds: readonly string[]): string[] {
  return [...new Set(pluginIds)].toSorted((left, right) => left.localeCompare(right));
}

export function loadBundledWebSearchProviderEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginWebSearchProviderEntry[] | null {
  const mod = tryLoadBundledPublicArtifactModule({
    dirName: params.dirName,
    artifactCandidates: WEB_SEARCH_ARTIFACT_CANDIDATES,
  });
  if (!mod) {
    return null;
  }
  const providers = collectProviderFactories({
    mod,
    suffix: "WebSearchProvider",
    isProvider: isWebSearchProviderPlugin,
  });
  if (providers.length === 0) {
    return null;
  }
  return providers.map((provider) => ({ ...provider, pluginId: params.pluginId }));
}

export function loadBundledWebFetchProviderEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginWebFetchProviderEntry[] | null {
  const mod = tryLoadBundledPublicArtifactModule({
    dirName: params.dirName,
    artifactCandidates: WEB_FETCH_ARTIFACT_CANDIDATES,
  });
  if (!mod) {
    return null;
  }
  const providers = collectProviderFactories({
    mod,
    suffix: "WebFetchProvider",
    isProvider: isWebFetchProviderPlugin,
  });
  if (providers.length === 0) {
    return null;
  }
  return providers.map((provider) => ({ ...provider, pluginId: params.pluginId }));
}

export function resolveBundledExplicitWebSearchProvidersFromPublicArtifacts(params: {
  onlyPluginIds: readonly string[];
}): PluginWebSearchProviderEntry[] | null {
  const providers: PluginWebSearchProviderEntry[] = [];
  for (const pluginId of normalizeExplicitBundledPluginIds(params.onlyPluginIds)) {
    const loadedProviders = loadBundledWebSearchProviderEntriesFromDir({
      dirName: pluginId,
      pluginId,
    });
    if (!loadedProviders) {
      return null;
    }
    providers.push(...loadedProviders);
  }
  return providers;
}

export function resolveBundledExplicitWebFetchProvidersFromPublicArtifacts(params: {
  onlyPluginIds: readonly string[];
}): PluginWebFetchProviderEntry[] | null {
  const providers: PluginWebFetchProviderEntry[] = [];
  for (const pluginId of normalizeExplicitBundledPluginIds(params.onlyPluginIds)) {
    const loadedProviders = loadBundledWebFetchProviderEntriesFromDir({
      dirName: pluginId,
      pluginId,
    });
    if (!loadedProviders) {
      return null;
    }
    providers.push(...loadedProviders);
  }
  return providers;
}
