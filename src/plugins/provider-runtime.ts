// Composes provider plugin runtime hooks with shared provider policy.
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  sortUniqueStrings,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import type { AuthProfileCredential, OAuthCredential } from "../agents/auth-profiles/types.js";
import { resolveGpt5SystemPromptContribution } from "../agents/gpt5-prompt-overlay.js";
import { getRegisteredAgentHarness } from "../agents/harness/registry.js";
import {
  applyPluginTextReplacements,
  mergePluginTextTransforms,
} from "../agents/plugin-text-transforms.js";
import { unwrapSecretSentinelsForProviderEgress } from "../agents/provider-secret-egress.js";
import type { ProviderSystemPromptContribution } from "../agents/system-prompt-contribution.js";
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { UsageProviderId } from "../infra/provider-usage.types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeProviderModelIdWithManifest } from "./manifest-model-id-normalization.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { resolvePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import type { PluginMetadataRegistryView } from "./plugin-metadata-snapshot.types.js";
import { resolvePluginDiscoveryProvidersRuntime } from "./provider-discovery.runtime.js";
import {
  clearProviderRuntimePluginCacheForTest,
  prepareProviderExtraParams,
  resolveProviderAuthProfileId,
  resolveProviderExtraParamsForTransport,
  resolveProviderFollowupFallbackRoute,
  ensureProviderRuntimePluginHandle,
  resolveLoadedProviderRuntimePlugin,
  resolveProviderHookPlugin,
  resolveProviderPluginsForHooks,
  resolveProviderRuntimePlugin,
  wrapProviderSimpleCompletionStreamFn,
  type ProviderRuntimePluginHandle,
  wrapProviderStreamFn,
} from "./provider-hook-runtime.js";
import { resolveBundledProviderPolicySurface } from "./provider-public-artifacts.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import type { ProviderThinkingProfile } from "./provider-thinking.types.js";
import {
  resolveCatalogHookProviderPluginIds,
  resolveExternalAuthProfileCompatFallbackPluginIds,
  resolveExternalAuthProfileProviderPluginIds,
  resolveOwningPluginIdsForProvider,
  resolveOwningPluginIdsForProviderRef,
  resolveUsageHookProviderPluginContracts,
} from "./providers.js";
import {
  getActivePluginRegistryWorkspaceDirFromState,
  getPluginRegistryState,
} from "./runtime-state.js";
import { resolveRuntimeTextTransforms } from "./text-transforms.runtime.js";
import type {
  ProviderAuthDoctorHintContext,
  ProviderAugmentModelCatalogContext,
  ProviderExternalAuthProfile,
  ProviderBuildMissingAuthMessageContext,
  ProviderBuildUnknownModelHintContext,
  ProviderCacheTtlEligibilityContext,
  ProviderCreateEmbeddingProviderContext,
  ProviderDeferSyntheticProfileAuthContext,
  ProviderResolveSyntheticAuthContext,
  ProviderCreateStreamFnContext,
  ProviderDefaultThinkingPolicyContext,
  ProviderFetchUsageSnapshotContext,
  ProviderFailoverErrorContext,
  ProviderNormalizeToolSchemasContext,
  ProviderNormalizeConfigContext,
  ProviderNormalizeModelIdContext,
  ProviderReasoningOutputMode,
  ProviderReasoningOutputModeContext,
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
  ProviderNormalizeResolvedModelContext,
  ProviderNormalizeTransportContext,
  ProviderModernModelPolicyContext,
  ProviderPrepareDynamicModelContext,
  ProviderPreferRuntimeResolvedModelContext,
  ProviderPlugin,
  ProviderResolveExternalAuthProfilesContext,
  ProviderPrepareRuntimeAuthContext,
  ProviderApplyConfigDefaultsContext,
  ProviderResolveConfigApiKeyContext,
  ProviderSanitizeReplayHistoryContext,
  ProviderResolveUsageAuthContext,
  ProviderResolveDynamicModelContext,
  ProviderResolveTransportTurnStateContext,
  ProviderSystemPromptContributionContext,
  ProviderTransformSystemPromptContext,
  ProviderThinkingPolicyContext,
  ProviderTransportTurnState,
  ProviderValidateReplayTurnsContext,
  PluginTextTransforms,
} from "./types.js";

const log = createSubsystemLogger("plugins/provider-runtime");
const PROVIDER_MODEL_CATALOG_AUGMENT_TIMEOUT_MS = 15_000;
const warnedExternalAuthFallbackPluginIds = new Set<string>();
type ProviderModelCatalogAugmentHook = NonNullable<ProviderPlugin["augmentModelCatalog"]>;
type ProviderModelCatalogAugmentOutcome =
  | {
      status: "fulfilled";
      value: Awaited<ReturnType<ProviderModelCatalogAugmentHook>>;
    }
  | { status: "rejected"; error: unknown }
  | { status: "aborted" }
  | { status: "timed-out" };
type ProviderModelCatalogAugmentInvocation = {
  controller: AbortController;
  outcome: Promise<ProviderModelCatalogAugmentOutcome>;
  settlement: Promise<ProviderModelCatalogAugmentOutcome>;
  timeoutWarningLogged: boolean;
};
type ProviderModelCatalogAugmentInFlight = {
  hook: ProviderModelCatalogAugmentHook;
  invocation: ProviderModelCatalogAugmentInvocation;
};
type ProviderModelCatalogAugmentParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderAugmentModelCatalogContext;
};
type ProviderModelCatalogAugmentScope = {
  config: OpenClawConfig | undefined;
  env: NodeJS.ProcessEnv;
  registryKey: string | null;
  registryVersion: number;
  workspaceDir: string;
  inFlight: Map<string, ProviderModelCatalogAugmentInFlight>;
};
// Retain hung calls only within one runtime/config/workspace scope so retries do
// not overlap, while reloads can retire stale work and invoke replacements.
let providerModelCatalogAugmentScope: ProviderModelCatalogAugmentScope | undefined;

function matchesProviderPluginRef(provider: ProviderPlugin, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) {
    return false;
  }
  if (normalizeProviderId(provider.id) === normalized) {
    return true;
  }
  return [...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].some(
    (alias) => normalizeProviderId(alias) === normalized,
  );
}

function resolveProviderHookRefs(
  provider: string,
  providerConfig?: ModelProviderConfig,
  modelApi?: string,
): string[] {
  const refs = [provider];
  const apiRef = normalizeOptionalString(modelApi ?? providerConfig?.api);
  if (apiRef && normalizeProviderId(apiRef) !== normalizeProviderId(provider)) {
    refs.push(apiRef);
  }
  return uniqueStrings(refs);
}

function matchesAnyProviderPluginRef(provider: ProviderPlugin, providerRefs: readonly string[]) {
  return providerRefs.some((providerRef) => matchesProviderPluginRef(provider, providerRef));
}

function hasExplicitProviderRuntimePluginActivation(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (!params.config) {
    return true;
  }
  const ownerPluginIds =
    resolveOwningPluginIdsForProvider({
      provider: params.provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    }) ?? [];
  if (ownerPluginIds.length === 0) {
    return false;
  }
  const allow = new Set(params.config.plugins?.allow ?? []);
  const entries = params.config.plugins?.entries ?? {};
  return ownerPluginIds.some((pluginId) => allow.has(pluginId) || entries[pluginId] !== undefined);
}

function hasConfiguredModelProvider(params: {
  provider: string;
  config?: OpenClawConfig;
}): boolean {
  return (
    findNormalizedProviderValue(params.config?.models?.providers, params.provider) !== undefined
  );
}

export {
  prepareProviderExtraParams,
  resolveProviderAuthProfileId,
  resolveProviderExtraParamsForTransport,
  resolveProviderFollowupFallbackRoute,
  resolveProviderRuntimePlugin,
  wrapProviderSimpleCompletionStreamFn,
  wrapProviderStreamFn,
};

function resetExternalAuthFallbackWarningCacheForTest(): void {
  warnedExternalAuthFallbackPluginIds.clear();
}

function retireProviderModelCatalogAugmentScope(): void {
  if (!providerModelCatalogAugmentScope) {
    return;
  }
  for (const item of providerModelCatalogAugmentScope.inFlight.values()) {
    item.invocation.controller.abort();
  }
  providerModelCatalogAugmentScope.inFlight.clear();
  providerModelCatalogAugmentScope = undefined;
}

function resetProviderModelCatalogAugmentInFlightForTest(): void {
  retireProviderModelCatalogAugmentScope();
}

export const testing = {
  clearProviderRuntimePluginCacheForTest,
  resetExternalAuthFallbackWarningCacheForTest,
  resetProviderModelCatalogAugmentInFlightForTest,
} as const;

function resolveProviderPluginsForCatalogHooks(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderPlugin[] {
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  const env = params.env ?? process.env;
  const onlyPluginIds = resolveCatalogHookProviderPluginIds({
    config: params.config,
    workspaceDir,
    env,
  });
  if (onlyPluginIds.length === 0) {
    return [];
  }
  return resolveProviderPluginsForHooks({
    ...params,
    workspaceDir,
    env,
    onlyPluginIds,
  });
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

export function resolveProviderSystemPromptContribution(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: ProviderSystemPromptContributionContext;
}): ProviderSystemPromptContribution | undefined {
  const plugin = ensureProviderRuntimePluginHandle(params).plugin;
  const baseOverlay = resolveGpt5SystemPromptContribution({
    config: params.context.config ?? params.config,
    providerId: params.context.provider ?? params.provider,
    modelId: params.context.modelId,
    trigger: params.context.trigger,
  });
  const providerOverlay =
    plugin?.resolvePromptOverlay?.({
      ...params.context,
      baseOverlay,
    }) ?? undefined;
  return mergeProviderSystemPromptContributions(
    mergeProviderSystemPromptContributions(baseOverlay, providerOverlay),
    plugin?.resolveSystemPromptContribution?.(params.context) ?? undefined,
  );
}

function mergeProviderSystemPromptContributions(
  base?: ProviderSystemPromptContribution,
  override?: ProviderSystemPromptContribution,
): ProviderSystemPromptContribution | undefined {
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }
  const stablePrefix = mergeUniquePromptSections(base.stablePrefix, override.stablePrefix);
  const dynamicSuffix = mergeUniquePromptSections(base.dynamicSuffix, override.dynamicSuffix);
  return {
    ...(stablePrefix ? { stablePrefix } : {}),
    ...(dynamicSuffix ? { dynamicSuffix } : {}),
    sectionOverrides: {
      ...base.sectionOverrides,
      ...override.sectionOverrides,
    },
  };
}

function mergeUniquePromptSections(...sections: Array<string | undefined>): string | undefined {
  const uniqueSections = uniqueStrings(
    sections.filter((section): section is string => Boolean(section?.trim())),
  );
  return uniqueSections.length > 0 ? uniqueSections.join("\n\n") : undefined;
}

export function transformProviderSystemPrompt(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: ProviderTransformSystemPromptContext;
}): string {
  const plugin = ensureProviderRuntimePluginHandle(params).plugin;
  const textTransforms = mergePluginTextTransforms(
    resolveRuntimeTextTransforms(),
    plugin?.textTransforms,
  );
  const transformed =
    plugin?.transformSystemPrompt?.(params.context) ?? params.context.systemPrompt;
  return applyPluginTextReplacements(transformed, textTransforms?.input);
}

export function resolveProviderTextTransforms(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
}): PluginTextTransforms | undefined {
  return mergePluginTextTransforms(
    resolveRuntimeTextTransforms(),
    ensureProviderRuntimePluginHandle(params).plugin?.textTransforms,
  );
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

export function shouldPreferProviderRuntimeResolvedModel(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderPreferRuntimeResolvedModelContext;
}): boolean {
  return (
    resolveProviderRuntimePlugin(params)?.preferRuntimeResolvedModel?.(params.context) ?? false
  );
}

export function normalizeProviderResolvedModelWithPlugin(params: {
  provider: string;
  modelId?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginMetadataSnapshot?: PluginMetadataRegistryView;
  context: {
    config?: OpenClawConfig;
    agentDir?: string;
    workspaceDir?: string;
    provider: string;
    modelId: string;
    model: ProviderRuntimeModel;
  };
}): ProviderRuntimeModel | undefined {
  const context = {
    ...params.context,
    ...(params.context.config === undefined && params.config !== undefined
      ? { config: params.config }
      : {}),
    ...(params.context.workspaceDir === undefined && params.workspaceDir !== undefined
      ? { workspaceDir: params.workspaceDir }
      : {}),
  };
  return (
    resolveProviderRuntimePlugin({
      ...params,
      modelId: params.context.modelId,
    })?.normalizeResolvedModel?.(context) ?? undefined
  );
}

export function applyProviderResolvedTransportWithPlugin(params: {
  provider: string;
  modelId?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderNormalizeResolvedModelContext;
}): ProviderRuntimeModel | undefined {
  const config = params.context.config ?? params.config;
  const workspaceDir = params.context.workspaceDir ?? params.workspaceDir;
  const normalized = normalizeProviderTransportWithPlugin({
    provider: params.provider,
    config,
    workspaceDir,
    env: params.env,
    modelId: params.context.modelId,
    context: {
      ...(config !== undefined ? { config } : {}),
      ...(workspaceDir !== undefined ? { workspaceDir } : {}),
      provider: params.context.provider,
      modelId: params.context.modelId,
      api: params.context.model.api,
      baseUrl: params.context.model.baseUrl,
    },
  });
  if (!normalized) {
    return undefined;
  }

  const nextApi = normalized.api ?? params.context.model.api;
  const nextBaseUrl = normalized.baseUrl ?? params.context.model.baseUrl;
  if (nextApi === params.context.model.api && nextBaseUrl === params.context.model.baseUrl) {
    return undefined;
  }

  return {
    ...params.context.model,
    api: nextApi as ProviderRuntimeModel["api"],
    baseUrl: nextBaseUrl,
  };
}

export function normalizeProviderModelIdWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  plugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
  context: ProviderNormalizeModelIdContext;
}): string | undefined {
  const plugin = resolveProviderHookPlugin(params);
  return (
    normalizeOptionalString(plugin?.normalizeModelId?.(params.context)) ??
    normalizeProviderModelIdWithManifest(params)
  );
}

export function normalizeProviderTransportWithPlugin(params: {
  provider: string;
  modelId?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderNormalizeTransportContext;
}): { api?: string | null; baseUrl?: string } | undefined {
  const hasTransportChange = (normalized: { api?: string | null; baseUrl?: string }) =>
    (normalized.api ?? params.context.api) !== params.context.api ||
    (normalized.baseUrl ?? params.context.baseUrl) !== params.context.baseUrl;
  const context = {
    ...params.context,
    ...(params.context.config === undefined && params.config !== undefined
      ? { config: params.config }
      : {}),
    ...(params.context.workspaceDir === undefined && params.workspaceDir !== undefined
      ? { workspaceDir: params.workspaceDir }
      : {}),
  };
  const matchedPlugin = resolveProviderHookPlugin(params);
  const normalizedMatched = matchedPlugin?.normalizeTransport?.(context);
  if (normalizedMatched && hasTransportChange(normalizedMatched)) {
    return normalizedMatched;
  }
  if (hasConfiguredModelProvider(params)) {
    return undefined;
  }

  for (const candidate of resolveProviderPluginsForHooks(params)) {
    if (!candidate.normalizeTransport || candidate === matchedPlugin) {
      continue;
    }
    const normalized = candidate.normalizeTransport(context);
    if (normalized && hasTransportChange(normalized)) {
      return normalized;
    }
  }

  return undefined;
}

export function normalizeProviderConfigWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderNormalizeConfigContext;
  allowRuntimePluginLoad?: boolean;
}): ModelProviderConfig | undefined {
  const hasConfigChange = (normalized: ModelProviderConfig) =>
    normalized !== params.context.providerConfig;
  const bundledSurface = resolveBundledProviderPolicySurface(params.provider);
  if (bundledSurface?.normalizeConfig) {
    const normalized = bundledSurface.normalizeConfig(params.context);
    return normalized && hasConfigChange(normalized) ? normalized : undefined;
  }
  if (!hasExplicitProviderRuntimePluginActivation(params)) {
    return undefined;
  }
  if (params.allowRuntimePluginLoad === false) {
    return undefined;
  }
  const matchedPlugin = resolveProviderRuntimePlugin(params);
  const normalizedMatched = matchedPlugin?.normalizeConfig?.(params.context);
  return normalizedMatched && hasConfigChange(normalizedMatched) ? normalizedMatched : undefined;
}

export function applyProviderNativeStreamingUsageCompatWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderNormalizeConfigContext;
  allowRuntimePluginLoad?: boolean;
}): ModelProviderConfig | undefined {
  if (params.allowRuntimePluginLoad === false) {
    return undefined;
  }
  return (
    resolveProviderRuntimePlugin(params)?.applyNativeStreamingUsageCompat?.(params.context) ??
    undefined
  );
}

export function resolveProviderConfigApiKeyWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveConfigApiKeyContext;
  allowRuntimePluginLoad?: boolean;
}): string | undefined {
  const bundledSurface = resolveBundledProviderPolicySurface(params.provider);
  if (bundledSurface?.resolveConfigApiKey) {
    return normalizeOptionalString(bundledSurface.resolveConfigApiKey(params.context));
  }
  if (params.allowRuntimePluginLoad === false) {
    return undefined;
  }
  return normalizeOptionalString(
    resolveProviderRuntimePlugin(params)?.resolveConfigApiKey?.(params.context),
  );
}

export function resolveProviderReplayPolicyWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderReplayPolicyContext;
}): ProviderReplayPolicy | undefined {
  return resolveProviderRuntimePlugin(params)?.buildReplayPolicy?.(params.context) ?? undefined;
}

export async function sanitizeProviderReplayHistoryWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderSanitizeReplayHistoryContext;
}) {
  return await resolveProviderRuntimePlugin(params)?.sanitizeReplayHistory?.(params.context);
}

export async function validateProviderReplayTurnsWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderValidateReplayTurnsContext;
}) {
  return await resolveProviderRuntimePlugin(params)?.validateReplayTurns?.(params.context);
}

export function normalizeProviderToolSchemasWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  allowRuntimePluginLoad?: boolean;
  context: ProviderNormalizeToolSchemasContext;
}) {
  const plugin =
    params.allowRuntimePluginLoad === false
      ? (params.runtimeHandle?.plugin ?? resolveLoadedProviderRuntimePlugin(params))
      : ensureProviderRuntimePluginHandle(params).plugin;
  return plugin?.normalizeToolSchemas?.(params.context) ?? undefined;
}

export function inspectProviderToolSchemasWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  allowRuntimePluginLoad?: boolean;
  context: ProviderNormalizeToolSchemasContext;
}) {
  const plugin =
    params.allowRuntimePluginLoad === false
      ? (params.runtimeHandle?.plugin ?? resolveLoadedProviderRuntimePlugin(params))
      : ensureProviderRuntimePluginHandle(params).plugin;
  return plugin?.inspectToolSchemas?.(params.context) ?? undefined;
}

export function resolveProviderReasoningOutputModeWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: ProviderReasoningOutputModeContext;
}): ProviderReasoningOutputMode | undefined {
  const mode = ensureProviderRuntimePluginHandle({
    provider: params.provider,
    modelId: params.context.modelId,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    runtimeHandle: params.runtimeHandle,
  }).plugin?.resolveReasoningOutputMode?.(params.context);
  return mode === "native" || mode === "tagged" ? mode : undefined;
}

export function resolveProviderStreamFn(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  allowRuntimePluginLoad?: boolean;
  context: ProviderCreateStreamFnContext;
}) {
  const plugin =
    params.allowRuntimePluginLoad === false
      ? resolveLoadedProviderRuntimePlugin(params)
      : resolveProviderRuntimePlugin(params);
  return plugin?.createStreamFn?.(params.context) ?? undefined;
}

export function resolveProviderTransportTurnStateWithPlugin(params: {
  provider: string;
  modelId?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  allowRuntimePluginLoad?: boolean;
  context: ProviderResolveTransportTurnStateContext;
}): ProviderTransportTurnState | undefined {
  const plugin =
    params.allowRuntimePluginLoad === false
      ? resolveLoadedProviderRuntimePlugin(params)
      : resolveProviderRuntimePlugin(params);
  return plugin?.resolveTransportTurnState?.(params.context) ?? undefined;
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
  const prepareRuntimeAuth = resolveProviderRuntimePlugin(params)?.prepareRuntimeAuth;
  if (!prepareRuntimeAuth) {
    return undefined;
  }
  // Secret material crosses into provider code only when that provider owns an
  // auth hook. Callers can safely pass sentinels without probing plugin state.
  const preparedInput = unwrapSecretSentinelsForProviderEgress(
    params.context.apiKey,
    "provider runtime auth exchange",
  );
  return await prepareRuntimeAuth({
    ...params.context,
    apiKey: preparedInput,
  });
}

export async function resolveProviderUsageAuthWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveUsageAuthContext;
}) {
  const plugin = resolveProviderRuntimePlugin(params);
  if (!plugin?.resolveUsageAuth) {
    return undefined;
  }
  const result = await plugin.resolveUsageAuth(params.context);
  if (!result) {
    return undefined;
  }
  return result;
}

export async function resolveProviderUsageSnapshotWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderFetchUsageSnapshotContext;
}) {
  const providerHook = resolveProviderRuntimePlugin(params)?.fetchUsageSnapshot;
  if (providerHook) {
    const snapshot = await providerHook(params.context);
    if (snapshot != null) {
      return snapshot;
    }
  }

  // A distinct hook owner is an explicit synthetic contribution route. Avoid
  // probing harness manifests for ordinary provider usage misses.
  if (params.provider === params.context.provider) {
    return undefined;
  }

  let harness = getRegisteredAgentHarness(params.provider)?.harness;
  if (!harness) {
    const workspaceDir =
      params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState() ?? process.cwd();
    const { ensureSelectedAgentHarnessPlugin } =
      await import("../agents/harness/runtime-plugin.js");
    await ensureSelectedAgentHarnessPlugin({
      provider: params.context.provider,
      modelId: "",
      config: params.config,
      agentHarnessId: params.provider,
      workspaceDir,
    });
    harness = getRegisteredAgentHarness(params.provider)?.harness;
  }
  return await harness?.fetchUsageSnapshot?.(params.context);
}

export type ProviderUsagePluginDescriptor = {
  provider: UsageProviderId;
  displayName: string;
};

/** Lists provider plugins that own the complete usage auth + fetch lifecycle. */
export function listProviderUsagePluginDescriptors(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderUsagePluginDescriptor[] {
  const pluginContracts = resolveUsageHookProviderPluginContracts(params);
  if (pluginContracts.length === 0) {
    return [];
  }
  const descriptors = new Map<string, ProviderUsagePluginDescriptor>();
  for (const contract of pluginContracts) {
    const declaredProviderIds = new Set(contract.providerIds);
    for (const plugin of resolveProviderPluginsForHooks({
      ...params,
      onlyPluginIds: [contract.pluginId],
    })) {
      if (!plugin.resolveUsageAuth || !plugin.fetchUsageSnapshot) {
        continue;
      }
      const provider = normalizeProviderId(plugin.id);
      if (!provider || !declaredProviderIds.has(provider) || descriptors.has(provider)) {
        continue;
      }
      descriptors.set(provider, {
        provider,
        displayName: normalizeOptionalString(plugin.label) ?? provider,
      });
    }
  }
  return [...descriptors.values()].toSorted((a, b) => a.provider.localeCompare(b.provider));
}

export function matchesProviderContextOverflowWithPlugin(params: {
  provider?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderFailoverErrorContext;
}): boolean {
  const plugins = resolveProviderPluginsForScopedHook(params);
  for (const plugin of plugins) {
    if (plugin.matchesContextOverflowError?.(params.context)) {
      return true;
    }
  }
  return false;
}

export function classifyProviderFailoverReasonWithPlugin(params: {
  provider?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderFailoverErrorContext;
}) {
  const plugins = resolveProviderPluginsForScopedHook(params);
  for (const plugin of plugins) {
    const reason = plugin.classifyFailoverReason?.(params.context);
    if (reason) {
      return reason;
    }
  }
  return undefined;
}

function resolveProviderPluginsForScopedHook(params: {
  provider?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderFailoverErrorContext;
}): ProviderPlugin[] {
  if (!params.provider) {
    return resolveProviderPluginsForHooks(params);
  }
  const plugin = resolveProviderHookPlugin({ ...params, provider: params.provider });
  if (plugin) {
    return [plugin];
  }
  if (hasStructuredFailoverDescriptor(params.context)) {
    return [];
  }
  // Custom provider ids may only name their canonical API in config, and the
  // legacy message classifier only has the runtime id here. Preserve its old
  // broad hook scan for descriptor-free messages, but do not let unrelated
  // hooks override structured HTTP/auth signals.
  return resolveProviderPluginsForHooks(params);
}

function hasStructuredFailoverDescriptor(context: ProviderFailoverErrorContext): boolean {
  return (
    context.status !== undefined || context.code !== undefined || context.errorType !== undefined
  );
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

export function resolveProviderThinkingProfile(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderDefaultThinkingPolicyContext;
}): ProviderThinkingProfile | null | undefined {
  const bundledSurface = resolveBundledProviderPolicySurface(params.provider);
  if (bundledSurface?.resolveThinkingProfile) {
    return bundledSurface.resolveThinkingProfile(params.context) ?? undefined;
  }
  return resolveProviderRuntimePlugin(params)?.resolveThinkingProfile?.(params.context);
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

export function applyProviderConfigDefaultsWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderApplyConfigDefaultsContext;
}) {
  const bundledSurface = resolveBundledProviderPolicySurface(params.provider);
  if (bundledSurface?.applyConfigDefaults) {
    return bundledSurface.applyConfigDefaults(params.context) ?? undefined;
  }
  return resolveProviderRuntimePlugin(params)?.applyConfigDefaults?.(params.context) ?? undefined;
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
  modelApi?: string;
}) {
  const providerRefs = resolveProviderHookRefs(
    params.provider,
    params.context.providerConfig,
    params.modelApi,
  );
  const discoveryPluginIds = [
    ...new Set(
      providerRefs.flatMap(
        (provider) =>
          resolveOwningPluginIdsForProviderRef({
            provider,
            config: params.config,
            workspaceDir: params.workspaceDir,
            env: params.env,
          }) ?? [],
      ),
    ),
  ];
  const discoveryProvider = (
    discoveryPluginIds.length > 0
      ? resolvePluginDiscoveryProvidersRuntime({
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: params.env,
          onlyPluginIds: discoveryPluginIds,
          discoveryEntriesOnly: true,
        })
      : []
  ).find((provider) => matchesAnyProviderPluginRef(provider, providerRefs));
  if (typeof discoveryProvider?.resolveSyntheticAuth === "function") {
    return discoveryProvider.resolveSyntheticAuth(params.context) ?? undefined;
  }
  const runtimeResolved = resolveProviderRuntimePlugin({
    ...params,
    applyAutoEnable: false,
    bundledProviderVitestCompat: false,
  })?.resolveSyntheticAuth?.(params.context);
  if (runtimeResolved) {
    return runtimeResolved;
  }
  for (const providerRef of providerRefs) {
    if (normalizeProviderId(providerRef) === normalizeProviderId(params.provider)) {
      continue;
    }
    const runtimeProviderResolved = resolveProviderRuntimePlugin({
      ...params,
      provider: providerRef,
      applyAutoEnable: false,
      bundledProviderVitestCompat: false,
    })?.resolveSyntheticAuth?.(params.context);
    if (runtimeProviderResolved) {
      return runtimeProviderResolved;
    }
  }
  if (providerRefs.length === 1) {
    return resolvePluginDiscoveryProvidersRuntime({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    })
      .find((provider) => matchesAnyProviderPluginRef(provider, providerRefs))
      ?.resolveSyntheticAuth?.(params.context);
  }
  return undefined;
}

export function resolveExternalAuthProfilesWithPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveExternalAuthProfilesContext;
}): ProviderExternalAuthProfile[] {
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  const env = params.env ?? process.env;
  const { manifestRegistry } = resolvePluginMetadataSnapshot({
    config: params.config ?? {},
    workspaceDir,
    env,
  });
  const externalAuthPluginIds = resolveExternalAuthProfileProviderPluginIds({
    config: params.config,
    workspaceDir,
    env,
    manifestRegistry,
  });
  const declaredPluginIds = new Set(externalAuthPluginIds);
  const fallbackPluginIds = resolveExternalAuthProfileCompatFallbackPluginIds({
    config: params.config,
    workspaceDir,
    env,
    declaredPluginIds,
    manifestRegistry,
  });
  const pluginIds = sortUniqueStrings([...externalAuthPluginIds, ...fallbackPluginIds]);
  if (pluginIds.length === 0) {
    return [];
  }
  const matches: ProviderExternalAuthProfile[] = [];
  for (const plugin of resolveProviderPluginsForHooks({
    ...params,
    workspaceDir,
    env,
    onlyPluginIds: pluginIds,
  })) {
    const profiles =
      plugin.resolveExternalAuthProfiles?.(params.context) ??
      plugin.resolveExternalOAuthProfiles?.(params.context);
    if (!profiles || profiles.length === 0) {
      continue;
    }
    const pluginId = plugin.pluginId ?? plugin.id;
    if (!declaredPluginIds.has(pluginId) && !warnedExternalAuthFallbackPluginIds.has(pluginId)) {
      warnedExternalAuthFallbackPluginIds.add(pluginId);
      log.warn(
        `Provider plugin "${sanitizeForLog(pluginId)}" uses external auth hooks without declaring contracts.externalAuthProviders. This compatibility fallback is deprecated and will be removed in a future release.`,
      );
    }
    matches.push(...profiles);
  }
  return matches;
}

export function shouldDeferProviderSyntheticProfileAuthWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderDeferSyntheticProfileAuthContext;
  modelApi?: string;
}) {
  const providerRefs = resolveProviderHookRefs(
    params.provider,
    params.context.providerConfig,
    params.modelApi,
  );
  for (const providerRef of providerRefs) {
    const resolved = resolveProviderRuntimePlugin({
      ...params,
      provider: providerRef,
    })?.shouldDeferSyntheticProfileAuth?.(params.context);
    if (resolved !== undefined) {
      return resolved;
    }
  }
  return undefined;
}

function resolveProviderModelCatalogAugmentKey(plugin: ProviderPlugin): string {
  return `${plugin.pluginId ?? plugin.id}\0${plugin.id}`;
}

function resolveProviderModelCatalogAugmentInFlight(
  params: ProviderModelCatalogAugmentParams,
): Map<string, ProviderModelCatalogAugmentInFlight> {
  const registryState = getPluginRegistryState();
  const config = params.config ?? params.context.config;
  const env = params.env ?? params.context.env;
  const workspaceDir =
    params.workspaceDir ??
    params.context.workspaceDir ??
    getActivePluginRegistryWorkspaceDirFromState() ??
    "";
  const registryKey = registryState?.key ?? null;
  const registryVersion = registryState?.activeVersion ?? 0;
  const current = providerModelCatalogAugmentScope;
  if (
    current &&
    current.config === config &&
    current.env === env &&
    current.registryKey === registryKey &&
    current.registryVersion === registryVersion &&
    current.workspaceDir === workspaceDir
  ) {
    return current.inFlight;
  }

  retireProviderModelCatalogAugmentScope();
  const inFlight = new Map<string, ProviderModelCatalogAugmentInFlight>();
  providerModelCatalogAugmentScope = {
    config,
    env,
    registryKey,
    registryVersion,
    workspaceDir,
    inFlight,
  };
  return inFlight;
}

function resolveProviderModelCatalogAugmentInvocation(params: {
  inFlight: Map<string, ProviderModelCatalogAugmentInFlight>;
  plugin: ProviderPlugin;
  hook: ProviderModelCatalogAugmentHook;
  context: ProviderAugmentModelCatalogContext;
}): ProviderModelCatalogAugmentInvocation {
  const key = resolveProviderModelCatalogAugmentKey(params.plugin);
  const existing = params.inFlight.get(key);
  if (existing?.hook === params.hook) {
    return existing.invocation;
  }
  if (existing) {
    existing.invocation.controller.abort();
    params.inFlight.delete(key);
  }

  const controller = new AbortController();
  const signal = params.context.signal
    ? AbortSignal.any([params.context.signal, controller.signal])
    : controller.signal;
  const settlement = Promise.resolve()
    .then(() =>
      params.hook({
        ...params.context,
        signal,
        timeoutMs: PROVIDER_MODEL_CATALOG_AUGMENT_TIMEOUT_MS,
      }),
    )
    .then(
      (value): ProviderModelCatalogAugmentOutcome => ({ status: "fulfilled", value }),
      (error: unknown): ProviderModelCatalogAugmentOutcome => ({ status: "rejected", error }),
    );
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let handleAbort: (() => void) | undefined;
  const interrupted = new Promise<ProviderModelCatalogAugmentOutcome>((resolve) => {
    handleAbort = () => resolve({ status: timedOut ? "timed-out" : "aborted" });
    controller.signal.addEventListener("abort", handleAbort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, PROVIDER_MODEL_CATALOG_AUGMENT_TIMEOUT_MS);
  });
  const invocation = {
    controller,
    outcome: Promise.race([settlement, interrupted]).finally(() => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (handleAbort) {
        controller.signal.removeEventListener("abort", handleAbort);
        handleAbort = undefined;
      }
    }),
    settlement,
    timeoutWarningLogged: false,
  } satisfies ProviderModelCatalogAugmentInvocation;
  params.inFlight.set(key, { hook: params.hook, invocation });
  void invocation.settlement.then(() => {
    if (params.inFlight.get(key)?.invocation === invocation) {
      params.inFlight.delete(key);
    }
  });
  return invocation;
}

export async function augmentModelCatalogWithProviderPluginsResult(
  params: ProviderModelCatalogAugmentParams,
) {
  const supplemental = [] as ProviderAugmentModelCatalogContext["entries"];
  let authoritative = true;
  const plugins = resolveProviderPluginsForCatalogHooks(params);
  const inFlight = resolveProviderModelCatalogAugmentInFlight(params);
  const pending = plugins.flatMap((plugin) => {
    const hook = plugin.augmentModelCatalog;
    if (!hook) {
      return [];
    }
    const invocation = resolveProviderModelCatalogAugmentInvocation({
      inFlight,
      plugin,
      hook,
      context: params.context,
    });
    return [{ plugin, invocation, result: invocation.outcome }];
  });
  const outcomes = await Promise.all(pending.map(({ result }) => result));
  for (const [index, outcome] of outcomes.entries()) {
    const pendingItem = pending[index];
    if (!pendingItem) {
      continue;
    }
    const { invocation, plugin } = pendingItem;
    if (outcome.status === "rejected") {
      throw outcome.error;
    }
    if (outcome.status === "aborted") {
      authoritative = false;
      continue;
    }
    if (outcome.status === "timed-out") {
      authoritative = false;
      if (!invocation.timeoutWarningLogged) {
        invocation.timeoutWarningLogged = true;
        const pluginId = plugin.pluginId ?? plugin.id;
        log.warn(
          `Provider plugin "${sanitizeForLog(pluginId)}" augmentModelCatalog hook timed out after ${PROVIDER_MODEL_CATALOG_AUGMENT_TIMEOUT_MS}ms; skipping hook and continuing catalog discovery`,
        );
      }
      continue;
    }
    const next = outcome.value;
    if (!next || next.length === 0) {
      continue;
    }
    supplemental.push(...next);
  }
  return { entries: supplemental, authoritative };
}

export async function augmentModelCatalogWithProviderPlugins(
  params: Parameters<typeof augmentModelCatalogWithProviderPluginsResult>[0],
) {
  return (await augmentModelCatalogWithProviderPluginsResult(params)).entries;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
