// Shared model/catalog helpers for provider plugins.
//
// Keep provider-owned exports out of this subpath so plugin loaders can import it
// without recursing through provider-specific facades.
import { buildAnthropicReplayPolicyForModel, buildGoogleGeminiReplayPolicy, buildHybridAnthropicOrOpenAIReplayPolicy, buildNativeAnthropicReplayPolicyForModel, buildOpenAICompatibleReplayPolicy, buildPassthroughGeminiSanitizingReplayPolicy, buildStrictAnthropicReplayPolicy, resolveTaggedReasoningOutputMode, sanitizeGoogleGeminiReplayHistory, } from "../plugins/provider-replay-helpers.js";
import { normalizeAntigravityPreviewModelId, normalizeGooglePreviewModelId, normalizeNativeXaiModelId, } from "./provider-model-id-normalize.js";
export { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
export { GPT5_BEHAVIOR_CONTRACT, GPT5_FRIENDLY_PROMPT_OVERLAY, isGpt5ModelId, normalizeGpt5PromptOverlayMode, renderGpt5PromptOverlay, resolveGpt5PromptOverlayMode, resolveGpt5SystemPromptContribution, } from "../agents/gpt5-prompt-overlay.js";
export { resolveProviderEndpoint } from "../agents/provider-attribution.js";
export { applyModelCompatPatch, hasToolSchemaProfile, hasNativeWebSearchTool, normalizeModelCompat, resolveUnsupportedToolSchemaKeywords, resolveToolCallArgumentsEncoding, } from "../plugins/provider-model-compat.js";
export { normalizeProviderId } from "../agents/provider-id.js";
export { buildAnthropicReplayPolicyForModel, buildGoogleGeminiReplayPolicy, buildHybridAnthropicOrOpenAIReplayPolicy, buildNativeAnthropicReplayPolicyForModel, buildOpenAICompatibleReplayPolicy, buildPassthroughGeminiSanitizingReplayPolicy, resolveTaggedReasoningOutputMode, sanitizeGoogleGeminiReplayHistory, buildStrictAnthropicReplayPolicy, };
export { createMoonshotThinkingWrapper, resolveMoonshotThinkingType, } from "../agents/pi-embedded-runner/moonshot-thinking-stream-wrappers.js";
export { cloneFirstTemplateModel, matchesExactOrPrefix, } from "../plugins/provider-model-helpers.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
export function getModelProviderHint(modelId) {
    const trimmed = normalizeOptionalLowercaseString(modelId);
    if (!trimmed) {
        return null;
    }
    const slashIndex = trimmed.indexOf("/");
    if (slashIndex <= 0) {
        return null;
    }
    return trimmed.slice(0, slashIndex) || null;
}
export function isProxyReasoningUnsupportedModelHint(modelId) {
    return getModelProviderHint(modelId) === "x-ai";
}
export { normalizeAntigravityPreviewModelId, normalizeGooglePreviewModelId, normalizeNativeXaiModelId, };
export function buildProviderReplayFamilyHooks(options) {
    switch (options.family) {
        case "openai-compatible": {
            const policyOptions = { sanitizeToolCallIds: options.sanitizeToolCallIds };
            return {
                buildReplayPolicy: (ctx) => buildOpenAICompatibleReplayPolicy(ctx.modelApi, policyOptions),
            };
        }
        case "anthropic-by-model":
            return {
                buildReplayPolicy: ({ modelId }) => buildAnthropicReplayPolicyForModel(modelId),
            };
        case "native-anthropic-by-model":
            return {
                buildReplayPolicy: ({ modelId }) => buildNativeAnthropicReplayPolicyForModel(modelId),
            };
        case "google-gemini":
            return {
                buildReplayPolicy: () => buildGoogleGeminiReplayPolicy(),
                sanitizeReplayHistory: (ctx) => sanitizeGoogleGeminiReplayHistory(ctx),
                resolveReasoningOutputMode: (_ctx) => resolveTaggedReasoningOutputMode(),
            };
        case "passthrough-gemini":
            return {
                buildReplayPolicy: ({ modelId }) => buildPassthroughGeminiSanitizingReplayPolicy(modelId),
            };
        case "hybrid-anthropic-openai":
            return {
                buildReplayPolicy: (ctx) => buildHybridAnthropicOrOpenAIReplayPolicy(ctx, {
                    anthropicModelDropThinkingBlocks: options.anthropicModelDropThinkingBlocks,
                }),
            };
    }
    throw new Error("Unsupported provider replay family");
}
export const OPENAI_COMPATIBLE_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
    family: "openai-compatible",
});
export const ANTHROPIC_BY_MODEL_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
    family: "anthropic-by-model",
});
export const NATIVE_ANTHROPIC_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
    family: "native-anthropic-by-model",
});
export const PASSTHROUGH_GEMINI_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
    family: "passthrough-gemini",
});
