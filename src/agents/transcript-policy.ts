import { normalizeProviderId } from "./model-selection.js";
import {
  isOpenAiProviderFamily,
  resolveTranscriptToolCallIdMode,
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

const OPENAI_MODEL_APIS = new Set([
  "openai",
  "openai-completions",
]);

function isOpenAiApi(modelApi?: string | null): boolean {
  if (!modelApi) {
    return false;
  }
  return OPENAI_MODEL_APIS.has(modelApi);
}

function isOpenAiProvider(provider?: string | null): boolean {
  return isOpenAiProviderFamily(provider);
}

export function resolveTranscriptPolicy(params: {
  modelApi?: string | null;
  provider?: string | null;
  modelId?: string | null;
}): TranscriptPolicy {
  const provider = normalizeProviderId(params.provider ?? "");
  const modelId = params.modelId ?? "";
  const providerToolCallIdMode = resolveTranscriptToolCallIdMode(provider, modelId);
  const isMistral = providerToolCallIdMode === "strict9";

  const needsNonImageSanitize = isMistral;

  const sanitizeToolCallIds = isMistral;
  const toolCallIdMode: ToolCallIdMode | undefined = providerToolCallIdMode
    ? providerToolCallIdMode
    : isMistral
      ? "strict9"
      : sanitizeToolCallIds
        ? "strict"
        : undefined;
  // All providers need orphaned tool_result repair after history truncation.
  const repairToolUseResultPairing = true;

  return {
    sanitizeMode: needsNonImageSanitize ? "full" : "images-only",
    sanitizeToolCallIds,
    toolCallIdMode,
    repairToolUseResultPairing,
    preserveSignatures: false,
    sanitizeThoughtSignatures: undefined,
    sanitizeThinkingSignatures: false,
    dropThinkingBlocks: false,
    applyGoogleTurnOrdering: false,
    validateGeminiTurns: false,
    validateAnthropicTurns: false,
    allowSyntheticToolResults: false,
  };
}
