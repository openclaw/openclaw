import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  ProviderReasoningOutputMode,
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
  ProviderReplaySessionState,
  ProviderSanitizeReplayHistoryContext,
} from "./types.js";

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
  options: {
    dropThinkingBlocks?: boolean;
    sanitizeToolCallIds?: boolean;
    preserveNativeAnthropicToolUseIds?: boolean;
  } = {},
): ProviderReplayPolicy {
  const sanitizeToolCallIds = options.sanitizeToolCallIds ?? true;
  return {
    sanitizeMode: "full",
    ...(sanitizeToolCallIds
      ? {
          sanitizeToolCallIds: true,
          toolCallIdMode: "strict" as const,
          ...(options.preserveNativeAnthropicToolUseIds
            ? { preserveNativeAnthropicToolUseIds: true }
            : {}),
        }
      : {}),
    preserveSignatures: true,
    repairToolUseResultPairing: true,
    validateAnthropicTurns: true,
    allowSyntheticToolResults: true,
    ...(options.dropThinkingBlocks ? { dropThinkingBlocks: true } : {}),
  };
}

export function buildAnthropicReplayPolicyForModel(modelId?: string): ProviderReplayPolicy {
  return buildStrictAnthropicReplayPolicy({
    dropThinkingBlocks: (modelId?.toLowerCase() ?? "").includes("claude"),
  });
}

export function buildNativeAnthropicReplayPolicyForModel(modelId?: string): ProviderReplayPolicy {
  return buildStrictAnthropicReplayPolicy({
    dropThinkingBlocks: (modelId?.toLowerCase() ?? "").includes("claude"),
    sanitizeToolCallIds: true,
    preserveNativeAnthropicToolUseIds: true,
  });
}

export function buildHybridAnthropicOrOpenAIReplayPolicy(
  ctx: ProviderReplayPolicyContext,
  options: { anthropicModelDropThinkingBlocks?: boolean } = {},
): ProviderReplayPolicy | undefined {
  if (ctx.modelApi === "anthropic-messages" || ctx.modelApi === "bedrock-converse-stream") {
    return buildStrictAnthropicReplayPolicy({
      dropThinkingBlocks:
        options.anthropicModelDropThinkingBlocks &&
        (ctx.modelId?.toLowerCase() ?? "").includes("claude"),
    });
  }

  return buildOpenAICompatibleReplayPolicy(ctx.modelApi);
}

const GOOGLE_TURN_ORDERING_CUSTOM_TYPE = "google-turn-ordering-bootstrap";
const GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT = "(session bootstrap)";

function sanitizeGoogleAssistantFirstOrdering(messages: AgentMessage[]): AgentMessage[] {
  const first = messages[0] as { role?: unknown; content?: unknown } | undefined;
  const role = first?.role;
  const content = first?.content;
  if (
    role === "user" &&
    typeof content === "string" &&
    content.trim() === GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT
  ) {
    return messages;
  }
  if (role !== "assistant") {
    return messages;
  }

  const bootstrap: AgentMessage = {
    role: "user",
    content: GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT,
    timestamp: Date.now(),
  } as AgentMessage;

  return [bootstrap, ...messages];
}

function hasGoogleTurnOrderingMarker(sessionState: ProviderReplaySessionState): boolean {
  return sessionState
    .getCustomEntries()
    .some((entry) => entry.customType === GOOGLE_TURN_ORDERING_CUSTOM_TYPE);
}

function markGoogleTurnOrderingMarker(sessionState: ProviderReplaySessionState): void {
  sessionState.appendCustomEntry(GOOGLE_TURN_ORDERING_CUSTOM_TYPE, {
    timestamp: Date.now(),
  });
}

export function buildGoogleGeminiReplayPolicy(): ProviderReplayPolicy {
  return {
    sanitizeMode: "full",
    sanitizeToolCallIds: true,
    toolCallIdMode: "strict",
    sanitizeThoughtSignatures: {
      allowBase64Only: true,
      includeCamelCase: true,
    },
    repairToolUseResultPairing: true,
    applyAssistantFirstOrderingFix: true,
    validateGeminiTurns: true,
    validateAnthropicTurns: false,
    allowSyntheticToolResults: true,
  };
}

export function buildPassthroughGeminiSanitizingReplayPolicy(
  modelId?: string,
): ProviderReplayPolicy {
  return {
    applyAssistantFirstOrderingFix: false,
    validateGeminiTurns: false,
    validateAnthropicTurns: false,
    ...((modelId?.toLowerCase() ?? "").includes("gemini")
      ? {
          sanitizeThoughtSignatures: {
            allowBase64Only: true,
            includeCamelCase: true,
          },
        }
      : {}),
  };
}

export function sanitizeGoogleGeminiReplayHistory(
  ctx: ProviderSanitizeReplayHistoryContext,
): AgentMessage[] {
  const messages = sanitizeGoogleAssistantFirstOrdering(ctx.messages);
  if (
    messages !== ctx.messages &&
    ctx.sessionState &&
    !hasGoogleTurnOrderingMarker(ctx.sessionState)
  ) {
    markGoogleTurnOrderingMarker(ctx.sessionState);
  }
  return messages;
}

export function resolveTaggedReasoningOutputMode(): ProviderReasoningOutputMode {
  return "tagged";
}
