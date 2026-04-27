import { complete } from "@mariozechner/pi-ai";
import { isMinimaxVlmModel, minimaxUnderstandImage } from "../agents/minimax-vlm.js";
import { getApiKeyForModel, requireApiKey, resolveApiKeyForProvider, } from "../agents/model-auth.js";
import { normalizeModelRef } from "../agents/model-selection.js";
import { ensureOpenClawModelsJson } from "../agents/models-config.js";
import { resolveProviderRequestCapabilities } from "../agents/provider-attribution.js";
import { registerProviderStreamForModel } from "../agents/provider-stream.js";
import { coerceImageAssistantText, hasImageReasoningOnlyResponse, } from "../agents/tools/image-tool.helpers.js";
let piModelDiscoveryRuntimePromise = null;
function loadPiModelDiscoveryRuntime() {
    piModelDiscoveryRuntimePromise ??= import("../agents/pi-model-discovery-runtime.js");
    return piModelDiscoveryRuntimePromise;
}
function resolveImageToolMaxTokens(modelMaxTokens, requestedMaxTokens = 4096) {
    if (typeof modelMaxTokens !== "number" ||
        !Number.isFinite(modelMaxTokens) ||
        modelMaxTokens <= 0) {
        return requestedMaxTokens;
    }
    return Math.min(requestedMaxTokens, modelMaxTokens);
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isNativeResponsesReasoningPayload(model) {
    if (model.api !== "openai-responses" &&
        model.api !== "azure-openai-responses" &&
        model.api !== "openai-codex-responses") {
        return false;
    }
    return resolveProviderRequestCapabilities({
        provider: model.provider,
        api: model.api,
        baseUrl: model.baseUrl,
        capability: "image",
        transport: "media-understanding",
    }).usesKnownNativeOpenAIRoute;
}
function removeReasoningInclude(value) {
    if (!Array.isArray(value)) {
        return value;
    }
    const next = value.filter((entry) => entry !== "reasoning.encrypted_content");
    return next.length > 0 ? next : undefined;
}
function disableReasoningForImageRetryPayload(payload, model) {
    if (!isRecord(payload)) {
        return undefined;
    }
    const next = { ...payload };
    delete next.reasoning;
    delete next.reasoning_effort;
    const include = removeReasoningInclude(next.include);
    if (include === undefined) {
        delete next.include;
    }
    else {
        next.include = include;
    }
    if (isNativeResponsesReasoningPayload(model)) {
        next.reasoning = { effort: "none" };
    }
    return next;
}
function isImageModelNoTextError(err) {
    return err instanceof Error && /^Image model returned no text\b/.test(err.message);
}
function isPromiseLike(value) {
    return Boolean(value) && typeof value.then === "function";
}
function composeImageDescriptionPayloadHandlers(first, second) {
    if (!first) {
        return second;
    }
    if (!second) {
        return first;
    }
    return (payload, payloadModel) => {
        const runSecond = (firstResult) => {
            const nextPayload = firstResult === undefined ? payload : firstResult;
            const secondResult = second(nextPayload, payloadModel);
            const coerceResult = (resolvedSecond) => resolvedSecond === undefined ? firstResult : resolvedSecond;
            return isPromiseLike(secondResult)
                ? Promise.resolve(secondResult).then(coerceResult)
                : coerceResult(secondResult);
        };
        const firstResult = first(payload, payloadModel);
        if (isPromiseLike(firstResult)) {
            return Promise.resolve(firstResult).then(runSecond);
        }
        return runSecond(firstResult);
    };
}
async function resolveImageRuntime(params) {
    await ensureOpenClawModelsJson(params.cfg, params.agentDir);
    const { discoverAuthStorage, discoverModels } = await loadPiModelDiscoveryRuntime();
    const authStorage = discoverAuthStorage(params.agentDir);
    const modelRegistry = discoverModels(authStorage, params.agentDir);
    const resolvedRef = normalizeModelRef(params.provider, params.model);
    const model = modelRegistry.find(resolvedRef.provider, resolvedRef.model);
    if (!model) {
        throw new Error(`Unknown model: ${resolvedRef.provider}/${resolvedRef.model}`);
    }
    if (!model.input?.includes("image")) {
        throw new Error(`Model does not support images: ${params.provider}/${params.model}`);
    }
    const apiKeyInfo = await getApiKeyForModel({
        model,
        cfg: params.cfg,
        agentDir: params.agentDir,
        profileId: params.profile,
        preferredProfile: params.preferredProfile,
        store: params.authStore,
    });
    const apiKey = requireApiKey(apiKeyInfo, model.provider);
    authStorage.setRuntimeApiKey(model.provider, apiKey);
    return { apiKey, model };
}
function buildImageContext(prompt, images, opts) {
    const imageContent = images.map((image) => ({
        type: "image",
        data: image.buffer.toString("base64"),
        mimeType: image.mime ?? "image/jpeg",
    }));
    const content = opts?.promptInUserContent
        ? [{ type: "text", text: prompt }, ...imageContent]
        : imageContent;
    return {
        ...(opts?.promptInUserContent ? {} : { systemPrompt: prompt }),
        messages: [
            {
                role: "user",
                content,
                timestamp: Date.now(),
            },
        ],
    };
}
function shouldPlaceImagePromptInUserContent(model) {
    const capabilities = resolveProviderRequestCapabilities({
        provider: model.provider,
        api: model.api,
        baseUrl: model.baseUrl,
        capability: "image",
        transport: "media-understanding",
    });
    return (capabilities.endpointClass === "openrouter" ||
        (model.provider.toLowerCase() === "openrouter" && capabilities.endpointClass === "default"));
}
async function describeImagesWithMinimax(params) {
    const responses = [];
    for (const [index, image] of params.images.entries()) {
        const prompt = params.images.length > 1
            ? `${params.prompt}\n\nDescribe image ${index + 1} of ${params.images.length} independently.`
            : params.prompt;
        const text = await minimaxUnderstandImage({
            apiKey: params.apiKey,
            prompt,
            imageDataUrl: `data:${image.mime ?? "image/jpeg"};base64,${image.buffer.toString("base64")}`,
            modelBaseUrl: params.modelBaseUrl,
        });
        responses.push(params.images.length > 1 ? `Image ${index + 1}:\n${text.trim()}` : text.trim());
    }
    return {
        text: responses.join("\n\n").trim(),
        model: params.modelId,
    };
}
function isUnknownModelError(err) {
    return err instanceof Error && /^Unknown model:/i.test(err.message);
}
function resolveConfiguredProviderBaseUrl(cfg, provider) {
    const direct = cfg.models?.providers?.[provider];
    if (typeof direct?.baseUrl === "string" && direct.baseUrl.trim()) {
        return direct.baseUrl.trim();
    }
    return undefined;
}
async function resolveMinimaxVlmFallbackRuntime(params) {
    const auth = await resolveApiKeyForProvider({
        provider: params.provider,
        cfg: params.cfg,
        profileId: params.profile,
        preferredProfile: params.preferredProfile,
        agentDir: params.agentDir,
    });
    return {
        apiKey: requireApiKey(auth, params.provider),
        modelBaseUrl: resolveConfiguredProviderBaseUrl(params.cfg, params.provider),
    };
}
async function describeImagesWithModelInternal(params, options = {}) {
    const prompt = params.prompt ?? "Describe the image.";
    let apiKey;
    let model;
    try {
        const resolved = await resolveImageRuntime(params);
        apiKey = resolved.apiKey;
        model = resolved.model;
    }
    catch (err) {
        if (!isMinimaxVlmModel(params.provider, params.model) || !isUnknownModelError(err)) {
            throw err;
        }
        const fallback = await resolveMinimaxVlmFallbackRuntime(params);
        return await describeImagesWithMinimax({
            apiKey: fallback.apiKey,
            modelId: params.model,
            modelBaseUrl: fallback.modelBaseUrl,
            prompt,
            images: params.images,
        });
    }
    if (isMinimaxVlmModel(model.provider, model.id)) {
        return await describeImagesWithMinimax({
            apiKey,
            modelId: model.id,
            modelBaseUrl: model.baseUrl,
            prompt,
            images: params.images,
        });
    }
    registerProviderStreamForModel({
        model,
        cfg: params.cfg,
        agentDir: params.agentDir,
    });
    const context = buildImageContext(prompt, params.images, {
        promptInUserContent: shouldPlaceImagePromptInUserContent(model),
    });
    const controller = new AbortController();
    const timeout = typeof params.timeoutMs === "number" &&
        Number.isFinite(params.timeoutMs) &&
        params.timeoutMs > 0
        ? setTimeout(() => controller.abort(), params.timeoutMs)
        : undefined;
    const maxTokens = resolveImageToolMaxTokens(model.maxTokens, params.maxTokens ?? 512);
    const completeImage = async (onPayload) => {
        const payloadHandler = composeImageDescriptionPayloadHandlers(onPayload, options.onPayload);
        return await complete(model, context, {
            apiKey,
            maxTokens,
            signal: controller.signal,
            ...(payloadHandler ? { onPayload: payloadHandler } : {}),
        });
    };
    try {
        const message = await completeImage();
        try {
            const text = coerceImageAssistantText({
                message,
                provider: model.provider,
                model: model.id,
            });
            return { text, model: model.id };
        }
        catch (err) {
            if (!isImageModelNoTextError(err) || !hasImageReasoningOnlyResponse(message)) {
                throw err;
            }
        }
        const retryMessage = await completeImage(disableReasoningForImageRetryPayload);
        const text = coerceImageAssistantText({
            message: retryMessage,
            provider: model.provider,
            model: model.id,
        });
        return { text, model: model.id };
    }
    finally {
        clearTimeout(timeout);
    }
}
export async function describeImagesWithModel(params) {
    return await describeImagesWithModelInternal(params);
}
export async function describeImagesWithModelPayloadTransform(params, onPayload) {
    return await describeImagesWithModelInternal(params, { onPayload });
}
export async function describeImageWithModel(params) {
    return await describeImagesWithModel({
        images: [
            {
                buffer: params.buffer,
                fileName: params.fileName,
                mime: params.mime,
            },
        ],
        model: params.model,
        provider: params.provider,
        prompt: params.prompt,
        maxTokens: params.maxTokens,
        timeoutMs: params.timeoutMs,
        profile: params.profile,
        preferredProfile: params.preferredProfile,
        authStore: params.authStore,
        agentDir: params.agentDir,
        cfg: params.cfg,
    });
}
export async function describeImageWithModelPayloadTransform(params, onPayload) {
    return await describeImagesWithModelPayloadTransform({
        images: [
            {
                buffer: params.buffer,
                fileName: params.fileName,
                mime: params.mime,
            },
        ],
        model: params.model,
        provider: params.provider,
        prompt: params.prompt,
        maxTokens: params.maxTokens,
        timeoutMs: params.timeoutMs,
        profile: params.profile,
        preferredProfile: params.preferredProfile,
        authStore: params.authStore,
        agentDir: params.agentDir,
        cfg: params.cfg,
    }, onPayload);
}
