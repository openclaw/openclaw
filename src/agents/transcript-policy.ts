import { normalizeProviderId } from "./model-selection.js";
import { isGoogleModelApi } from "./pi-embedded-helpers/google.js";
import {
  preservesAnthropicThinkingSignatures,
  resolveTranscriptToolCallIdMode,
  sanitizesGeminiThoughtSignatures,
  supportsOpenAiCompatTurnValidation,
} from "./provider-capabilities.js";
import type { ToolCallIdMode } from "./tool-call-id.js";

export type TranscriptSanitizeMode = "full" | "images-only";

export type TranscriptPolicy = {
  sanitizeMode: TranscriptSanitizeMode;
  sanitizeToolCallIds: boolean;
  toolCallIdMode?: ToolCallIdMode;
  repairToolUseResultPairing: boolean;
  preserveSignatures: boolean;
  sanitizeThoughtSignatures?: {
    allowBase64Only?: boolean;
    includeCamelCase?: boolean;
  };
  sanitizeThinkingSignatures: boolean;
  dropThinkingBlocks: boolean;
  applyGoogleTurnOrdering: boolean;
  validateGeminiTurns: boolean;
  validateAnthropicTurns: boolean;
  allowSyntheticToolResults: boolean;
};

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

function isOpenAiApi(modelApi?: string | null): boolean {
  if (!modelApi) {
    return false;
  }
  return OPENAI_MODEL_APIS.has(modelApi);
}

function isOpenAiProvider(provider?: string | null): boolean {
  if (!provider) {
    return false;
  }
  return OPENAI_PROVIDERS.has(normalizeProviderId(provider));
}

function isAnthropicApi(modelApi?: string | null, provider?: string | null): boolean {
  if (modelApi === "anthropic-messages" || modelApi === "bedrock-converse-stream") {
    return true;
  }
  const normalized = normalizeProviderId(provider ?? "");
  // MiniMax now uses openai-completions API, not anthropic-messages
  return normalized === "anthropic" || normalized === "amazon-bedrock";
}

function isMistralModel(modelId?: string | null): boolean {
  const normalizedModelId = (modelId ?? "").toLowerCase();
  if (!normalizedModelId) {
    return false;
  }
  return MISTRAL_MODEL_HINTS.some((hint) => normalizedModelId.includes(hint));
}

function shouldSanitizeGeminiThoughtSignatures(params: {
  provider?: string | null;
  modelId?: string | null;
}): boolean {
  if (!sanitizesGeminiThoughtSignatures(params.provider)) {
    return false;
  }
  const modelId = (params.modelId ?? "").toLowerCase();
  if (!modelId) {
    return false;
  }
  return modelId.includes("gemini");
}

export function resolveTranscriptPolicy(params: {
  modelApi?: string | null;
  provider?: string | null;
  modelId?: string | null;
}): TranscriptPolicy {
  const provider = normalizeProviderId(params.provider ?? "");
  const modelId = params.modelId ?? "";
  const isGoogle = isGoogleModelApi(params.modelApi);
  const isAnthropic = isAnthropicApi(params.modelApi, provider);
  const isOpenAi = isOpenAiProvider(provider) || (!provider && isOpenAiApi(params.modelApi));
  const isStrictOpenAiCompatible =
    params.modelApi === "openai-completions" &&
    !isOpenAi &&
    supportsOpenAiCompatTurnValidation(provider);
  const providerToolCallIdMode = resolveTranscriptToolCallIdMode(provider);
  const isMistral = providerToolCallIdMode === "strict9" || isMistralModel(modelId);
  const shouldSanitizeGeminiThoughtSignaturesForProvider = shouldSanitizeGeminiThoughtSignatures({
    provider,
    modelId,
  });
  const isCopilotClaude = provider === "github-copilot" && modelId.toLowerCase().includes("claude");
  const requiresOpenAiCompatibleToolIdSanitization = params.modelApi === "openai-completions";

  // GitHub Copilot's Claude endpoints can reject persisted `thinking` blocks with
  // non-binary/non-base64 signatures (e.g. thinkingSignature: "reasoning_text").
  // Drop these blocks at send-time to keep sessions usable.
  const dropThinkingBlocks = isCopilotClaude;

  const needsNonImageSanitize =
    isGoogle || isAnthropic || isMistral || shouldSanitizeGeminiThoughtSignaturesForProvider;

  const sanitizeToolCallIds =
    isGoogle || isMistral || isAnthropic || requiresOpenAiCompatibleToolIdSanitization;
  const toolCallIdMode: ToolCallIdMode | undefined = providerToolCallIdMode
    ? providerToolCallIdMode
    : isMistral
      ? "strict9"
      : sanitizeToolCallIds
        ? "strict"
        : undefined;
  // All providers need orphaned tool_result repair after history truncation.
  // OpenAI rejects function_call_output items whose call_id has no matching
  // function_call in the conversation, so the repair must run universally.
  const repairToolUseResultPairing = true;
  const sanitizeThoughtSignatures =
    shouldSanitizeGeminiThoughtSignaturesForProvider || isGoogle
      ? { allowBase64Only: true, includeCamelCase: true }
      : undefined;

  return {
    sanitizeMode: isOpenAi ? "images-only" : needsNonImageSanitize ? "full" : "images-only",
    sanitizeToolCallIds:
      (!isOpenAi && sanitizeToolCallIds) || requiresOpenAiCompatibleToolIdSanitization,
    toolCallIdMode,
    repairToolUseResultPairing,
    preserveSignatures: isAnthropic && preservesAnthropicThinkingSignatures(provider),
    sanitizeThoughtSignatures: isOpenAi ? undefined : sanitizeThoughtSignatures,
    sanitizeThinkingSignatures: false,
    dropThinkingBlocks,
    applyGoogleTurnOrdering: !isOpenAi && (isGoogle || isStrictOpenAiCompatible),
    validateGeminiTurns: !isOpenAi && (isGoogle || isStrictOpenAiCompatible),
    validateAnthropicTurns: !isOpenAi && (isAnthropic || isStrictOpenAiCompatible),
    allowSyntheticToolResults: !isOpenAi && (isGoogle || isAnthropic),
  };
}
