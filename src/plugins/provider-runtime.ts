import type { AuthProfileCredential, OAuthCredential } from "../agents/auth-profiles/types.js";
import {
  applyPluginTextReplacements,
  mergePluginTextTransforms,
} from "../agents/plugin-text-transforms.js";
import type { ProviderSystemPromptContribution } from "../agents/system-prompt-contribution.js";
import { appendAgentExecDebug } from "../cli/agent-exec-debug.js";
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  __testing as providerHookRuntimeTesting,
  clearProviderRuntimeHookCache,
  prepareProviderExtraParams,
  resetProviderRuntimeHookCacheForTest,
  resolveProviderHookPlugin,
  resolveProviderPluginsForHooks as resolveProviderHookRuntimePluginsForHooks,
  resolveProviderRuntimePlugin as resolveProviderHookRuntimePlugin,
  wrapProviderStreamFn,
} from "./provider-hook-runtime.js";
import { resolveBundledProviderPolicySurface } from "./provider-public-artifacts.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import { resolveCatalogHookProviderPluginIds } from "./providers.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state.js";
import { resolveRuntimeTextTransforms } from "./text-transforms.runtime.js";
import type {
  ProviderAuthDoctorHintContext,
  ProviderAugmentModelCatalogContext,
  ProviderExternalAuthProfile,
  ProviderBuildMissingAuthMessageContext,
  ProviderBuildUnknownModelHintContext,
  ProviderBuiltInModelSuppressionContext,
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
  ProviderResolveExternalAuthProfilesContext,
  ProviderResolveExternalOAuthProfilesContext,
  ProviderPrepareRuntimeAuthContext,
  ProviderApplyConfigDefaultsContext,
  ProviderResolveConfigApiKeyContext,
  ProviderSanitizeReplayHistoryContext,
  ProviderResolveUsageAuthContext,
  ProviderPlugin,
  ProviderResolveDynamicModelContext,
  ProviderResolveTransportTurnStateContext,
  ProviderResolveWebSocketSessionPolicyContext,
  ProviderSystemPromptContributionContext,
  ProviderTransformSystemPromptContext,
  ProviderThinkingPolicyContext,
  ProviderTransportTurnState,
  ProviderValidateReplayTurnsContext,
  ProviderWebSocketSessionPolicy,
  PluginTextTransforms,
} from "./types.js";
export {
  clearProviderRuntimeHookCache,
  prepareProviderExtraParams,
  resetProviderRuntimeHookCacheForTest,
  resolveProviderRuntimePluginWithCoordinationGuard as resolveProviderRuntimePlugin,
  wrapProviderStreamFn,
};

export const __testing = {
  ...providerHookRuntimeTesting,
  shouldSkipProviderRuntimePlugins,
} as const;

function shouldSkipProviderRuntimePlugins(params: {
  commandName?: string;
  effectiveToolPolicy?: string;
}): boolean {
  return params.commandName === "agent-exec" && params.effectiveToolPolicy === "coordination_only";
}

function resolveProviderPluginsForHooks(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
  providerRefs?: readonly string[];
  commandName?: string;
  effectiveToolPolicy?: string;
}): ProviderPlugin[] {
  const willSkipProviderHookRuntimePlugins = shouldSkipProviderRuntimePlugins(params);
  appendProviderRuntimeDebug("providerRuntime_resolveProviderPluginsForHooks_enter", {
    provider_runtime_helper: "resolveProviderPluginsForHooks",
    raw_commandName: params.commandName,
    raw_effectiveToolPolicy: params.effectiveToolPolicy,
    will_skip_provider_hook_runtime_plugins: willSkipProviderHookRuntimePlugins,
    calls_resolvePluginProviders: !willSkipProviderHookRuntimePlugins,
  });
  if (willSkipProviderHookRuntimePlugins) {
    return [];
  }
  appendProviderRuntimeDebug(
    "providerRuntime_resolveProviderPluginsForHooks_before_resolvePluginProviders",
    {
      provider_runtime_helper: "resolveProviderPluginsForHooks",
      raw_commandName: params.commandName,
      raw_effectiveToolPolicy: params.effectiveToolPolicy,
      will_skip_provider_hook_runtime_plugins: false,
      calls_resolvePluginProviders: true,
    },
  );
  return resolveProviderHookRuntimePluginsForHooks({
    ...params,
    providerRefs: params.providerRefs ? [...params.providerRefs] : undefined,
  });
}

function resolveProviderPluginsForCatalogHooks(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
}): ProviderPlugin[] {
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  const onlyPluginIds = resolveCatalogHookProviderPluginIds({
    config: params.config,
    workspaceDir,
    env: params.env,
  });
  if (onlyPluginIds.length === 0) {
    return [];
  }
  return resolveProviderPluginsForHooks({
    ...params,
    workspaceDir,
    onlyPluginIds,
  });
}

type ProviderRuntimeInvocationParams = {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
};

function appendProviderRuntimeDebug(
  event:
    | "providerRuntime_branch_enter"
    | "providerRuntime_resolveProviderRuntimePlugin_call"
    | "providerRuntime_resolveProviderPluginsForHooks_call"
    | "providerRuntime_resolveProviderPluginsForHooks_enter"
    | "providerRuntime_resolveProviderPluginsForHooks_before_resolvePluginProviders"
    | "providerRuntime_shouldDeferSyntheticProfileAuth_enter",
  params: Record<string, unknown>,
) {
  appendAgentExecDebug("provider-runtime", event, params);
}

function resolveProviderRuntimePluginWithCoordinationGuard(
  params: ProviderRuntimeInvocationParams,
) {
  if (shouldSkipProviderRuntimePlugins(params)) {
    return undefined;
  }
  return resolveProviderHookRuntimePlugin({
    provider: params.provider,
    config: params.config,
    workspaceDir: params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState(),
    env: params.env,
    commandName: params.commandName,
    effectiveToolPolicy: params.effectiveToolPolicy,
  });
}

export function runProviderDynamicModel(
  params: ProviderRuntimeInvocationParams & {
    context: ProviderResolveDynamicModelContext;
  },
): ProviderRuntimeModel | undefined {
  return (
    resolveProviderRuntimePluginWithCoordinationGuard(params)?.resolveDynamicModel?.(
      params.context,
    ) ?? undefined
  );
}

export function resolveProviderSystemPromptContribution(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderSystemPromptContributionContext;
}): ProviderSystemPromptContribution | undefined {
  return (
    resolveProviderRuntimePluginWithCoordinationGuard(params)?.resolveSystemPromptContribution?.(
      params.context,
    ) ?? undefined
  );
}

export function transformProviderSystemPrompt(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderTransformSystemPromptContext;
}): string {
  const plugin = resolveProviderRuntimePluginWithCoordinationGuard(params);
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
  commandName?: string;
  effectiveToolPolicy?: string;
}): PluginTextTransforms | undefined {
  return mergePluginTextTransforms(
    resolveRuntimeTextTransforms(),
    resolveProviderRuntimePluginWithCoordinationGuard(params)?.textTransforms,
  );
}

export async function prepareProviderDynamicModel(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderPrepareDynamicModelContext;
}): Promise<void> {
  await resolveProviderRuntimePluginWithCoordinationGuard(params)?.prepareDynamicModel?.(
    params.context,
  );
}

export function shouldPreferProviderRuntimeResolvedModel(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderPreferRuntimeResolvedModelContext;
}): boolean {
  return (
    resolveProviderRuntimePluginWithCoordinationGuard(params)?.preferRuntimeResolvedModel?.(
      params.context,
    ) ?? false
  );
}

export function normalizeProviderResolvedModelWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
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
    resolveProviderRuntimePluginWithCoordinationGuard(params)?.normalizeResolvedModel?.(
      params.context,
    ) ?? undefined
  );
}

function resolveProviderCompatHookPlugins(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
}): ProviderPlugin[] {
  if (shouldSkipProviderRuntimePlugins(params)) {
    return [];
  }

  const candidates = resolveProviderPluginsForHooks(params);
  const owner = resolveProviderRuntimePluginWithCoordinationGuard(params);
  if (!owner) {
    return candidates;
  }

  const ordered = [owner, ...candidates];
  const seen = new Set<string>();
  return ordered.filter((candidate) => {
    const key = `${candidate.pluginId ?? ""}:${candidate.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function applyCompatPatchToModel(
  model: ProviderRuntimeModel,
  patch: Record<string, unknown>,
): ProviderRuntimeModel {
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as Record<string, unknown>)
      : undefined;
  if (Object.entries(patch).every(([key, value]) => compat?.[key] === value)) {
    return model;
  }
  return {
    ...model,
    compat: {
      ...compat,
      ...patch,
    },
  };
}

export function applyProviderResolvedModelCompatWithPlugins(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderNormalizeResolvedModelContext;
}): ProviderRuntimeModel | undefined {
  let nextModel = params.context.model;
  let changed = false;

  for (const plugin of resolveProviderCompatHookPlugins(params)) {
    const patch = plugin.contributeResolvedModelCompat?.({
      ...params.context,
      model: nextModel,
    });
    if (!patch || typeof patch !== "object") {
      continue;
    }
    const patchedModel = applyCompatPatchToModel(nextModel, patch as Record<string, unknown>);
    if (patchedModel === nextModel) {
      continue;
    }
    nextModel = patchedModel;
    changed = true;
  }

  return changed ? nextModel : undefined;
}

export function applyProviderResolvedTransportWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderNormalizeResolvedModelContext;
}): ProviderRuntimeModel | undefined {
  const normalized = normalizeProviderTransportWithPlugin({
    provider: params.provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    commandName: params.commandName,
    effectiveToolPolicy: params.effectiveToolPolicy,
    context: {
      provider: params.context.provider,
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
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderNormalizeModelIdContext;
}): string | undefined {
  const plugin = resolveProviderHookPlugin(params);
  return normalizeOptionalString(plugin?.normalizeModelId?.(params.context));
}

export function normalizeProviderTransportWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderNormalizeTransportContext;
}): { api?: string | null; baseUrl?: string } | undefined {
  const hasTransportChange = (normalized: { api?: string | null; baseUrl?: string }) =>
    (normalized.api ?? params.context.api) !== params.context.api ||
    (normalized.baseUrl ?? params.context.baseUrl) !== params.context.baseUrl;
  const matchedPlugin = resolveProviderHookPlugin(params);
  const normalizedMatched = matchedPlugin?.normalizeTransport?.(params.context);
  if (normalizedMatched && hasTransportChange(normalizedMatched)) {
    return normalizedMatched;
  }

  for (const candidate of resolveProviderPluginsForHooks(params)) {
    if (!candidate.normalizeTransport || candidate === matchedPlugin) {
      continue;
    }
    const normalized = candidate.normalizeTransport(params.context);
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
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderNormalizeConfigContext;
}): ModelProviderConfig | undefined {
  const hasConfigChange = (normalized: ModelProviderConfig) =>
    normalized !== params.context.providerConfig;
  const bundledSurface = resolveBundledProviderPolicySurface(params.provider);
  if (bundledSurface?.normalizeConfig) {
    const normalized = bundledSurface.normalizeConfig(params.context);
    return normalized && hasConfigChange(normalized) ? normalized : undefined;
  }
  const matchedPlugin = resolveProviderHookPlugin(params);
  const normalizedMatched = matchedPlugin?.normalizeConfig?.(params.context);
  if (normalizedMatched && hasConfigChange(normalizedMatched)) {
    return normalizedMatched;
  }

  for (const candidate of resolveProviderPluginsForHooks(params)) {
    if (!candidate.normalizeConfig || candidate === matchedPlugin) {
      continue;
    }
    const normalized = candidate.normalizeConfig(params.context);
    if (normalized && hasConfigChange(normalized)) {
      return normalized;
    }
  }

  return undefined;
}

export function applyProviderNativeStreamingUsageCompatWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderNormalizeConfigContext;
}): ModelProviderConfig | undefined {
  return (
    resolveProviderHookPlugin(params)?.applyNativeStreamingUsageCompat?.(params.context) ??
    undefined
  );
}

export function resolveProviderConfigApiKeyWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderResolveConfigApiKeyContext;
}): string | undefined {
  const bundledSurface = resolveBundledProviderPolicySurface(params.provider);
  if (bundledSurface?.resolveConfigApiKey) {
    return normalizeOptionalString(bundledSurface.resolveConfigApiKey(params.context));
  }
  return normalizeOptionalString(
    resolveProviderHookPlugin(params)?.resolveConfigApiKey?.(params.context),
  );
}

export function resolveProviderReplayPolicyWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderReplayPolicyContext;
}): ProviderReplayPolicy | undefined {
  return resolveProviderHookPlugin(params)?.buildReplayPolicy?.(params.context) ?? undefined;
}

export async function sanitizeProviderReplayHistoryWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderSanitizeReplayHistoryContext;
}) {
  return await resolveProviderHookPlugin(params)?.sanitizeReplayHistory?.(params.context);
}

export async function validateProviderReplayTurnsWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderValidateReplayTurnsContext;
}) {
  return await resolveProviderHookPlugin(params)?.validateReplayTurns?.(params.context);
}

export function normalizeProviderToolSchemasWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderNormalizeToolSchemasContext;
}) {
  return resolveProviderHookPlugin(params)?.normalizeToolSchemas?.(params.context) ?? undefined;
}

export function inspectProviderToolSchemasWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderNormalizeToolSchemasContext;
}) {
  return resolveProviderHookPlugin(params)?.inspectToolSchemas?.(params.context) ?? undefined;
}

export function resolveProviderReasoningOutputModeWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderReasoningOutputModeContext;
}): ProviderReasoningOutputMode | undefined {
  const mode = resolveProviderHookPlugin(params)?.resolveReasoningOutputMode?.(params.context);
  return mode === "native" || mode === "tagged" ? mode : undefined;
}

export function resolveProviderStreamFn(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderCreateStreamFnContext;
}) {
  return (
    resolveProviderRuntimePluginWithCoordinationGuard(params)?.createStreamFn?.(params.context) ??
    undefined
  );
}

export function resolveProviderTransportTurnStateWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderResolveTransportTurnStateContext;
}): ProviderTransportTurnState | undefined {
  return (
    resolveProviderHookPlugin(params)?.resolveTransportTurnState?.(params.context) ?? undefined
  );
}

export function resolveProviderWebSocketSessionPolicyWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderResolveWebSocketSessionPolicyContext;
}): ProviderWebSocketSessionPolicy | undefined {
  return (
    resolveProviderHookPlugin(params)?.resolveWebSocketSessionPolicy?.(params.context) ?? undefined
  );
}

export async function createProviderEmbeddingProvider(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderCreateEmbeddingProviderContext;
}) {
  appendProviderRuntimeDebug("providerRuntime_branch_enter", {
    provider_runtime_branch: "createProviderEmbeddingProvider",
    raw_commandName: params.commandName,
    raw_effectiveToolPolicy: params.effectiveToolPolicy,
    uses_coordination_guard: false,
    calls_resolveProviderPluginsForHooks_directly: false,
  });
  appendProviderRuntimeDebug("providerRuntime_resolveProviderRuntimePlugin_call", {
    provider_runtime_branch: "createProviderEmbeddingProvider",
    raw_commandName: params.commandName,
    raw_effectiveToolPolicy: params.effectiveToolPolicy,
    uses_coordination_guard: false,
    calls_resolveProviderPluginsForHooks_directly: false,
  });
  return await resolveProviderRuntimePluginWithCoordinationGuard(params)?.createEmbeddingProvider?.(
    params.context,
  );
}

export async function prepareProviderRuntimeAuth(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderPrepareRuntimeAuthContext;
}) {
  appendProviderRuntimeDebug("providerRuntime_branch_enter", {
    provider_runtime_branch: "prepareProviderRuntimeAuth",
    raw_commandName: params.commandName,
    raw_effectiveToolPolicy: params.effectiveToolPolicy,
    uses_coordination_guard: false,
    calls_resolveProviderPluginsForHooks_directly: false,
  });
  appendProviderRuntimeDebug("providerRuntime_resolveProviderRuntimePlugin_call", {
    provider_runtime_branch: "prepareProviderRuntimeAuth",
    raw_commandName: params.commandName,
    raw_effectiveToolPolicy: params.effectiveToolPolicy,
    uses_coordination_guard: false,
    calls_resolveProviderPluginsForHooks_directly: false,
  });
  return await resolveProviderRuntimePluginWithCoordinationGuard(params)?.prepareRuntimeAuth?.(
    params.context,
  );
}

export async function resolveProviderUsageAuthWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderResolveUsageAuthContext;
}) {
  appendProviderRuntimeDebug("providerRuntime_branch_enter", {
    provider_runtime_branch: "resolveProviderUsageAuthWithPlugin",
    raw_commandName: params.commandName,
    raw_effectiveToolPolicy: params.effectiveToolPolicy,
    uses_coordination_guard: false,
    calls_resolveProviderPluginsForHooks_directly: false,
  });
  appendProviderRuntimeDebug("providerRuntime_resolveProviderRuntimePlugin_call", {
    provider_runtime_branch: "resolveProviderUsageAuthWithPlugin",
    raw_commandName: params.commandName,
    raw_effectiveToolPolicy: params.effectiveToolPolicy,
    uses_coordination_guard: false,
    calls_resolveProviderPluginsForHooks_directly: false,
  });
  return await resolveProviderRuntimePluginWithCoordinationGuard(params)?.resolveUsageAuth?.(
    params.context,
  );
}

export async function resolveProviderUsageSnapshotWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderFetchUsageSnapshotContext;
}) {
  appendProviderRuntimeDebug("providerRuntime_branch_enter", {
    provider_runtime_branch: "resolveProviderUsageSnapshotWithPlugin",
    raw_commandName: params.commandName,
    raw_effectiveToolPolicy: params.effectiveToolPolicy,
    uses_coordination_guard: false,
    calls_resolveProviderPluginsForHooks_directly: false,
  });
  appendProviderRuntimeDebug("providerRuntime_resolveProviderRuntimePlugin_call", {
    provider_runtime_branch: "resolveProviderUsageSnapshotWithPlugin",
    raw_commandName: params.commandName,
    raw_effectiveToolPolicy: params.effectiveToolPolicy,
    uses_coordination_guard: false,
    calls_resolveProviderPluginsForHooks_directly: false,
  });
  return await resolveProviderRuntimePluginWithCoordinationGuard(params)?.fetchUsageSnapshot?.(
    params.context,
  );
}

export function matchesProviderContextOverflowWithPlugin(params: {
  provider?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderFailoverErrorContext;
}): boolean {
  const plugins = params.provider
    ? [resolveProviderHookPlugin({ ...params, provider: params.provider })].filter(
        (plugin): plugin is ProviderPlugin => Boolean(plugin),
      )
    : resolveProviderPluginsForHooks(params);
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
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderFailoverErrorContext;
}) {
  const plugins = params.provider
    ? [resolveProviderHookPlugin({ ...params, provider: params.provider })].filter(
        (plugin): plugin is ProviderPlugin => Boolean(plugin),
      )
    : resolveProviderPluginsForHooks(params);
  for (const plugin of plugins) {
    const reason = plugin.classifyFailoverReason?.(params.context);
    if (reason) {
      return reason;
    }
  }
  return undefined;
}

export function formatProviderAuthProfileApiKeyWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: AuthProfileCredential;
}) {
  return resolveProviderRuntimePluginWithCoordinationGuard(params)?.formatApiKey?.(params.context);
}

export async function refreshProviderOAuthCredentialWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: OAuthCredential;
}) {
  appendProviderRuntimeDebug("providerRuntime_branch_enter", {
    provider_runtime_branch: "refreshProviderOAuthCredentialWithPlugin",
    raw_commandName: params.commandName,
    raw_effectiveToolPolicy: params.effectiveToolPolicy,
    uses_coordination_guard: false,
    calls_resolveProviderPluginsForHooks_directly: false,
  });
  appendProviderRuntimeDebug("providerRuntime_resolveProviderRuntimePlugin_call", {
    provider_runtime_branch: "refreshProviderOAuthCredentialWithPlugin",
    raw_commandName: params.commandName,
    raw_effectiveToolPolicy: params.effectiveToolPolicy,
    uses_coordination_guard: false,
    calls_resolveProviderPluginsForHooks_directly: false,
  });
  return await resolveProviderRuntimePluginWithCoordinationGuard(params)?.refreshOAuth?.(
    params.context,
  );
}

export async function buildProviderAuthDoctorHintWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderAuthDoctorHintContext;
}) {
  appendProviderRuntimeDebug("providerRuntime_branch_enter", {
    provider_runtime_branch: "buildProviderAuthDoctorHintWithPlugin",
    raw_commandName: params.commandName,
    raw_effectiveToolPolicy: params.effectiveToolPolicy,
    uses_coordination_guard: false,
    calls_resolveProviderPluginsForHooks_directly: false,
  });
  appendProviderRuntimeDebug("providerRuntime_resolveProviderRuntimePlugin_call", {
    provider_runtime_branch: "buildProviderAuthDoctorHintWithPlugin",
    raw_commandName: params.commandName,
    raw_effectiveToolPolicy: params.effectiveToolPolicy,
    uses_coordination_guard: false,
    calls_resolveProviderPluginsForHooks_directly: false,
  });
  return await resolveProviderRuntimePluginWithCoordinationGuard(params)?.buildAuthDoctorHint?.(
    params.context,
  );
}

export function resolveProviderCacheTtlEligibility(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderCacheTtlEligibilityContext;
}) {
  return resolveProviderRuntimePluginWithCoordinationGuard(params)?.isCacheTtlEligible?.(
    params.context,
  );
}

export function resolveProviderBinaryThinking(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderThinkingPolicyContext;
}) {
  return resolveProviderRuntimePluginWithCoordinationGuard(params)?.isBinaryThinking?.(
    params.context,
  );
}

export function resolveProviderXHighThinking(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderThinkingPolicyContext;
}) {
  return resolveProviderRuntimePluginWithCoordinationGuard(params)?.supportsXHighThinking?.(
    params.context,
  );
}

export function resolveProviderAdaptiveThinking(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderThinkingPolicyContext;
}) {
  return resolveProviderRuntimePluginWithCoordinationGuard(params)?.supportsAdaptiveThinking?.(
    params.context,
  );
}

export function resolveProviderMaxThinking(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderThinkingPolicyContext;
}) {
  return resolveProviderRuntimePluginWithCoordinationGuard(params)?.supportsMaxThinking?.(
    params.context,
  );
}

export function resolveProviderDefaultThinkingLevel(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderDefaultThinkingPolicyContext;
}) {
  return resolveProviderRuntimePluginWithCoordinationGuard(params)?.resolveDefaultThinkingLevel?.(
    params.context,
  );
}

export function applyProviderConfigDefaultsWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderApplyConfigDefaultsContext;
}) {
  const bundledSurface = resolveBundledProviderPolicySurface(params.provider);
  if (bundledSurface?.applyConfigDefaults) {
    return bundledSurface.applyConfigDefaults(params.context) ?? undefined;
  }
  return (
    resolveProviderRuntimePluginWithCoordinationGuard(params)?.applyConfigDefaults?.(
      params.context,
    ) ?? undefined
  );
}

export function resolveProviderModernModelRef(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderModernModelPolicyContext;
}) {
  return resolveProviderRuntimePluginWithCoordinationGuard(params)?.isModernModelRef?.(
    params.context,
  );
}

export function buildProviderMissingAuthMessageWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderBuildMissingAuthMessageContext;
}) {
  return (
    resolveProviderRuntimePluginWithCoordinationGuard(params)?.buildMissingAuthMessage?.(
      params.context,
    ) ?? undefined
  );
}

export function buildProviderUnknownModelHintWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderBuildUnknownModelHintContext;
}) {
  return (
    resolveProviderRuntimePluginWithCoordinationGuard(params)?.buildUnknownModelHint?.(
      params.context,
    ) ?? undefined
  );
}

export function resolveProviderSyntheticAuthWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderResolveSyntheticAuthContext;
}) {
  return (
    resolveProviderRuntimePluginWithCoordinationGuard(params)?.resolveSyntheticAuth?.(
      params.context,
    ) ?? undefined
  );
}

export function resolveExternalAuthProfilesWithPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderResolveExternalAuthProfilesContext;
}): ProviderExternalAuthProfile[] {
  appendProviderRuntimeDebug("providerRuntime_branch_enter", {
    provider_runtime_branch: "resolveExternalAuthProfilesWithPlugins",
    raw_commandName: params.commandName,
    raw_effectiveToolPolicy: params.effectiveToolPolicy,
    uses_coordination_guard: false,
    calls_resolveProviderPluginsForHooks_directly: true,
  });
  appendProviderRuntimeDebug("providerRuntime_resolveProviderPluginsForHooks_call", {
    provider_runtime_branch: "resolveExternalAuthProfilesWithPlugins",
    raw_commandName: params.commandName,
    raw_effectiveToolPolicy: params.effectiveToolPolicy,
    uses_coordination_guard: false,
    calls_resolveProviderPluginsForHooks_directly: true,
  });
  const matches: ProviderExternalAuthProfile[] = [];
  for (const plugin of resolveProviderPluginsForHooks({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    commandName: params.commandName,
    effectiveToolPolicy: params.effectiveToolPolicy,
  })) {
    const profiles =
      plugin.resolveExternalAuthProfiles?.(params.context) ??
      plugin.resolveExternalOAuthProfiles?.(params.context);
    if (!profiles || profiles.length === 0) {
      continue;
    }
    matches.push(...profiles);
  }
  return matches;
}

export function resolveExternalOAuthProfilesWithPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderResolveExternalOAuthProfilesContext;
}): ProviderExternalAuthProfile[] {
  return resolveExternalAuthProfilesWithPlugins(params);
}

export function shouldDeferProviderSyntheticProfileAuthWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
  context: ProviderDeferSyntheticProfileAuthContext;
}) {
  appendProviderRuntimeDebug("providerRuntime_shouldDeferSyntheticProfileAuth_enter", {
    raw_commandName: params.commandName ?? null,
    raw_effectiveToolPolicy: params.effectiveToolPolicy ?? null,
    has_commandName: params.commandName !== undefined,
    has_effectiveToolPolicy: params.effectiveToolPolicy !== undefined,
    provider: params.provider,
  });
  return (
    resolveProviderRuntimePluginWithCoordinationGuard({
      provider: params.provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      commandName: params.commandName,
      effectiveToolPolicy: params.effectiveToolPolicy,
    })?.shouldDeferSyntheticProfileAuth?.(params.context) ?? undefined
  );
}

export function resolveProviderBuiltInModelSuppression(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  commandName?: string;
  effectiveToolPolicy?: string;
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
  commandName?: string;
  effectiveToolPolicy?: string;
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
