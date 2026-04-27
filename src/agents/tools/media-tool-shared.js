import { getDefaultLocalRoots } from "../../media/web-media.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import { normalizeOptionalLowercaseString, normalizeOptionalString, } from "../../shared/string-coerce.js";
import { normalizeModelRef } from "../model-selection.js";
import { normalizeProviderId } from "../provider-id.js";
import { ToolInputError, readNumberParam, readStringArrayParam, readStringParam, } from "./common.js";
import { buildToolModelConfigFromCandidates, coerceToolModelConfig, hasAuthForProvider, hasToolModelConfig, resolveDefaultModelRef, } from "./model-config.helpers.js";
import { getApiKeyForModel, normalizeWorkspaceDir, requireApiKey } from "./tool-runtime.helpers.js";
export function applyImageModelConfigDefaults(cfg, imageModelConfig) {
    return applyAgentDefaultModelConfig(cfg, "imageModel", imageModelConfig);
}
export function applyImageGenerationModelConfigDefaults(cfg, imageGenerationModelConfig) {
    return applyAgentDefaultModelConfig(cfg, "imageGenerationModel", imageGenerationModelConfig);
}
export function applyVideoGenerationModelConfigDefaults(cfg, videoGenerationModelConfig) {
    return applyAgentDefaultModelConfig(cfg, "videoGenerationModel", videoGenerationModelConfig);
}
export function applyMusicGenerationModelConfigDefaults(cfg, musicGenerationModelConfig) {
    return applyAgentDefaultModelConfig(cfg, "musicGenerationModel", musicGenerationModelConfig);
}
export function readGenerationTimeoutMs(args) {
    const timeoutMs = readNumberParam(args, "timeoutMs", {
        integer: true,
        strict: true,
    });
    if (timeoutMs === undefined) {
        return undefined;
    }
    if (timeoutMs <= 0) {
        throw new ToolInputError("timeoutMs must be a positive integer in milliseconds.");
    }
    return timeoutMs;
}
export function resolveRemoteMediaSsrfPolicy(cfg) {
    return cfg?.tools?.web?.fetch?.ssrfPolicy;
}
function applyAgentDefaultModelConfig(cfg, key, modelConfig) {
    if (!cfg) {
        return undefined;
    }
    return {
        ...cfg,
        agents: {
            ...cfg.agents,
            defaults: {
                ...cfg.agents?.defaults,
                [key]: modelConfig,
            },
        },
    };
}
export function findCapabilityProviderById(params) {
    const selectedProvider = normalizeProviderId(params.providerId ?? "");
    return params.providers.find((provider) => normalizeProviderId(provider.id) === selectedProvider ||
        (provider.aliases ?? []).some((alias) => normalizeProviderId(alias) === selectedProvider));
}
export function isCapabilityProviderConfigured(params) {
    const provider = params.provider ??
        findCapabilityProviderById({
            providers: params.providers,
            providerId: params.providerId,
        });
    if (!provider) {
        return params.providerId
            ? hasAuthForProvider({ provider: params.providerId, agentDir: params.agentDir })
            : false;
    }
    if (provider.isConfigured) {
        return provider.isConfigured({
            cfg: params.cfg,
            agentDir: params.agentDir,
        });
    }
    return hasAuthForProvider({ provider: provider.id, agentDir: params.agentDir });
}
export function resolveSelectedCapabilityProvider(params) {
    const selectedRef = params.parseModelRef(params.modelOverride) ?? params.parseModelRef(params.modelConfig.primary);
    if (!selectedRef) {
        return undefined;
    }
    return findCapabilityProviderById({
        providers: params.providers,
        providerId: selectedRef.provider,
    });
}
export function resolveCapabilityModelCandidatesForTool(params) {
    const providerDefaults = new Map();
    for (const provider of params.providers) {
        const providerId = provider.id.trim();
        const modelId = provider.defaultModel?.trim();
        if (!providerId ||
            !modelId ||
            providerDefaults.has(providerId) ||
            !isCapabilityProviderConfigured({
                providers: params.providers,
                provider,
                cfg: params.cfg,
                agentDir: params.agentDir,
            })) {
            continue;
        }
        providerDefaults.set(providerId, `${providerId}/${modelId}`);
    }
    const primaryProvider = resolveDefaultModelRef(params.cfg).provider;
    const orderedProviders = [
        primaryProvider,
        ...[...providerDefaults.keys()]
            .filter((providerId) => providerId !== primaryProvider)
            .toSorted(),
    ];
    const orderedRefs = [];
    const seen = new Set();
    for (const providerId of orderedProviders) {
        const ref = providerDefaults.get(providerId);
        if (!ref || seen.has(ref)) {
            continue;
        }
        seen.add(ref);
        orderedRefs.push(ref);
    }
    return orderedRefs;
}
export function resolveCapabilityModelConfigForTool(params) {
    const explicit = coerceToolModelConfig(params.modelConfig);
    if (hasToolModelConfig(explicit)) {
        return explicit;
    }
    return buildToolModelConfigFromCandidates({
        explicit,
        agentDir: params.agentDir,
        candidates: resolveCapabilityModelCandidatesForTool({
            cfg: params.cfg,
            agentDir: params.agentDir,
            providers: params.providers,
        }),
        isProviderConfigured: (providerId) => isCapabilityProviderConfigured({
            providers: params.providers,
            providerId,
            cfg: params.cfg,
            agentDir: params.agentDir,
        }),
    });
}
function formatQuotedList(values) {
    if (values.length === 1) {
        return `"${values[0]}"`;
    }
    if (values.length === 2) {
        return `"${values[0]}" or "${values[1]}"`;
    }
    return `${values
        .slice(0, -1)
        .map((value) => `"${value}"`)
        .join(", ")}, or "${values[values.length - 1]}"`;
}
export function resolveGenerateAction(params) {
    const raw = readStringParam(params.args, "action");
    if (!raw) {
        return params.defaultAction;
    }
    const normalized = normalizeOptionalLowercaseString(raw);
    if (normalized && params.allowed.includes(normalized)) {
        return normalized;
    }
    throw new ToolInputError(`action must be ${formatQuotedList(params.allowed)}`);
}
export function readBooleanToolParam(params, key) {
    const raw = readSnakeCaseParamRaw(params, key);
    if (typeof raw === "boolean") {
        return raw;
    }
    if (typeof raw === "string") {
        const normalized = normalizeOptionalLowercaseString(raw);
        if (normalized === "true") {
            return true;
        }
        if (normalized === "false") {
            return false;
        }
    }
    return undefined;
}
export function normalizeMediaReferenceInputs(params) {
    const single = readStringParam(params.args, params.singularKey);
    const multiple = readStringArrayParam(params.args, params.pluralKey);
    const combined = [...(single ? [single] : []), ...(multiple ?? [])];
    const deduped = [];
    const seen = new Set();
    for (const candidate of combined) {
        const trimmed = candidate.trim();
        const dedupe = trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
        if (!dedupe || seen.has(dedupe)) {
            continue;
        }
        seen.add(dedupe);
        deduped.push(trimmed);
    }
    if (deduped.length > params.maxCount) {
        throw new ToolInputError(`Too many ${params.label}: ${deduped.length} provided, maximum is ${params.maxCount}.`);
    }
    return deduped;
}
export function buildMediaReferenceDetails(params) {
    if (params.entries.length === 1) {
        const entry = params.entries[0];
        if (!entry) {
            return {};
        }
        const rewriteKey = params.singleRewriteKey ?? "rewrittenFrom";
        return {
            [params.singleKey]: params.getResolvedInput(entry),
            ...(entry.rewrittenFrom ? { [rewriteKey]: entry.rewrittenFrom } : {}),
        };
    }
    if (params.entries.length > 1) {
        return {
            [params.pluralKey]: params.entries.map((entry) => ({
                [params.singleKey]: params.getResolvedInput(entry),
                ...(entry.rewrittenFrom ? { rewrittenFrom: entry.rewrittenFrom } : {}),
            })),
        };
    }
    return {};
}
export function buildTaskRunDetails(handle) {
    return handle
        ? {
            task: {
                taskId: handle.taskId,
                runId: handle.runId,
            },
        }
        : {};
}
export function resolveMediaToolLocalRoots(workspaceDirRaw, options, _mediaSources) {
    const workspaceDir = normalizeWorkspaceDir(workspaceDirRaw);
    if (options?.workspaceOnly) {
        return workspaceDir ? [workspaceDir] : [];
    }
    const roots = getDefaultLocalRoots();
    return workspaceDir ? Array.from(new Set([...roots, workspaceDir])) : [...roots];
}
export function resolvePromptAndModelOverride(args, defaultPrompt) {
    const prompt = normalizeOptionalString(args.prompt) ?? defaultPrompt;
    const modelOverride = normalizeOptionalString(args.model);
    return { prompt, modelOverride };
}
export function buildTextToolResult(result, extraDetails) {
    return {
        content: [{ type: "text", text: result.text }],
        details: {
            model: `${result.provider}/${result.model}`,
            ...extraDetails,
            attempts: result.attempts,
        },
    };
}
export function resolveModelFromRegistry(params) {
    const resolvedRef = normalizeModelRef(params.provider, params.modelId);
    let model = params.modelRegistry.find(resolvedRef.provider, resolvedRef.model);
    if (!model && !resolvedRef.model.includes("/")) {
        model = params.modelRegistry.find(resolvedRef.provider, `${resolvedRef.provider}/${resolvedRef.model}`);
    }
    if (!model) {
        throw new Error(`Unknown model: ${resolvedRef.provider}/${resolvedRef.model}`);
    }
    return model;
}
export async function resolveModelRuntimeApiKey(params) {
    const apiKeyInfo = await getApiKeyForModel({
        model: params.model,
        cfg: params.cfg,
        agentDir: params.agentDir,
    });
    const apiKey = requireApiKey(apiKeyInfo, params.model.provider);
    params.authStorage.setRuntimeApiKey(params.model.provider, apiKey);
    return apiKey;
}
