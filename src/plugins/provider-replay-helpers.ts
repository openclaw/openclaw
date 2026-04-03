import type { ProviderReplayPolicy } from "./types.js";

export function buildOpenAICompatibleReplayPolicy(
  modelApi: string | null | undefined,
): ProviderReplayPolicy | undefined {
  if (
    modelApi !== "openai-completions" &&
    modelApi !== "openai-responses" &&
    modelApi !== "openai-codex-responses" &&
    modelApi !== "azure-openai-responses"
  ) {
    return undefined;
  }

  return {
    sanitizeToolCallIds: true,
    toolCallIdMode: "strict",
    ...(modelApi === "openai-completions"
      ? {
          applyAssistantFirstOrderingFix: true,
          validateGeminiTurns: true,
          validateAnthropicTurns: true,
        }
      : {
          applyAssistantFirstOrderingFix: false,
          validateGeminiTurns: false,
          validateAnthropicTurns: false,
        }),
  };
}

export function buildStrictAnthropicReplayPolicy(
  options: { dropThinkingBlocks?: boolean } = {},
): ProviderReplayPolicy {
  return {
    sanitizeMode: "full",
    sanitizeToolCallIds: true,
    toolCallIdMode: "strict",
    preserveSignatures: true,
    repairToolUseResultPairing: true,
    validateAnthropicTurns: true,
    allowSyntheticToolResults: true,
    ...(options.dropThinkingBlocks ? { dropThinkingBlocks: true } : {}),
  };
}
