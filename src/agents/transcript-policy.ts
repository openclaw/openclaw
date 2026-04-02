import type { OpenClawConfig } from "../config/config.js";
import { resolveProviderReplayPolicyWithPlugin } from "../plugins/provider-runtime.js";
import type { ProviderRuntimeModel } from "../plugins/types.js";
import { normalizeProviderId } from "./model-selection.js";
import { isGoogleModelApi } from "./pi-embedded-helpers/google.js";
import {
  isAnthropicProviderFamily,
  isOpenAiProviderFamily,
  preservesAnthropicThinkingSignatures,
  resolveTranscriptToolCallIdMode,
  shouldDropThinkingBlocksForModel,
  shouldSanitizeGeminiThoughtSignaturesForModel,
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

const OPENAI_MODEL_APIS = new Set([
  "openai",
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
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

function isAnthropicApi(modelApi?: string | null, provider?: string | null): boolean {
  if (modelApi === "anthropic-messages" || modelApi === "bedrock-converse-stream") {
    return true;
  }
  // MiniMax now uses openai-completions API, not anthropic-messages
  return isAnthropicProviderFamily(provider);
}

export function resolveTranscriptPolicy(params: {
  modelApi?: string | null;
  provider?: string | null;
  modelId?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  model?: ProviderRuntimeModel;
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
  const providerToolCallIdMode = resolveTranscriptToolCallIdMode(provider, modelId);
  const isMistral = providerToolCallIdMode === "strict9";
  const shouldSanitizeGeminiThoughtSignaturesForProvider =
    shouldSanitizeGeminiThoughtSignaturesForModel({
      provider,
      modelId,
    });
  const requiresOpenAiCompatibleToolIdSanitization =
    params.modelApi === "openai-completions" ||
    (!isOpenAi &&
      (params.modelApi === "openai-responses" ||
        params.modelApi === "openai-codex-responses" ||
        params.modelApi === "azure-openai-responses"));

  // Anthropic Claude endpoints can reject replayed `thinking` blocks unless the
  // original signatures are preserved byte-for-byte. Drop them at send-time to
  // keep persisted sessions usable across follow-up turns.
  const dropThinkingBlocks = shouldDropThinkingBlocksForModel({ provider, modelId });

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

  const basePolicy: TranscriptPolicy = {
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

  const pluginPolicy = provider
    ? resolveProviderReplayPolicyWithPlugin({
        provider,
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        context: {
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: params.env,
          provider,
          modelId,
          modelApi: params.modelApi,
          model: params.model,
        },
      })
    : undefined;
  if (!pluginPolicy) {
    return basePolicy;
  }

  return {
    ...basePolicy,
    ...(pluginPolicy.sanitizeMode != null ? { sanitizeMode: pluginPolicy.sanitizeMode } : {}),
    ...(typeof pluginPolicy.sanitizeToolCallIds === "boolean"
      ? { sanitizeToolCallIds: pluginPolicy.sanitizeToolCallIds }
      : {}),
    ...(pluginPolicy.toolCallIdMode ? { toolCallIdMode: pluginPolicy.toolCallIdMode } : {}),
    ...(typeof pluginPolicy.repairToolUseResultPairing === "boolean"
      ? { repairToolUseResultPairing: pluginPolicy.repairToolUseResultPairing }
      : {}),
    ...(typeof pluginPolicy.preserveSignatures === "boolean"
      ? { preserveSignatures: pluginPolicy.preserveSignatures }
      : {}),
    ...(pluginPolicy.sanitizeThoughtSignatures
      ? { sanitizeThoughtSignatures: pluginPolicy.sanitizeThoughtSignatures }
      : {}),
    ...(typeof pluginPolicy.dropThinkingBlocks === "boolean"
      ? { dropThinkingBlocks: pluginPolicy.dropThinkingBlocks }
      : {}),
    ...(typeof pluginPolicy.applyAssistantFirstOrderingFix === "boolean"
      ? { applyGoogleTurnOrdering: pluginPolicy.applyAssistantFirstOrderingFix }
      : {}),
    ...(typeof pluginPolicy.allowSyntheticToolResults === "boolean"
      ? { allowSyntheticToolResults: pluginPolicy.allowSyntheticToolResults }
      : {}),
  };
}
