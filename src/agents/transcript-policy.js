import { normalizeProviderId } from "./model-selection.js";
import { isGoogleModelApi } from "./pi-embedded-helpers/google.js";
const MISTRAL_MODEL_HINTS = [
    "mistral",
    "mixtral",
    "codestral",
    "pixtral",
    "devstral",
    "ministral",
    "mistralai",
];
const OPENAI_MODEL_APIS = new Set([
    "openai",
    "openai-completions",
    "openai-responses",
    "openai-codex-responses",
]);
const OPENAI_PROVIDERS = new Set(["openai", "openai-codex"]);
const OPENAI_COMPAT_TURN_MERGE_EXCLUDED_PROVIDERS = new Set(["openrouter", "opencode"]);
function isOpenAiApi(modelApi) {
    if (!modelApi) {
        return false;
    }
    return OPENAI_MODEL_APIS.has(modelApi);
}
function isOpenAiProvider(provider) {
    if (!provider) {
        return false;
    }
    return OPENAI_PROVIDERS.has(normalizeProviderId(provider));
}
function isAnthropicApi(modelApi, provider) {
    if (modelApi === "anthropic-messages" || modelApi === "bedrock-converse-stream") {
        return true;
    }
    const normalized = normalizeProviderId(provider ?? "");
    // MiniMax now uses openai-completions API, not anthropic-messages
    return normalized === "anthropic" || normalized === "amazon-bedrock";
}
function isMistralModel(params) {
    const provider = normalizeProviderId(params.provider ?? "");
    if (provider === "mistral") {
        return true;
    }
    const modelId = (params.modelId ?? "").toLowerCase();
    if (!modelId) {
        return false;
    }
    return MISTRAL_MODEL_HINTS.some((hint) => modelId.includes(hint));
}
export function resolveTranscriptPolicy(params) {
    const provider = normalizeProviderId(params.provider ?? "");
    const modelId = params.modelId ?? "";
    const isGoogle = isGoogleModelApi(params.modelApi);
    const isAnthropic = isAnthropicApi(params.modelApi, provider);
    const isOpenAi = isOpenAiProvider(provider) || (!provider && isOpenAiApi(params.modelApi));
    const isStrictOpenAiCompatible = params.modelApi === "openai-completions" &&
        !isOpenAi &&
        !OPENAI_COMPAT_TURN_MERGE_EXCLUDED_PROVIDERS.has(provider);
    const isMistral = isMistralModel({ provider, modelId });
    const isOpenRouterGemini = (provider === "openrouter" || provider === "opencode" || provider === "kilocode") &&
        modelId.toLowerCase().includes("gemini");
    const isCopilotClaude = provider === "github-copilot" && modelId.toLowerCase().includes("claude");
    const requiresOpenAiCompatibleToolIdSanitization = params.modelApi === "openai-completions";
    // GitHub Copilot's Claude endpoints can reject persisted `thinking` blocks with
    // non-binary/non-base64 signatures (e.g. thinkingSignature: "reasoning_text").
    // Drop these blocks at send-time to keep sessions usable.
    const dropThinkingBlocks = isCopilotClaude;
    const needsNonImageSanitize = isGoogle || isAnthropic || isMistral || isOpenRouterGemini;
    const sanitizeToolCallIds = isGoogle || isMistral || isAnthropic || requiresOpenAiCompatibleToolIdSanitization;
    const toolCallIdMode = isMistral
        ? "strict9"
        : sanitizeToolCallIds
            ? "strict"
            : undefined;
    // All providers need orphaned tool_result repair after history truncation.
    // OpenAI rejects function_call_output items whose call_id has no matching
    // function_call in the conversation, so the repair must run universally.
    const repairToolUseResultPairing = true;
    const sanitizeThoughtSignatures = isOpenRouterGemini || isGoogle ? { allowBase64Only: true, includeCamelCase: true } : undefined;
    return {
        sanitizeMode: isOpenAi ? "images-only" : needsNonImageSanitize ? "full" : "images-only",
        sanitizeToolCallIds: (!isOpenAi && sanitizeToolCallIds) || requiresOpenAiCompatibleToolIdSanitization,
        toolCallIdMode,
        repairToolUseResultPairing,
        preserveSignatures: false,
        sanitizeThoughtSignatures: isOpenAi ? undefined : sanitizeThoughtSignatures,
        sanitizeThinkingSignatures: false,
        dropThinkingBlocks,
        applyGoogleTurnOrdering: !isOpenAi && isGoogle,
        validateGeminiTurns: !isOpenAi && isGoogle,
        validateAnthropicTurns: !isOpenAi && (isAnthropic || isStrictOpenAiCompatible),
        allowSyntheticToolResults: !isOpenAi && (isGoogle || isAnthropic),
    };
}
