import { stripSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OAuthCredential } from "../agents/auth-profiles/types.js";
import { resolveGpt5SystemPromptContribution } from "../agents/gpt5-prompt-overlay.js";
import { getRegisteredAgentHarness } from "../agents/harness/registry.js";
import {
  applyPluginTextReplacements,
  mergePluginTextTransforms,
} from "../agents/plugin-text-transforms.js";
import type { StreamFn } from "../agents/runtime/index.js";
import type { ProviderSystemPromptContribution } from "../agents/system-prompt-contribution.js";
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { providerUsageLabel } from "../infra/provider-usage.shared.js";
import type { UsageProviderId } from "../infra/provider-usage.types.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import type {
  PluginMetadataRegistryView,
  PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.types.js";
import { hasConfiguredModelProvider } from "./provider-config-owner.js";
import { resolvePluginDiscoveryProvidersRuntime } from "./provider-discovery.runtime.js";
import {
  resolveProviderAuthProfileId,
  resolveProviderFollowupFallbackRoute,
  ensureProviderRuntimePluginHandle,
  resolveLoadedProviderRuntimePlugin,
  resolveProviderHookPlugin,
  resolveProviderPluginsForHooks,
  resolveProviderRuntimePlugin,
  wrapProviderSimpleCompletionStreamFn,
  type ProviderRuntimePluginHandle,
} from "./provider-hook-runtime.js";
import {
  resolveBundledProviderPolicySurface,
  resolveProviderPolicySurface,
} from "./provider-public-artifacts.js";
import { matchesProviderPluginRef } from "./provider-registry-shared.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import {
  prepareSyntheticAuthWithProvider,
  readPreparedSyntheticAuthFact,
  resolveSyntheticAuthWithProvider,
  type PreparedSyntheticAuthFact,
  type PreparedSyntheticAuthFacts,
} from "./provider-synthetic-auth.js";
import {
  resolveCatalogHookProviderPluginIds,
  resolveOwningPluginIdsForProviderRef,
  resolveProviderRefOwnership,
  resolveUsageHookProviderPluginContracts,
} from "./providers.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state.js";
import { resolveRuntimeTextTransforms } from "./text-transforms.runtime.js";
import type {
  ProviderAugmentModelCatalogContext,
  ProviderDeferSyntheticProfileAuthContext,
  ProviderResolveSyntheticAuthContext,
  ProviderCreateStreamFnContext,
  ProviderFetchUsageSnapshotContext,
  ProviderNormalizeConfigContext,
  ProviderNormalizeResolvedModelContext,
  ProviderNormalizeTransportContext,
  ProviderPreferRuntimeResolvedModelContext,
  ProviderPlugin,
  ProviderResolveConfigApiKeyContext,
  ProviderResolveTransportTurnStateContext,
  ProviderSystemPromptContributionContext,
  ProviderTransformSystemPromptContext,
  ProviderTransportTurnState,
  PluginTextTransforms,
} from "./types.js";

type ProviderRuntimeLookup = Pick<
  Parameters<typeof resolveProviderRuntimePlugin>[0],
  "provider" | "config" | "workspaceDir" | "env"
>;

type RuntimeHookName = {
  [K in keyof ProviderPlugin]-?: NonNullable<ProviderPlugin[K]> extends (context: never) => unknown
    ? K
    : never;
}[keyof ProviderPlugin];

function runtimeHook<K extends RuntimeHookName>(name: K) {
  type Hook = Extract<ProviderPlugin[K], (context: never) => unknown>;
  return (
    params: ProviderRuntimeLookup & { context: Parameters<Hook>[0] },
  ): ReturnType<Hook> | undefined => {
    const plugin = resolveProviderRuntimePlugin(params);
    // SAFETY: RuntimeHookName selects a callable; the same key determines its argument and result.
    const hook = plugin?.[name] as ((context: Parameters<Hook>[0]) => ReturnType<Hook>) | undefined;
    return hook?.call(plugin, params.context);
  };
}

function normalizedRuntimeHook<K extends RuntimeHookName>(name: K) {
  const invoke = runtimeHook(name);
  return (params: Parameters<typeof invoke>[0]) => invoke(params) ?? undefined;
}

function asyncRuntimeHook<K extends RuntimeHookName>(name: K) {
  const invoke = runtimeHook(name);
  return async (
    params: Parameters<typeof invoke>[0],
  ): Promise<Awaited<ReturnType<typeof invoke>>> => await Promise.resolve(invoke(params));
}

function toolSchemaHook<K extends "normalizeToolSchemas" | "inspectToolSchemas">(name: K) {
  type Hook = NonNullable<ProviderPlugin[K]>;
  return (
    params: ProviderRuntimeLookup & {
      runtimeHandle?: ProviderRuntimePluginHandle;
      allowRuntimePluginLoad?: boolean;
      context: Parameters<Hook>[0];
    },
  ) => {
    const plugin =
      params.allowRuntimePluginLoad === false
        ? (params.runtimeHandle?.plugin ?? resolveLoadedProviderRuntimePlugin(params))
        : ensureProviderRuntimePluginHandle(params).plugin;
    // SAFETY: Hook derives both argument and result from the selected tool-schema method.
    const hook = plugin?.[name] as ((context: Parameters<Hook>[0]) => ReturnType<Hook>) | undefined;
    return hook?.call(plugin, params.context) ?? undefined;
  };
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
  return refs;
}

function matchesAnyProviderPluginRef(provider: ProviderPlugin, providerRefs: readonly string[]) {
  return providerRefs.some((providerRef) => matchesProviderPluginRef(provider, providerRef));
}

export {
  resolveProviderAuthProfileId,
  resolveProviderFollowupFallbackRoute,
  resolveProviderRuntimePlugin,
  wrapProviderSimpleCompletionStreamFn,
};

function resolveProviderPluginsForCatalogHooks(params: {
  providerIds?: readonly string[];
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
}): ProviderPlugin[] {
  const workspaceDir =
    params.workspaceDir ??
    params.metadataSnapshot?.workspaceDir ??
    getActivePluginRegistryWorkspaceDirFromState();
  const env = params.env ?? process.env;
  const onlyPluginIds = resolveCatalogHookProviderPluginIds({
    config: params.config,
    workspaceDir,
    env,
    metadataSnapshot: params.metadataSnapshot,
  });
  if (onlyPluginIds.length === 0 || params.providerIds?.length === 0) {
    return [];
  }
  const providers = resolveProviderPluginsForHooks({
    ...params,
    workspaceDir,
    env,
    onlyPluginIds,
    providerRefs: params.providerIds,
    pluginMetadataSnapshot: params.metadataSnapshot,
  });
  const providerIds = params.providerIds;
  return providerIds
    ? providers.filter((provider) => matchesAnyProviderPluginRef(provider, providerIds))
    : providers;
}

export const runProviderDynamicModel = normalizedRuntimeHook("resolveDynamicModel");

export function resolveProviderSystemPromptContribution(
  params: ProviderRuntimeLookup & {
    runtimeHandle?: ProviderRuntimePluginHandle;
    context: ProviderSystemPromptContributionContext;
  },
): ProviderSystemPromptContribution | undefined {
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

export function transformProviderSystemPrompt(
  params: ProviderRuntimeLookup & {
    runtimeHandle?: ProviderRuntimePluginHandle;
    context: ProviderTransformSystemPromptContext;
  },
): string {
  const plugin = ensureProviderRuntimePluginHandle(params).plugin;
  const textTransforms = mergePluginTextTransforms(
    resolveRuntimeTextTransforms(),
    plugin?.textTransforms,
  );
  const transformed =
    plugin?.transformSystemPrompt?.(params.context) ?? params.context.systemPrompt;
  return applyPluginTextReplacements(transformed, textTransforms?.input);
}

export function resolveProviderTextTransforms(
  params: ProviderRuntimeLookup & {
    runtimeHandle?: ProviderRuntimePluginHandle;
  },
): PluginTextTransforms | undefined {
  return mergePluginTextTransforms(
    resolveRuntimeTextTransforms(),
    ensureProviderRuntimePluginHandle(params).plugin?.textTransforms,
  );
}

export const prepareProviderDynamicModel = asyncRuntimeHook("prepareDynamicModel");

export function providerOwnsDynamicModelPreparation(params: ProviderRuntimeLookup): boolean {
  return resolveProviderRuntimePlugin(params)?.prepareDynamicModel !== undefined;
}

export function shouldPreferProviderRuntimeResolvedModel(
  params: ProviderRuntimeLookup & {
    context: ProviderPreferRuntimeResolvedModelContext;
  },
): boolean {
  return (
    resolveProviderRuntimePlugin(params)?.preferRuntimeResolvedModel?.(params.context) ?? false
  );
}

export function normalizeProviderResolvedModelWithPlugin(
  params: ProviderRuntimeLookup & {
    pluginMetadataSnapshot?: PluginMetadataRegistryView;
    context: ProviderNormalizeResolvedModelContext;
  },
): ProviderRuntimeModel | undefined {
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

export function applyProviderResolvedTransportWithPlugin(
  params: ProviderRuntimeLookup & {
    context: ProviderNormalizeResolvedModelContext;
  },
): ProviderRuntimeModel | undefined {
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
    // SAFETY: The provider owns both transport normalization and the model API discriminator.
    api: nextApi as ProviderRuntimeModel["api"],
    baseUrl: nextBaseUrl,
  };
}

export function normalizeProviderTransportWithPlugin(
  params: ProviderRuntimeLookup & {
    modelId?: string | null;
    context: ProviderNormalizeTransportContext;
  },
): { api?: string | null; baseUrl?: string } | undefined {
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
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  context: ProviderNormalizeConfigContext;
}): ModelProviderConfig | undefined {
  const bundledSurface = resolveBundledProviderPolicySurface(params.provider, {
    manifestRegistry: params.manifestRegistry,
  });
  const normalized = bundledSurface?.normalizeConfig?.(params.context);
  return normalized && normalized !== params.context.providerConfig ? normalized : undefined;
}

export function resolveProviderConfigApiKeyWithPlugin(params: {
  provider: string;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  context: ProviderResolveConfigApiKeyContext;
}): string | undefined {
  const bundledSurface = resolveBundledProviderPolicySurface(params.provider, {
    manifestRegistry: params.manifestRegistry,
  });
  return normalizeOptionalString(bundledSurface?.resolveConfigApiKey?.(params.context));
}

export {
  resolveProviderReasoningOutputModeWithPlugin,
  sanitizeProviderReplayHistoryWithPluginAsync,
  validateProviderReplayTurnsWithPlugin,
} from "./provider-replay-runtime.js";

export const normalizeProviderToolSchemasWithPlugin = toolSchemaHook("normalizeToolSchemas");

export const inspectProviderToolSchemasWithPlugin = toolSchemaHook("inspectToolSchemas");

export function resolveProviderStreamFn(
  params: ProviderRuntimeLookup & {
    runtimeHandle?: ProviderRuntimePluginHandle;
    allowRuntimePluginLoad?: boolean;
    context: ProviderCreateStreamFnContext;
  },
): StreamFn | undefined {
  // Transport families may explicitly ask for a different fallback owner.
  const plugin =
    params.runtimeHandle?.provider === params.provider
      ? ensureProviderRuntimePluginHandle(params).plugin
      : params.allowRuntimePluginLoad === false
        ? resolveLoadedProviderRuntimePlugin(params)
        : resolveProviderRuntimePlugin(params);
  const streamFn = plugin?.createStreamFn?.(params.context);
  if (!streamFn || plugin?.supportsSystemPromptCacheBoundary) {
    return streamFn ?? undefined;
  }
  return (model, context, options) =>
    streamFn(
      model,
      context.systemPrompt
        ? { ...context, systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt) }
        : context,
      options,
    );
}

export function resolveProviderTransportTurnStateWithPlugin(
  params: ProviderRuntimeLookup & {
    modelId?: string | null;
    runtimeHandle?: ProviderRuntimePluginHandle;
    allowRuntimePluginLoad?: boolean;
    context: ProviderResolveTransportTurnStateContext;
  },
): ProviderTransportTurnState | undefined {
  const plugin = params.runtimeHandle
    ? ensureProviderRuntimePluginHandle(params).plugin
    : params.allowRuntimePluginLoad === false
      ? resolveLoadedProviderRuntimePlugin(params)
      : resolveProviderRuntimePlugin(params);
  const turnState = plugin?.resolveTransportTurnState?.(params.context) ?? undefined;
  if (params.context.transport !== "websocket") {
    return turnState;
  }
  const legacyPolicy = plugin?.resolveWebSocketSessionPolicy?.(params.context);
  if (!legacyPolicy) {
    return turnState;
  }
  return {
    ...turnState,
    websocket: {
      ...legacyPolicy,
      ...turnState?.websocket,
    },
  };
}

export { prepareProviderRuntimeAuth } from "./provider-runtime-auth.js";

const resolveUsageAuth = asyncRuntimeHook("resolveUsageAuth");
export const resolveProviderUsageAuthWithPlugin = async (
  params: Parameters<typeof resolveUsageAuth>[0],
) => (await resolveUsageAuth(params)) ?? undefined;

export async function resolveProviderUsageSnapshotWithPlugin(
  params: ProviderRuntimeLookup & {
    context: ProviderFetchUsageSnapshotContext;
  },
) {
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

  const harness = getRegisteredAgentHarness(params.provider)?.harness;
  if (!harness) {
    const workspaceDir =
      params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState() ?? process.cwd();
    const { withAgentPluginRegistry } = await import("../agents/runtime-plugins.js");
    const { ensureSelectedAgentHarnessPlugin } =
      await import("../agents/harness/runtime-plugin.js");
    return await withAgentPluginRegistry({
      config: params.config ?? {},
      ...(params.env ? { env: params.env } : {}),
      selections: [{ provider: params.context.provider, modelId: "", runtime: params.provider }],
      workspaceDir,
      run: async (pluginRegistry) => {
        await ensureSelectedAgentHarnessPlugin({
          provider: params.context.provider,
          modelId: "",
          config: params.config,
          agentHarnessId: params.provider,
          workspaceDir,
          pluginRegistry,
        });
        return await getRegisteredAgentHarness(params.provider)?.harness.fetchUsageSnapshot?.(
          params.context,
        );
      },
    });
  }
  return await harness.fetchUsageSnapshot?.(params.context);
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
  // Manifest contracts own usage discovery. Materializing plugin runtime here loads
  // every bundled provider plugin on cold status RPCs; fetch-time resolution stays
  // the runtime authority for plugins that fail to implement their declared hooks.
  const descriptors = new Map<string, ProviderUsagePluginDescriptor>();
  for (const contract of resolveUsageHookProviderPluginContracts(params)) {
    for (const declaredProviderId of contract.providerIds) {
      const provider = normalizeProviderId(declaredProviderId);
      if (!provider || descriptors.has(provider)) {
        continue;
      }
      descriptors.set(provider, {
        provider,
        displayName: providerUsageLabel(provider) ?? provider,
      });
    }
  }
  return [...descriptors.values()].toSorted((a, b) => a.provider.localeCompare(b.provider));
}

export { classifyProviderFailoverSignalWithPlugin } from "./provider-failover.js";

export const formatProviderAuthProfileApiKeyWithPlugin = runtimeHook("formatApiKey");

export async function loginProviderOAuthWithPlugin(
  params: ProviderRuntimeLookup & {
    context: Parameters<NonNullable<ProviderPlugin["loginOAuth"]>>[0];
  },
) {
  const ownership = resolveProviderRefOwnership(params);
  const loginOAuth = resolveProviderRuntimePlugin(params)?.loginOAuth;
  if (!loginOAuth) {
    return {
      status: ownership.status === "unowned" ? "unowned" : "configured-unavailable",
    } as const;
  }
  return {
    status: "available" as const,
    credentials: await loginOAuth(params.context),
  };
}

export async function resolveProviderOAuthCredentialWithPlugin(
  params: ProviderRuntimeLookup & {
    credential: OAuthCredential;
    refresh: boolean;
  },
) {
  const ownership = resolveProviderRefOwnership(params);
  const plugin = resolveProviderRuntimePlugin(params);
  if (!plugin) {
    return {
      status: ownership.status === "unowned" ? "unowned" : "configured-unavailable",
    } as const;
  }
  let credential = params.credential;
  if (params.refresh) {
    const refreshOAuth = plugin.refreshOAuth;
    if (!refreshOAuth) {
      return { status: "unhandled" } as const;
    }
    credential = await refreshOAuth(params.credential);
  }
  if (!credential) {
    return { status: "unhandled" } as const;
  }
  const apiKey = plugin.formatApiKey?.(credential) ?? credential.access;
  if (typeof apiKey !== "string" || !apiKey) {
    return { status: "unhandled" } as const;
  }
  return { status: "available" as const, credential, apiKey };
}

/** Resolve whether the current provider plugin generation owns OAuth refresh. */
export function resolveProviderOAuthRefreshCapabilityWithPlugin(params: ProviderRuntimeLookup) {
  const ownership = resolveProviderRefOwnership(params);
  const plugin = resolveProviderRuntimePlugin(params);
  if (!plugin) {
    return {
      status: ownership.status === "unowned" ? "unowned" : "configured-unavailable",
    } as const;
  }
  return plugin.refreshOAuth
    ? ({ status: "available" } as const)
    : ({ status: "unhandled" } as const);
}

export const refreshProviderOAuthCredentialWithPlugin = asyncRuntimeHook("refreshOAuth");

export const buildProviderAuthDoctorHintWithPlugin = asyncRuntimeHook("buildAuthDoctorHint");

export const resolveProviderCacheTtlEligibility = runtimeHook("isCacheTtlEligible");

export const resolveProviderModernModelRef = runtimeHook("isModernModelRef");

/** Returns provider-owned profile ids retired from generic credential resolution. */
export function resolveProviderDeprecatedAuthProfileIds(
  params: ProviderRuntimeLookup,
): readonly string[] {
  const metadataSnapshot = getCurrentPluginMetadataSnapshot({
    config: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
    allowScopedSnapshot: true,
    allowWorkspaceScopedSnapshot: true,
  });
  return (
    resolveProviderPolicySurface(params.provider, {
      manifestRegistry: metadataSnapshot?.manifestRegistry,
    })?.deprecatedProfileIds ??
    resolveLoadedProviderRuntimePlugin(params)?.deprecatedProfileIds ??
    []
  );
}

export const buildProviderMissingAuthMessageWithPlugin =
  normalizedRuntimeHook("buildMissingAuthMessage");

export const buildProviderUnknownModelHintWithPlugin =
  normalizedRuntimeHook("buildUnknownModelHint");

type ProviderSyntheticAuthParams = ProviderRuntimeLookup & {
  context: ProviderResolveSyntheticAuthContext;
  modelApi?: string;
};

function* resolveSyntheticAuthProviders(
  params: ProviderSyntheticAuthParams,
): Generator<ProviderPlugin> {
  const providerRefs = resolveProviderHookRefs(
    params.provider,
    params.context.providerConfig,
    params.modelApi,
  );
  const matchesSyntheticAuthProvider = (provider: ProviderPlugin) =>
    matchesAnyProviderPluginRef(provider, providerRefs) &&
    Boolean(provider.resolveSyntheticAuth || provider.prepareSyntheticAuth);
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
  const discover = (onlyPluginIds?: string[]) =>
    resolvePluginDiscoveryProvidersRuntime({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      ...(onlyPluginIds ? { onlyPluginIds } : {}),
      discoveryEntriesOnly: true,
      includeSyntheticAuthProviders: true,
      includeManifestModelCatalogProviders: false,
    }).find(matchesSyntheticAuthProvider);
  const discoveryProvider =
    discoveryPluginIds.length > 0 ? discover(discoveryPluginIds) : undefined;
  if (discoveryProvider) {
    yield discoveryProvider;
    return;
  }
  for (const providerRef of providerRefs) {
    const provider = resolveProviderRuntimePlugin({
      ...params,
      provider: providerRef,
      applyAutoEnable: false,
    });
    if (provider?.resolveSyntheticAuth || provider?.prepareSyntheticAuth) {
      yield provider;
    }
  }
  if (discoveryPluginIds.length === 0 && providerRefs.length === 1) {
    // Last-resort match for custom provider ids with no resolvable owning plugin (e.g. Ollama
    // aliases). Entry modules only: a full plugin-runtime sweep here costs seconds per ref on
    // source checkouts and belongs to explicit control-plane loads.
    const fallbackProvider = discover();
    if (fallbackProvider) {
      yield fallbackProvider;
    }
  }
}

export function resolveProviderSyntheticAuthWithPlugin(params: ProviderSyntheticAuthParams) {
  const captured = readPreparedSyntheticAuthFact(params.context, params);
  if (captured) {
    return captured.result ?? undefined;
  }
  for (const provider of resolveSyntheticAuthProviders(params)) {
    const resolved = resolveSyntheticAuthWithProvider(provider, params.context, params);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

type ProviderSyntheticAuthPreparationParams = ProviderSyntheticAuthParams &
  Parameters<typeof prepareSyntheticAuthWithProvider>[2];

async function prepareSyntheticAuthProviders(
  providers: Iterable<ProviderPlugin>,
  params: ProviderSyntheticAuthPreparationParams,
) {
  params.signal?.throwIfAborted();
  for (const provider of providers) {
    const resolved = await prepareSyntheticAuthWithProvider(provider, params.context, params);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

export async function prepareProviderSyntheticAuthWithPlugin(
  params: ProviderSyntheticAuthPreparationParams,
) {
  params.signal?.throwIfAborted();
  const captured = readPreparedSyntheticAuthFact(params.context, params);
  if (captured) {
    return captured.result ?? undefined;
  }
  return await prepareSyntheticAuthProviders(resolveSyntheticAuthProviders(params), params);
}

function resolveExternalSyntheticAuthProviders(params: ProviderSyntheticAuthParams) {
  const providers = [...resolveSyntheticAuthProviders(params)];
  return providers.some((provider) => provider.prepareSyntheticAuth) ? providers : [];
}

/** Prepare external checks without evaluating pure-only hooks before their synchronous read. */
export async function prepareProviderExternalAuthWithPlugin(
  params: ProviderSyntheticAuthPreparationParams,
) {
  params.signal?.throwIfAborted();
  const captured = readPreparedSyntheticAuthFact(params.context, params);
  return captured
    ? (captured.result ?? undefined)
    : await prepareSyntheticAuthProviders(resolveExternalSyntheticAuthProviders(params), params);
}

/** Capture a fresh, complete external-auth generation before dispatching read-only worker work. */
export async function captureProviderSyntheticAuthFacts(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  providerRefs: Iterable<string>;
  signal?: AbortSignal;
}): Promise<PreparedSyntheticAuthFacts> {
  const preparationOwner = {};
  const facts: PreparedSyntheticAuthFact[] = [];
  const providerRefs = [...new Set([...params.providerRefs].map(normalizeProviderId))].toSorted();
  for (const provider of providerRefs) {
    params.signal?.throwIfAborted();
    const lookup = {
      provider,
      config: params.config,
      env: params.env,
      workspaceDir: params.workspaceDir,
      context: {
        config: params.config,
        provider,
        providerConfig: findNormalizedProviderValue(params.config.models?.providers, provider),
      },
    };
    const providers = resolveExternalSyntheticAuthProviders(lookup);
    if (providers.length === 0) {
      continue;
    }
    const result = await prepareSyntheticAuthProviders(providers, {
      ...lookup,
      signal: params.signal,
      preparationOwner,
    });
    facts.push(
      Object.freeze({
        providerRef: provider,
        result: result ? Object.freeze({ ...result }) : null,
      }),
    );
  }
  params.signal?.throwIfAborted();
  return Object.freeze(facts);
}

export { resolveExternalAuthProfilesWithPlugins } from "./provider-external-auth.js";

export function shouldDeferProviderSyntheticProfileAuthWithPlugin(
  params: ProviderRuntimeLookup & {
    context: ProviderDeferSyntheticProfileAuthContext;
    modelApi?: string;
  },
) {
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

export async function augmentModelCatalogWithProviderPlugins(params: {
  providerIds?: readonly string[];
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
  context: ProviderAugmentModelCatalogContext;
}) {
  const supplemental: ProviderAugmentModelCatalogContext["entries"] = [];
  for (const plugin of resolveProviderPluginsForCatalogHooks(params)) {
    supplemental.push(...((await plugin.augmentModelCatalog?.(params.context)) ?? []));
  }
  return supplemental;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
