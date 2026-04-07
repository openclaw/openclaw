import path from "node:path";
import { isRecord } from "../utils.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader.js";
import type {
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
  WebFetchProviderPlugin,
  WebSearchProviderPlugin,
} from "./types.js";
import { resolveBundledWebFetchResolutionConfig } from "./web-fetch-providers.shared.js";
import { resolveManifestDeclaredWebProviderCandidatePluginIds } from "./web-provider-resolution-shared.js";
import { resolveBundledWebSearchResolutionConfig } from "./web-search-providers.shared.js";

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

type BundledWebProviderPublicArtifactParams = {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
};

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

function resolveBundledCandidatePluginIds(params: {
  contract: "webSearchProviders" | "webFetchProviders";
  configKey: "webSearch" | "webFetch";
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
}): string[] {
  if (params.onlyPluginIds && params.onlyPluginIds.length > 0) {
    return [...new Set(params.onlyPluginIds)].toSorted((left, right) => left.localeCompare(right));
  }
  const resolvedConfig =
    params.contract === "webSearchProviders"
      ? resolveBundledWebSearchResolutionConfig(params).config
      : resolveBundledWebFetchResolutionConfig(params).config;
  return (
    resolveManifestDeclaredWebProviderCandidatePluginIds({
      contract: params.contract,
      configKey: params.configKey,
      config: resolvedConfig,
      workspaceDir: params.workspaceDir,
      env: params.env,
      onlyPluginIds: params.onlyPluginIds,
      origin: "bundled",
    }) ?? []
  );
}

function resolveBundledManifestRecordsByPluginId(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds: readonly string[];
}) {
  const allowedPluginIds = new Set(params.onlyPluginIds);
  return new Map(
    loadPluginManifestRegistry({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    })
      .plugins.filter((record) => record.origin === "bundled" && allowedPluginIds.has(record.id))
      .map((record) => [record.id, record] as const),
  );
}

export function resolveBundledWebSearchProvidersFromPublicArtifacts(
  params: BundledWebProviderPublicArtifactParams,
): PluginWebSearchProviderEntry[] | null {
  const pluginIds = resolveBundledCandidatePluginIds({
    contract: "webSearchProviders",
    configKey: "webSearch",
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    bundledAllowlistCompat: params.bundledAllowlistCompat,
    onlyPluginIds: params.onlyPluginIds,
  });
  if (pluginIds.length === 0) {
    return [];
  }
  const recordsByPluginId = resolveBundledManifestRecordsByPluginId({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    onlyPluginIds: pluginIds,
  });
  const providers: PluginWebSearchProviderEntry[] = [];
  for (const pluginId of pluginIds) {
    const record = recordsByPluginId.get(pluginId);
    if (!record) {
      return null;
    }
    const mod = tryLoadBundledPublicArtifactModule({
      dirName: path.basename(record.rootDir),
      artifactCandidates: WEB_SEARCH_ARTIFACT_CANDIDATES,
    });
    if (!mod) {
      return null;
    }
    const loadedProviders = collectProviderFactories({
      mod,
      suffix: "WebSearchProvider",
      isProvider: isWebSearchProviderPlugin,
    });
    if (loadedProviders.length === 0) {
      return null;
    }
    providers.push(...loadedProviders.map((provider) => ({ ...provider, pluginId })));
  }
  return providers;
}

export function resolveBundledWebFetchProvidersFromPublicArtifacts(
  params: BundledWebProviderPublicArtifactParams,
): PluginWebFetchProviderEntry[] | null {
  const pluginIds = resolveBundledCandidatePluginIds({
    contract: "webFetchProviders",
    configKey: "webFetch",
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    bundledAllowlistCompat: params.bundledAllowlistCompat,
    onlyPluginIds: params.onlyPluginIds,
  });
  if (pluginIds.length === 0) {
    return [];
  }
  const recordsByPluginId = resolveBundledManifestRecordsByPluginId({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    onlyPluginIds: pluginIds,
  });
  const providers: PluginWebFetchProviderEntry[] = [];
  for (const pluginId of pluginIds) {
    const record = recordsByPluginId.get(pluginId);
    if (!record) {
      return null;
    }
    const mod = tryLoadBundledPublicArtifactModule({
      dirName: path.basename(record.rootDir),
      artifactCandidates: WEB_FETCH_ARTIFACT_CANDIDATES,
    });
    if (!mod) {
      return null;
    }
    const loadedProviders = collectProviderFactories({
      mod,
      suffix: "WebFetchProvider",
      isProvider: isWebFetchProviderPlugin,
    });
    if (loadedProviders.length === 0) {
      return null;
    }
    providers.push(...loadedProviders.map((provider) => ({ ...provider, pluginId })));
  }
  return providers;
}
