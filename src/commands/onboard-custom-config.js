import { CONTEXT_WINDOW_HARD_MIN_TOKENS } from "../agents/context-window-guard.js";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { buildModelAliasIndex, modelKey } from "../agents/model-selection.js";
import { isSecretRef } from "../config/types.secrets.js";
import { applyPrimaryModel } from "../plugins/provider-model-primary.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalLowercaseString, normalizeOptionalString, } from "../shared/string-coerce.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import { normalizeAlias } from "./models/alias-name.js";
const DEFAULT_CONTEXT_WINDOW = CONTEXT_WINDOW_HARD_MIN_TOKENS;
const DEFAULT_MAX_TOKENS = 4096;
// Azure OpenAI uses the Responses API which supports larger defaults
const AZURE_DEFAULT_CONTEXT_WINDOW = 400_000;
const AZURE_DEFAULT_MAX_TOKENS = 16_384;
function normalizeContextWindowForCustomModel(value) {
    const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
    return parsed >= CONTEXT_WINDOW_HARD_MIN_TOKENS ? parsed : CONTEXT_WINDOW_HARD_MIN_TOKENS;
}
function isAzureFoundryUrl(baseUrl) {
    try {
        const url = new URL(baseUrl);
        const host = normalizeLowercaseStringOrEmpty(url.hostname);
        return host.endsWith(".services.ai.azure.com");
    }
    catch {
        return false;
    }
}
function isAzureOpenAiUrl(baseUrl) {
    try {
        const url = new URL(baseUrl);
        const host = normalizeLowercaseStringOrEmpty(url.hostname);
        return host.endsWith(".openai.azure.com");
    }
    catch {
        return false;
    }
}
function isAzureUrl(baseUrl) {
    return isAzureFoundryUrl(baseUrl) || isAzureOpenAiUrl(baseUrl);
}
/**
 * Transforms an Azure AI Foundry/OpenAI URL to include the deployment path.
 * Azure requires: https://host/openai/deployments/<model-id>/chat/completions?api-version=2024-xx-xx-preview
 * But we can't add query params here, so we just add the path prefix.
 * The api-version will be handled by the Azure OpenAI client or as a query param.
 *
 * Example:
 *   https://my-resource.services.ai.azure.com + gpt-5.4-nano
 *   => https://my-resource.services.ai.azure.com/openai/deployments/gpt-5.4-nano
 */
function transformAzureUrl(baseUrl, modelId) {
    const normalizedUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    // Check if the URL already includes the deployment path
    if (normalizedUrl.includes("/openai/deployments/")) {
        return normalizedUrl;
    }
    return `${normalizedUrl}/openai/deployments/${modelId}`;
}
/**
 * Transforms an Azure URL into the base URL stored in config.
 *
 * Example:
 *   https://my-resource.openai.azure.com
 *   => https://my-resource.openai.azure.com/openai/v1
 */
function transformAzureConfigUrl(baseUrl) {
    const normalizedUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    if (normalizedUrl.endsWith("/openai/v1")) {
        return normalizedUrl;
    }
    // Strip a full deployment path back to the base origin
    const deploymentIdx = normalizedUrl.indexOf("/openai/deployments/");
    const base = deploymentIdx !== -1 ? normalizedUrl.slice(0, deploymentIdx) : normalizedUrl;
    return `${base}/openai/v1`;
}
function hasSameHost(a, b) {
    try {
        return (normalizeLowercaseStringOrEmpty(new URL(a).hostname) ===
            normalizeLowercaseStringOrEmpty(new URL(b).hostname));
    }
    catch {
        return false;
    }
}
export class CustomApiError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "CustomApiError";
        this.code = code;
    }
}
export function normalizeEndpointId(raw) {
    const trimmed = normalizeOptionalLowercaseString(raw);
    if (!trimmed) {
        return "";
    }
    return trimmed.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}
export function buildEndpointIdFromUrl(baseUrl) {
    try {
        const url = new URL(baseUrl);
        const host = normalizeLowercaseStringOrEmpty(url.hostname.replace(/[^a-z0-9]+/gi, "-"));
        const port = url.port ? `-${url.port}` : "";
        const candidate = `custom-${host}${port}`;
        return normalizeEndpointId(candidate) || "custom";
    }
    catch {
        return "custom";
    }
}
function resolveUniqueEndpointId(params) {
    const normalized = normalizeEndpointId(params.requestedId) || "custom";
    const existing = params.providers[normalized];
    if (!existing?.baseUrl ||
        existing.baseUrl === params.baseUrl ||
        (isAzureUrl(params.baseUrl) && hasSameHost(existing.baseUrl, params.baseUrl))) {
        return { providerId: normalized, renamed: false };
    }
    let suffix = 2;
    let candidate = `${normalized}-${suffix}`;
    while (params.providers[candidate]) {
        suffix += 1;
        candidate = `${normalized}-${suffix}`;
    }
    return { providerId: candidate, renamed: true };
}
export function resolveCustomModelAliasError(params) {
    const trimmed = params.raw.trim();
    if (!trimmed) {
        return undefined;
    }
    let normalized;
    try {
        normalized = normalizeAlias(trimmed);
    }
    catch (err) {
        return err instanceof Error ? err.message : "Alias is invalid.";
    }
    const aliasIndex = buildModelAliasIndex({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
    });
    const aliasKey = normalizeLowercaseStringOrEmpty(normalized);
    const existing = aliasIndex.byAlias.get(aliasKey);
    if (!existing) {
        return undefined;
    }
    const existingKey = modelKey(existing.ref.provider, existing.ref.model);
    if (existingKey === params.modelRef) {
        return undefined;
    }
    return `Alias ${normalized} already points to ${existingKey}.`;
}
function buildAzureOpenAiHeaders(apiKey) {
    const headers = {};
    if (apiKey) {
        headers["api-key"] = apiKey;
    }
    return headers;
}
function buildOpenAiHeaders(apiKey) {
    const headers = {};
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }
    return headers;
}
function buildAnthropicHeaders(apiKey) {
    const headers = {
        "anthropic-version": "2023-06-01",
    };
    if (apiKey) {
        headers["x-api-key"] = apiKey;
    }
    return headers;
}
export function normalizeOptionalProviderApiKey(value) {
    if (isSecretRef(value)) {
        return value;
    }
    return normalizeOptionalSecretInput(value);
}
function resolveVerificationEndpoint(params) {
    const resolvedUrl = isAzureUrl(params.baseUrl)
        ? transformAzureUrl(params.baseUrl, params.modelId)
        : params.baseUrl;
    const endpointUrl = new URL(params.endpointPath, resolvedUrl.endsWith("/") ? resolvedUrl : `${resolvedUrl}/`);
    if (isAzureUrl(params.baseUrl)) {
        endpointUrl.searchParams.set("api-version", "2024-10-21");
    }
    return endpointUrl.href;
}
export function buildOpenAiVerificationProbeRequest(params) {
    const isBaseUrlAzureUrl = isAzureUrl(params.baseUrl);
    const headers = isBaseUrlAzureUrl
        ? buildAzureOpenAiHeaders(params.apiKey)
        : buildOpenAiHeaders(params.apiKey);
    if (isAzureOpenAiUrl(params.baseUrl)) {
        const endpoint = new URL("responses", transformAzureConfigUrl(params.baseUrl).replace(/\/?$/, "/")).href;
        return {
            endpoint,
            headers,
            body: {
                model: params.modelId,
                input: "Hi",
                max_output_tokens: 16,
                stream: false,
            },
        };
    }
    const endpoint = resolveVerificationEndpoint({
        baseUrl: params.baseUrl,
        modelId: params.modelId,
        endpointPath: "chat/completions",
    });
    return {
        endpoint,
        headers,
        body: {
            model: params.modelId,
            messages: [{ role: "user", content: "Hi" }],
            // Recent OpenAI-family endpoints reject probes below 16 tokens.
            max_tokens: 16,
            stream: false,
        },
    };
}
export function buildAnthropicVerificationProbeRequest(params) {
    // Use a base URL with /v1 injected for this raw fetch only. The rest of the app uses the
    // Anthropic client, which appends /v1 itself; config should store the base URL
    // without /v1 to avoid /v1/v1/messages at runtime. See docs/gateway/configuration-reference.md.
    const baseUrlForRequest = /\/v1\/?$/.test(params.baseUrl.trim())
        ? params.baseUrl.trim()
        : params.baseUrl.trim().replace(/\/?$/, "") + "/v1";
    const endpoint = resolveVerificationEndpoint({
        baseUrl: baseUrlForRequest,
        modelId: params.modelId,
        endpointPath: "messages",
    });
    return {
        endpoint,
        headers: buildAnthropicHeaders(params.apiKey),
        body: {
            model: params.modelId,
            max_tokens: 1,
            messages: [{ role: "user", content: "Hi" }],
            stream: false,
        },
    };
}
function resolveProviderApi(compatibility) {
    return compatibility === "anthropic" ? "anthropic-messages" : "openai-completions";
}
function parseCustomApiCompatibility(raw) {
    const compatibilityRaw = normalizeOptionalLowercaseString(raw);
    if (!compatibilityRaw) {
        return "openai";
    }
    if (compatibilityRaw !== "openai" && compatibilityRaw !== "anthropic") {
        throw new CustomApiError("invalid_compatibility", 'Invalid --custom-compatibility (use "openai" or "anthropic").');
    }
    return compatibilityRaw;
}
export function resolveCustomProviderId(params) {
    const providers = params.config.models?.providers ?? {};
    const baseUrl = params.baseUrl.trim();
    const explicitProviderId = params.providerId?.trim();
    if (explicitProviderId && !normalizeEndpointId(explicitProviderId)) {
        throw new CustomApiError("invalid_provider_id", "Custom provider ID must include letters, numbers, or hyphens.");
    }
    const requestedProviderId = explicitProviderId || buildEndpointIdFromUrl(baseUrl);
    const providerIdResult = resolveUniqueEndpointId({
        requestedId: requestedProviderId,
        baseUrl,
        providers,
    });
    return {
        providerId: providerIdResult.providerId,
        ...(providerIdResult.renamed
            ? {
                providerIdRenamedFrom: normalizeEndpointId(requestedProviderId) || "custom",
            }
            : {}),
    };
}
export function parseNonInteractiveCustomApiFlags(params) {
    const baseUrl = normalizeOptionalString(params.baseUrl) ?? "";
    const modelId = normalizeOptionalString(params.modelId) ?? "";
    if (!baseUrl || !modelId) {
        throw new CustomApiError("missing_required", [
            'Auth choice "custom-api-key" requires a base URL and model ID.',
            "Use --custom-base-url and --custom-model-id.",
        ].join("\n"));
    }
    const apiKey = normalizeOptionalString(params.apiKey);
    const providerId = normalizeOptionalString(params.providerId);
    if (providerId && !normalizeEndpointId(providerId)) {
        throw new CustomApiError("invalid_provider_id", "Custom provider ID must include letters, numbers, or hyphens.");
    }
    return {
        baseUrl,
        modelId,
        compatibility: parseCustomApiCompatibility(params.compatibility),
        ...(apiKey ? { apiKey } : {}),
        ...(providerId ? { providerId } : {}),
    };
}
export function applyCustomApiConfig(params) {
    const baseUrl = normalizeOptionalString(params.baseUrl) ?? "";
    if (!URL.canParse(baseUrl)) {
        throw new CustomApiError("invalid_base_url", "Custom provider base URL must be a valid URL.");
    }
    if (params.compatibility !== "openai" && params.compatibility !== "anthropic") {
        throw new CustomApiError("invalid_compatibility", 'Custom provider compatibility must be "openai" or "anthropic".');
    }
    const modelId = normalizeOptionalString(params.modelId) ?? "";
    if (!modelId) {
        throw new CustomApiError("invalid_model_id", "Custom provider model ID is required.");
    }
    const isAzure = isAzureUrl(baseUrl);
    const isAzureOpenAi = isAzureOpenAiUrl(baseUrl);
    const resolvedBaseUrl = isAzure ? transformAzureConfigUrl(baseUrl) : baseUrl;
    const providerIdResult = resolveCustomProviderId({
        config: params.config,
        baseUrl: resolvedBaseUrl,
        providerId: params.providerId,
    });
    const providerId = providerIdResult.providerId;
    const providers = params.config.models?.providers ?? {};
    const modelRef = modelKey(providerId, modelId);
    const alias = normalizeOptionalString(params.alias) ?? "";
    const aliasError = resolveCustomModelAliasError({
        raw: alias,
        cfg: params.config,
        modelRef,
    });
    if (aliasError) {
        throw new CustomApiError("invalid_alias", aliasError);
    }
    const existingProvider = providers[providerId];
    const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
    const hasModel = existingModels.some((model) => model.id === modelId);
    const isLikelyReasoningModel = isAzure && /\b(o[134]|gpt-([5-9]|\d{2,}))\b/i.test(modelId);
    const nextModel = isAzure
        ? {
            id: modelId,
            name: `${modelId} (Custom Provider)`,
            contextWindow: AZURE_DEFAULT_CONTEXT_WINDOW,
            maxTokens: AZURE_DEFAULT_MAX_TOKENS,
            input: isLikelyReasoningModel
                ? ["text", "image"]
                : ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            reasoning: isLikelyReasoningModel,
            compat: { supportsStore: false },
        }
        : {
            id: modelId,
            name: `${modelId} (Custom Provider)`,
            contextWindow: DEFAULT_CONTEXT_WINDOW,
            maxTokens: DEFAULT_MAX_TOKENS,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            reasoning: false,
        };
    const mergedModels = hasModel
        ? existingModels.map((model) => model.id === modelId
            ? {
                ...model,
                ...(isAzure ? nextModel : {}),
                name: model.name ?? nextModel.name,
                cost: model.cost ?? nextModel.cost,
                contextWindow: normalizeContextWindowForCustomModel(model.contextWindow),
                maxTokens: model.maxTokens ?? nextModel.maxTokens,
            }
            : model)
        : [...existingModels, nextModel];
    const { apiKey: existingApiKey, ...existingProviderRest } = existingProvider ?? {};
    const normalizedApiKey = normalizeOptionalProviderApiKey(params.apiKey) ??
        normalizeOptionalProviderApiKey(existingApiKey);
    const providerApi = isAzureOpenAi
        ? "azure-openai-responses"
        : resolveProviderApi(params.compatibility);
    const azureHeaders = isAzure && normalizedApiKey ? { "api-key": normalizedApiKey } : undefined;
    let config = {
        ...params.config,
        models: {
            ...params.config.models,
            mode: params.config.models?.mode ?? "merge",
            providers: {
                ...providers,
                [providerId]: {
                    ...existingProviderRest,
                    baseUrl: resolvedBaseUrl,
                    api: providerApi,
                    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
                    ...(isAzure ? { authHeader: false } : {}),
                    ...(azureHeaders ? { headers: azureHeaders } : {}),
                    models: mergedModels.length > 0 ? mergedModels : [nextModel],
                },
            },
        },
    };
    config = applyPrimaryModel(config, modelRef);
    if (isAzure && isLikelyReasoningModel) {
        const existingPerModelThinking = config.agents?.defaults?.models?.[modelRef]?.params?.thinking;
        if (!existingPerModelThinking) {
            config = {
                ...config,
                agents: {
                    ...config.agents,
                    defaults: {
                        ...config.agents?.defaults,
                        models: {
                            ...config.agents?.defaults?.models,
                            [modelRef]: {
                                ...config.agents?.defaults?.models?.[modelRef],
                                params: {
                                    ...config.agents?.defaults?.models?.[modelRef]?.params,
                                    thinking: "medium",
                                },
                            },
                        },
                    },
                },
            };
        }
    }
    if (alias) {
        config = {
            ...config,
            agents: {
                ...config.agents,
                defaults: {
                    ...config.agents?.defaults,
                    models: {
                        ...config.agents?.defaults?.models,
                        [modelRef]: {
                            ...config.agents?.defaults?.models?.[modelRef],
                            alias,
                        },
                    },
                },
            },
        };
    }
    return {
        config,
        providerId,
        modelId,
        ...(providerIdResult.providerIdRenamedFrom
            ? { providerIdRenamedFrom: providerIdResult.providerIdRenamedFrom }
            : {}),
    };
}
