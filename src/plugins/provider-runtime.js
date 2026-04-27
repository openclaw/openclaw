import { resolveGpt5SystemPromptContribution } from "../agents/gpt5-prompt-overlay.js";
import { applyPluginTextReplacements, mergePluginTextTransforms, } from "../agents/plugin-text-transforms.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { resolvePluginDiscoveryProvidersRuntime } from "./provider-discovery.runtime.js";
import { __testing as providerHookRuntimeTesting, clearProviderRuntimeHookCache, prepareProviderExtraParams, resetProviderRuntimeHookCacheForTest, resolveProviderAuthProfileId, resolveProviderExtraParamsForTransport, resolveProviderFollowupFallbackRoute, resolveProviderHookPlugin, resolveProviderPluginsForHooks, resolveProviderRuntimePlugin, wrapProviderStreamFn, } from "./provider-hook-runtime.js";
import { resolveBundledProviderPolicySurface } from "./provider-public-artifacts.js";
import { resolveCatalogHookProviderPluginIds, resolveExternalAuthProfileCompatFallbackPluginIds, resolveExternalAuthProfileProviderPluginIds, } from "./providers.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state.js";
import { resolveRuntimeTextTransforms } from "./text-transforms.runtime.js";
const log = createSubsystemLogger("plugins/provider-runtime");
const warnedExternalAuthFallbackPluginIds = new Set();
function resetExternalAuthFallbackWarningCacheForTest() {
    warnedExternalAuthFallbackPluginIds.clear();
}
export { clearProviderRuntimeHookCache, prepareProviderExtraParams, resolveProviderAuthProfileId, resolveProviderExtraParamsForTransport, resolveProviderFollowupFallbackRoute, resetProviderRuntimeHookCacheForTest, resolveProviderRuntimePlugin, wrapProviderStreamFn, };
export const __testing = {
    ...providerHookRuntimeTesting,
    resetExternalAuthFallbackWarningCacheForTest,
};
function resolveProviderPluginsForCatalogHooks(params) {
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
export function runProviderDynamicModel(params) {
    return resolveProviderRuntimePlugin(params)?.resolveDynamicModel?.(params.context) ?? undefined;
}
export function resolveProviderSystemPromptContribution(params) {
    const plugin = resolveProviderRuntimePlugin(params);
    const baseOverlay = resolveGpt5SystemPromptContribution({
        config: params.context.config ?? params.config,
        providerId: params.context.provider ?? params.provider,
        modelId: params.context.modelId,
    });
    const providerOverlay = plugin?.resolvePromptOverlay?.({
        ...params.context,
        baseOverlay,
    }) ?? undefined;
    return mergeProviderSystemPromptContributions(mergeProviderSystemPromptContributions(baseOverlay, providerOverlay), plugin?.resolveSystemPromptContribution?.(params.context) ?? undefined);
}
function mergeProviderSystemPromptContributions(base, override) {
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
function mergeUniquePromptSections(...sections) {
    const uniqueSections = [...new Set(sections.filter((section) => section?.trim()))];
    return uniqueSections.length > 0 ? uniqueSections.join("\n\n") : undefined;
}
export function transformProviderSystemPrompt(params) {
    const plugin = resolveProviderRuntimePlugin(params);
    const textTransforms = mergePluginTextTransforms(resolveRuntimeTextTransforms(), plugin?.textTransforms);
    const transformed = plugin?.transformSystemPrompt?.(params.context) ?? params.context.systemPrompt;
    return applyPluginTextReplacements(transformed, textTransforms?.input);
}
export function resolveProviderTextTransforms(params) {
    return mergePluginTextTransforms(resolveRuntimeTextTransforms(), resolveProviderRuntimePlugin(params)?.textTransforms);
}
export async function prepareProviderDynamicModel(params) {
    await resolveProviderRuntimePlugin(params)?.prepareDynamicModel?.(params.context);
}
export function shouldPreferProviderRuntimeResolvedModel(params) {
    return (resolveProviderRuntimePlugin(params)?.preferRuntimeResolvedModel?.(params.context) ?? false);
}
export function normalizeProviderResolvedModelWithPlugin(params) {
    return (resolveProviderRuntimePlugin(params)?.normalizeResolvedModel?.(params.context) ?? undefined);
}
function resolveProviderCompatHookPlugins(params) {
    const candidates = resolveProviderPluginsForHooks(params);
    const owner = resolveProviderRuntimePlugin(params);
    if (!owner) {
        return candidates;
    }
    const ordered = [owner, ...candidates];
    const seen = new Set();
    return ordered.filter((candidate) => {
        const key = `${candidate.pluginId ?? ""}:${candidate.id}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}
function applyCompatPatchToModel(model, patch) {
    const compat = model.compat && typeof model.compat === "object"
        ? model.compat
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
export function applyProviderResolvedModelCompatWithPlugins(params) {
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
        const patchedModel = applyCompatPatchToModel(nextModel, patch);
        if (patchedModel === nextModel) {
            continue;
        }
        nextModel = patchedModel;
        changed = true;
    }
    return changed ? nextModel : undefined;
}
export function applyProviderResolvedTransportWithPlugin(params) {
    const normalized = normalizeProviderTransportWithPlugin({
        provider: params.provider,
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
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
        api: nextApi,
        baseUrl: nextBaseUrl,
    };
}
export function normalizeProviderModelIdWithPlugin(params) {
    const plugin = resolveProviderHookPlugin(params);
    return normalizeOptionalString(plugin?.normalizeModelId?.(params.context));
}
export function normalizeProviderTransportWithPlugin(params) {
    const hasTransportChange = (normalized) => (normalized.api ?? params.context.api) !== params.context.api ||
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
export function normalizeProviderConfigWithPlugin(params) {
    const hasConfigChange = (normalized) => normalized !== params.context.providerConfig;
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
export function applyProviderNativeStreamingUsageCompatWithPlugin(params) {
    return (resolveProviderHookPlugin(params)?.applyNativeStreamingUsageCompat?.(params.context) ??
        undefined);
}
export function resolveProviderConfigApiKeyWithPlugin(params) {
    const bundledSurface = resolveBundledProviderPolicySurface(params.provider);
    if (bundledSurface?.resolveConfigApiKey) {
        return normalizeOptionalString(bundledSurface.resolveConfigApiKey(params.context));
    }
    return normalizeOptionalString(resolveProviderHookPlugin(params)?.resolveConfigApiKey?.(params.context));
}
export function resolveProviderReplayPolicyWithPlugin(params) {
    return resolveProviderHookPlugin(params)?.buildReplayPolicy?.(params.context) ?? undefined;
}
export async function sanitizeProviderReplayHistoryWithPlugin(params) {
    return await resolveProviderHookPlugin(params)?.sanitizeReplayHistory?.(params.context);
}
export async function validateProviderReplayTurnsWithPlugin(params) {
    return await resolveProviderHookPlugin(params)?.validateReplayTurns?.(params.context);
}
export function normalizeProviderToolSchemasWithPlugin(params) {
    return resolveProviderHookPlugin(params)?.normalizeToolSchemas?.(params.context) ?? undefined;
}
export function inspectProviderToolSchemasWithPlugin(params) {
    return resolveProviderHookPlugin(params)?.inspectToolSchemas?.(params.context) ?? undefined;
}
export function resolveProviderReasoningOutputModeWithPlugin(params) {
    const mode = resolveProviderHookPlugin(params)?.resolveReasoningOutputMode?.(params.context);
    return mode === "native" || mode === "tagged" ? mode : undefined;
}
export function resolveProviderStreamFn(params) {
    return resolveProviderRuntimePlugin(params)?.createStreamFn?.(params.context) ?? undefined;
}
export function resolveProviderTransportTurnStateWithPlugin(params) {
    return (resolveProviderHookPlugin(params)?.resolveTransportTurnState?.(params.context) ?? undefined);
}
export function resolveProviderWebSocketSessionPolicyWithPlugin(params) {
    return (resolveProviderHookPlugin(params)?.resolveWebSocketSessionPolicy?.(params.context) ?? undefined);
}
export async function createProviderEmbeddingProvider(params) {
    return await resolveProviderRuntimePlugin(params)?.createEmbeddingProvider?.(params.context);
}
export async function prepareProviderRuntimeAuth(params) {
    return await resolveProviderRuntimePlugin(params)?.prepareRuntimeAuth?.(params.context);
}
export async function resolveProviderUsageAuthWithPlugin(params) {
    return await resolveProviderRuntimePlugin(params)?.resolveUsageAuth?.(params.context);
}
export async function resolveProviderUsageSnapshotWithPlugin(params) {
    return await resolveProviderRuntimePlugin(params)?.fetchUsageSnapshot?.(params.context);
}
export function matchesProviderContextOverflowWithPlugin(params) {
    const plugins = params.provider
        ? [resolveProviderHookPlugin({ ...params, provider: params.provider })].filter((plugin) => Boolean(plugin))
        : resolveProviderPluginsForHooks(params);
    for (const plugin of plugins) {
        if (plugin.matchesContextOverflowError?.(params.context)) {
            return true;
        }
    }
    return false;
}
export function classifyProviderFailoverReasonWithPlugin(params) {
    const plugins = params.provider
        ? [resolveProviderHookPlugin({ ...params, provider: params.provider })].filter((plugin) => Boolean(plugin))
        : resolveProviderPluginsForHooks(params);
    for (const plugin of plugins) {
        const reason = plugin.classifyFailoverReason?.(params.context);
        if (reason) {
            return reason;
        }
    }
    return undefined;
}
export function formatProviderAuthProfileApiKeyWithPlugin(params) {
    return resolveProviderRuntimePlugin(params)?.formatApiKey?.(params.context);
}
export async function refreshProviderOAuthCredentialWithPlugin(params) {
    return await resolveProviderRuntimePlugin(params)?.refreshOAuth?.(params.context);
}
export async function buildProviderAuthDoctorHintWithPlugin(params) {
    return await resolveProviderRuntimePlugin(params)?.buildAuthDoctorHint?.(params.context);
}
export function resolveProviderCacheTtlEligibility(params) {
    return resolveProviderRuntimePlugin(params)?.isCacheTtlEligible?.(params.context);
}
export function resolveProviderBinaryThinking(params) {
    return resolveProviderRuntimePlugin(params)?.isBinaryThinking?.(params.context);
}
export function resolveProviderXHighThinking(params) {
    return resolveProviderRuntimePlugin(params)?.supportsXHighThinking?.(params.context);
}
export function resolveProviderThinkingProfile(params) {
    return resolveProviderRuntimePlugin(params)?.resolveThinkingProfile?.(params.context);
}
export function resolveProviderDefaultThinkingLevel(params) {
    return resolveProviderRuntimePlugin(params)?.resolveDefaultThinkingLevel?.(params.context);
}
export function applyProviderConfigDefaultsWithPlugin(params) {
    const bundledSurface = resolveBundledProviderPolicySurface(params.provider);
    if (bundledSurface?.applyConfigDefaults) {
        return bundledSurface.applyConfigDefaults(params.context) ?? undefined;
    }
    return resolveProviderRuntimePlugin(params)?.applyConfigDefaults?.(params.context) ?? undefined;
}
export function resolveProviderModernModelRef(params) {
    return resolveProviderRuntimePlugin(params)?.isModernModelRef?.(params.context);
}
export function buildProviderMissingAuthMessageWithPlugin(params) {
    return (resolveProviderRuntimePlugin(params)?.buildMissingAuthMessage?.(params.context) ?? undefined);
}
export function buildProviderUnknownModelHintWithPlugin(params) {
    return resolveProviderRuntimePlugin(params)?.buildUnknownModelHint?.(params.context) ?? undefined;
}
export function resolveProviderSyntheticAuthWithPlugin(params) {
    const runtimeResolved = resolveProviderRuntimePlugin(params)?.resolveSyntheticAuth?.(params.context);
    if (runtimeResolved) {
        return runtimeResolved;
    }
    return resolvePluginDiscoveryProvidersRuntime({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
    })
        .find((provider) => provider.id === params.provider)
        ?.resolveSyntheticAuth?.(params.context);
}
export function resolveExternalAuthProfilesWithPlugins(params) {
    const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
    const env = params.env ?? process.env;
    const externalAuthPluginIds = resolveExternalAuthProfileProviderPluginIds({
        config: params.config,
        workspaceDir,
        env,
    });
    const declaredPluginIds = new Set(externalAuthPluginIds);
    const fallbackPluginIds = resolveExternalAuthProfileCompatFallbackPluginIds({
        config: params.config,
        workspaceDir,
        env,
        declaredPluginIds,
    });
    const pluginIds = [...new Set([...externalAuthPluginIds, ...fallbackPluginIds])].toSorted((left, right) => left.localeCompare(right));
    if (pluginIds.length === 0) {
        return [];
    }
    const matches = [];
    for (const plugin of resolveProviderPluginsForHooks({
        ...params,
        workspaceDir,
        env,
        onlyPluginIds: pluginIds,
    })) {
        const profiles = plugin.resolveExternalAuthProfiles?.(params.context) ??
            plugin.resolveExternalOAuthProfiles?.(params.context);
        if (!profiles || profiles.length === 0) {
            continue;
        }
        const pluginId = plugin.pluginId ?? plugin.id;
        if (!declaredPluginIds.has(pluginId) && !warnedExternalAuthFallbackPluginIds.has(pluginId)) {
            warnedExternalAuthFallbackPluginIds.add(pluginId);
            // Deprecated compatibility path for plugins that still implement
            // resolveExternalOAuthProfiles or omit contracts.externalAuthProviders.
            // Remove this warning with the fallback resolver after the migration window.
            log.warn(`Provider plugin "${sanitizeForLog(pluginId)}" uses external auth hooks without declaring contracts.externalAuthProviders. This compatibility fallback is deprecated and will be removed in a future release.`);
        }
        matches.push(...profiles);
    }
    return matches;
}
export function resolveExternalOAuthProfilesWithPlugins(params) {
    return resolveExternalAuthProfilesWithPlugins(params);
}
export function shouldDeferProviderSyntheticProfileAuthWithPlugin(params) {
    return (resolveProviderRuntimePlugin(params)?.shouldDeferSyntheticProfileAuth?.(params.context) ??
        undefined);
}
export function resolveProviderBuiltInModelSuppression(params) {
    for (const plugin of resolveProviderPluginsForCatalogHooks(params)) {
        const result = plugin.suppressBuiltInModel?.(params.context);
        if (result?.suppress) {
            return result;
        }
    }
    return undefined;
}
export async function augmentModelCatalogWithProviderPlugins(params) {
    const supplemental = [];
    for (const plugin of resolveProviderPluginsForCatalogHooks(params)) {
        const next = await plugin.augmentModelCatalog?.(params.context);
        if (!next || next.length === 0) {
            continue;
        }
        supplemental.push(...next);
    }
    return supplemental;
}
