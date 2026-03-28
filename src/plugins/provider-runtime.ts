import type { AuthProfileCredential, OAuthCredential } from "../agents/auth-profiles/types.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveCatalogHookProviderPluginIds,
  resolveOwningPluginIdsForProvider,
} from "./providers.js";
import { resolvePluginProviders } from "./providers.runtime.js";
import { resolvePluginCacheInputs } from "./roots.js";
import type {
  ProviderAuthDoctorHintContext,
  ProviderAugmentModelCatalogContext,
  ProviderBuildMissingAuthMessageContext,
  ProviderBuildUnknownModelHintContext,
  ProviderBuiltInModelSuppressionContext,
  ProviderCacheTtlEligibilityContext,
  ProviderCreateEmbeddingProviderContext,
  ProviderResolveSyntheticAuthContext,
  ProviderCreateStreamFnContext,
  ProviderDefaultThinkingPolicyContext,
  ProviderFetchUsageSnapshotContext,
  ProviderModernModelPolicyContext,
  ProviderPrepareExtraParamsContext,
  ProviderPrepareDynamicModelContext,
  ProviderPrepareRuntimeAuthContext,
  ProviderResolveUsageAuthContext,
  ProviderPlugin,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
  ProviderThinkingPolicyContext,
  ProviderWrapStreamFnContext,
} from "./types.js";

function matchesProviderId(provider: ProviderPlugin, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) {
    return false;
  }
  if (normalizeProviderId(provider.id) === normalized) {
    return true;
  }
  return (provider.aliases ?? []).some((alias) => normalizeProviderId(alias) === normalized);
}

let cachedHookProvidersWithoutConfig = new WeakMap<
  NodeJS.ProcessEnv,
  Map<string, ProviderPlugin[]>
>();
let cachedHookProvidersByConfig = new WeakMap<
  OpenClawConfig,
  WeakMap<NodeJS.ProcessEnv, Map<string, ProviderPlugin[]>>
>();

function resolveHookProviderCacheBucket(params: {
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}) {
  if (!params.config) {
    let bucket = cachedHookProvidersWithoutConfig.get(params.env);
    if (!bucket) {
      bucket = new Map<string, ProviderPlugin[]>();
      cachedHookProvidersWithoutConfig.set(params.env, bucket);
    }
    return bucket;
  }

  let envBuckets = cachedHookProvidersByConfig.get(params.config);
  if (!envBuckets) {
    envBuckets = new WeakMap<NodeJS.ProcessEnv, Map<string, ProviderPlugin[]>>();
    cachedHookProvidersByConfig.set(params.config, envBuckets);
  }
  let bucket = envBuckets.get(params.env);
  if (!bucket) {
    bucket = new Map<string, ProviderPlugin[]>();
    envBuckets.set(params.env, bucket);
  }
  return bucket;
}

function buildHookProviderCacheKey(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  onlyPluginIds?: string[];
  env?: NodeJS.ProcessEnv;
}) {
  const { roots } = resolvePluginCacheInputs({
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return `${roots.workspace ?? ""}::${roots.global}::${roots.stock ?? ""}::${JSON.stringify(params.config ?? null)}::${JSON.stringify(params.onlyPluginIds ?? [])}`;
}

export function clearProviderRuntimeHookCache(): void {
  cachedHookProvidersWithoutConfig = new WeakMap<
    NodeJS.ProcessEnv,
    Map<string, ProviderPlugin[]>
  >();
  cachedHookProvidersByConfig = new WeakMap<
    OpenClawConfig,
    WeakMap<NodeJS.ProcessEnv, Map<string, ProviderPlugin[]>>
  >();
}

export function resetProviderRuntimeHookCacheForTest(): void {
  clearProviderRuntimeHookCache();
}

function resolveProviderPluginsForHooks(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
}): ProviderPlugin[] {
  const env = params.env ?? process.env;
  const cacheBucket = resolveHookProviderCacheBucket({
    config: params.config,
    env,
  });
  const cacheKey = buildHookProviderCacheKey({
    config: params.config,
    workspaceDir: params.workspaceDir,
    onlyPluginIds: params.onlyPluginIds,
    env,
  });
  const cached = cacheBucket.get(cacheKey);
  if (cached) {
    return cached;
  }
  const resolved = resolvePluginProviders({
    ...params,
    env,
    activate: false,
    cache: false,
    bundledProviderAllowlistCompat: true,
    bundledProviderVitestCompat: true,
  });
  cacheBucket.set(cacheKey, resolved);
  return resolved;
}

function resolveProviderPluginsForCatalogHooks(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderPlugin[] {
  const onlyPluginIds = resolveCatalogHookProviderPluginIds({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  if (onlyPluginIds.length === 0) {
    return [];
  }
  return resolveProviderPluginsForHooks({
    ...params,
    onlyPluginIds,
  });
}

export function resolveProviderRuntimePlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderPlugin | undefined {
  const owningPluginIds = resolveOwningPluginIdsForProvider({
    provider: params.provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  if (!owningPluginIds || owningPluginIds.length === 0) {
    return undefined;
  }
  return resolveProviderPluginsForHooks({
    ...params,
    onlyPluginIds: owningPluginIds,
  }).find((plugin) => matchesProviderId(plugin, params.provider));
}

export function runProviderDynamicModel(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveDynamicModelContext;
}): ProviderRuntimeModel | undefined {
  return resolveProviderRuntimePlugin(params)?.resolveDynamicModel?.(params.context) ?? undefined;
}

export async function prepareProviderDynamicModel(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderPrepareDynamicModelContext;
}): Promise<void> {
  await resolveProviderRuntimePlugin(params)?.prepareDynamicModel?.(params.context);
}

export function normalizeProviderResolvedModelWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: {
    config?: OpenClawConfig;
    agentDir?: string;
    workspaceDir?: string;
    provider: string;
    modelId: string;
    model: ProviderRuntimeModel;
  };
}): ProviderRuntimeModel | undefined {
  return (
    resolveProviderRuntimePlugin(params)?.normalizeResolvedModel?.(params.context) ?? undefined
  );
}

export function resolveProviderCapabilitiesWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}) {
  return resolveProviderRuntimePlugin(params)?.capabilities;
}

export function prepareProviderExtraParams(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderPrepareExtraParamsContext;
}) {
  return resolveProviderRuntimePlugin(params)?.prepareExtraParams?.(params.context) ?? undefined;
}

export function resolveProviderStreamFn(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderCreateStreamFnContext;
}) {
  return resolveProviderRuntimePlugin(params)?.createStreamFn?.(params.context) ?? undefined;
}

export function wrapProviderStreamFn(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderWrapStreamFnContext;
}) {
  return resolveProviderRuntimePlugin(params)?.wrapStreamFn?.(params.context) ?? undefined;
}

export async function createProviderEmbeddingProvider(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderCreateEmbeddingProviderContext;
}) {
  return await resolveProviderRuntimePlugin(params)?.createEmbeddingProvider?.(params.context);
}

export async function prepareProviderRuntimeAuth(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderPrepareRuntimeAuthContext;
}) {
  return await resolveProviderRuntimePlugin(params)?.prepareRuntimeAuth?.(params.context);
}

export async function resolveProviderUsageAuthWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveUsageAuthContext;
}) {
  return await resolveProviderRuntimePlugin(params)?.resolveUsageAuth?.(params.context);
}

export async function resolveProviderUsageSnapshotWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderFetchUsageSnapshotContext;
}) {
  return await resolveProviderRuntimePlugin(params)?.fetchUsageSnapshot?.(params.context);
}

export function formatProviderAuthProfileApiKeyWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: AuthProfileCredential;
}) {
  return resolveProviderRuntimePlugin(params)?.formatApiKey?.(params.context);
}

export async function refreshProviderOAuthCredentialWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: OAuthCredential;
}) {
  return await resolveProviderRuntimePlugin(params)?.refreshOAuth?.(params.context);
}

export async function buildProviderAuthDoctorHintWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderAuthDoctorHintContext;
}) {
  return await resolveProviderRuntimePlugin(params)?.buildAuthDoctorHint?.(params.context);
}

export function resolveProviderCacheTtlEligibility(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderCacheTtlEligibilityContext;
}) {
  return resolveProviderRuntimePlugin(params)?.isCacheTtlEligible?.(params.context);
}

export function resolveProviderBinaryThinking(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderThinkingPolicyContext;
}) {
  return resolveProviderRuntimePlugin(params)?.isBinaryThinking?.(params.context);
}

export function resolveProviderXHighThinking(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderThinkingPolicyContext;
}) {
  return resolveProviderRuntimePlugin(params)?.supportsXHighThinking?.(params.context);
}

export function resolveProviderDefaultThinkingLevel(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderDefaultThinkingPolicyContext;
}) {
  return resolveProviderRuntimePlugin(params)?.resolveDefaultThinkingLevel?.(params.context);
}

export function resolveProviderModernModelRef(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderModernModelPolicyContext;
}) {
  return resolveProviderRuntimePlugin(params)?.isModernModelRef?.(params.context);
}

export function buildProviderMissingAuthMessageWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderBuildMissingAuthMessageContext;
}) {
  return (
    resolveProviderRuntimePlugin(params)?.buildMissingAuthMessage?.(params.context) ?? undefined
  );
}

export function buildProviderUnknownModelHintWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderBuildUnknownModelHintContext;
}) {
  return resolveProviderRuntimePlugin(params)?.buildUnknownModelHint?.(params.context) ?? undefined;
}

export function resolveProviderSyntheticAuthWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveSyntheticAuthContext;
}) {
  return resolveProviderRuntimePlugin(params)?.resolveSyntheticAuth?.(params.context) ?? undefined;
}

export function resolveProviderBuiltInModelSuppression(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderBuiltInModelSuppressionContext;
}) {
  for (const plugin of resolveProviderPluginsForCatalogHooks(params)) {
    const result = plugin.suppressBuiltInModel?.(params.context);
    if (result?.suppress) {
      return result;
    }
  }
  return undefined;
}

export async function augmentModelCatalogWithProviderPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderAugmentModelCatalogContext;
}) {
  const supplemental = [] as ProviderAugmentModelCatalogContext["entries"];
  for (const plugin of resolveProviderPluginsForCatalogHooks(params)) {
    const next = await plugin.augmentModelCatalog?.(params.context);
    if (!next || next.length === 0) {
      continue;
    }
    supplemental.push(...next);
  }
  return supplemental;
}
