import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildModelCatalogMergeKey,
  planManifestModelCatalogSuppressions,
  type ManifestModelCatalogSuppressionEntry,
} from "../model-catalog/index.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";

type ManifestSuppressionCache = Map<string, readonly ManifestModelCatalogSuppressionEntry[]>;

let cacheWithoutConfig = new WeakMap<NodeJS.ProcessEnv, ManifestSuppressionCache>();
let cacheByConfig = new WeakMap<
  OpenClawConfig,
  WeakMap<NodeJS.ProcessEnv, ManifestSuppressionCache>
>();

function resolveSuppressionCache(params: {
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ManifestSuppressionCache {
  if (!params.config) {
    let cache = cacheWithoutConfig.get(params.env);
    if (!cache) {
      cache = new Map();
      cacheWithoutConfig.set(params.env, cache);
    }
    return cache;
  }
  let envCaches = cacheByConfig.get(params.config);
  if (!envCaches) {
    envCaches = new WeakMap();
    cacheByConfig.set(params.config, envCaches);
  }
  let cache = envCaches.get(params.env);
  if (!cache) {
    cache = new Map();
    envCaches.set(params.env, cache);
  }
  return cache;
}

function cacheKey(params: { workspaceDir?: string }): string {
  return params.workspaceDir ?? "";
}

function listManifestModelCatalogSuppressions(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): readonly ManifestModelCatalogSuppressionEntry[] {
  const cache = resolveSuppressionCache({
    config: params.config,
    env: params.env,
  });
  const key = cacheKey(params);
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const registry = loadPluginManifestRegistryForPluginRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const planned = planManifestModelCatalogSuppressions({ registry });
  cache.set(key, planned.suppressions);
  return planned.suppressions;
}

function buildManifestSuppressionError(params: {
  provider: string;
  modelId: string;
  reason?: string;
}): string {
  const ref = `${params.provider}/${params.modelId}`;
  return params.reason ? `Unknown model: ${ref}. ${params.reason}` : `Unknown model: ${ref}.`;
}

export function clearManifestModelSuppressionCacheForTest(): void {
  cacheWithoutConfig = new WeakMap<NodeJS.ProcessEnv, ManifestSuppressionCache>();
  cacheByConfig = new WeakMap<
    OpenClawConfig,
    WeakMap<NodeJS.ProcessEnv, ManifestSuppressionCache>
  >();
}

export function resolveManifestBuiltInModelSuppression(params: {
  provider?: string | null;
  id?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const provider = normalizeLowercaseStringOrEmpty(params.provider);
  const modelId = normalizeLowercaseStringOrEmpty(params.id);
  if (!provider || !modelId) {
    return undefined;
  }
  const mergeKey = buildModelCatalogMergeKey(provider, modelId);
  const suppression = listManifestModelCatalogSuppressions({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env ?? process.env,
  }).find((entry) => entry.mergeKey === mergeKey);
  if (!suppression) {
    return undefined;
  }
  return {
    suppress: true,
    errorMessage: buildManifestSuppressionError({
      provider,
      modelId,
      reason: suppression.reason,
    }),
  };
}
