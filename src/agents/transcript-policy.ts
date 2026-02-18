import type { ToolCallIdMode } from "./tool-call-id.js";
import { resolveProviderCapabilities } from "./provider-capabilities.js";

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
  normalizeAntigravityThinkingBlocks: boolean;
  applyGoogleTurnOrdering: boolean;
  validateGeminiTurns: boolean;
  validateAnthropicTurns: boolean;
  allowSyntheticToolResults: boolean;
};

export function resolveTranscriptPolicy(params: {
  modelApi?: string | null;
  provider?: string | null;
  modelId?: string | null;
}): TranscriptPolicy {
  const caps = resolveProviderCapabilities(params);
  return {
    sanitizeMode: caps.sanitizeMode,
    sanitizeToolCallIds: caps.sanitizeToolCallIds,
    toolCallIdMode: caps.toolCallIdMode ?? undefined,
    repairToolUseResultPairing: caps.repairToolUseResultPairing,
    preserveSignatures: caps.preserveSignatures,
    sanitizeThoughtSignatures: caps.sanitizeThoughtSignatures ?? undefined,
    normalizeAntigravityThinkingBlocks: caps.normalizeAntigravityThinkingBlocks,
    applyGoogleTurnOrdering: caps.applyGoogleTurnOrdering,
    validateGeminiTurns: caps.validateGeminiTurns,
    validateAnthropicTurns: caps.validateAnthropicTurns,
    allowSyntheticToolResults: caps.allowSyntheticToolResults,
  };
}
