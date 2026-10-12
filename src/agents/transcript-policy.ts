/**
 * Transcript replay policy resolution.
 * Combines provider plugin replay hooks with core transport fallbacks so chat
 * history sanitization, tool IDs, thinking blocks, and turn validation align.
 */
import { isDirectAnthropicModel } from "@openclaw/ai/internal/anthropic";
import { supportsNativeOpenAIResponsesEndpoint } from "@openclaw/ai/internal/openai-responses-payload-policy";
import { supportsClaudeInHistorySystemMessages } from "@openclaw/llm-core";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import { resolveProviderRuntimePlugin } from "../plugins/provider-hook-runtime.js";
import { buildAnthropicReplayPolicyForModel } from "../plugins/provider-replay-helpers.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import type { ProviderReplayPolicy } from "../plugins/types.js";
import { isAnthropicApi } from "./embedded-agent-helpers/anthropic-api.js";
import { isGoogleModelApi } from "./embedded-agent-helpers/google.js";
import type { TranscriptPolicy } from "./transcript-policy.types.js";

const DEFAULT_TRANSCRIPT_POLICY: TranscriptPolicy = {
  sanitizeMode: "images-only",
  sanitizeToolCallIds: false,
  toolCallIdMode: undefined,
  duplicateToolCallIdStyle: undefined,
  preserveNativeAnthropicToolUseIds: false,
  repairToolUseResultPairing: true,
  preserveSignatures: false,
  appendOnlyRuntimeContext: false,
  inHistorySystemUpdates: false,
  sanitizeThoughtSignatures: undefined,
  dropThinkingBlocks: false,
  dropReasoningFromHistory: false,
  applyGoogleTurnOrdering: false,
  validateGeminiTurns: false,
  validateAnthropicTurns: false,
  allowSyntheticToolResults: false,
};

function isOpenAiResponsesCompatibleApi(modelApi?: string | null): boolean {
  return (
    modelApi === "openai-responses" ||
    modelApi === "openai-chatgpt-responses" ||
    modelApi === "azure-openai-responses"
  );
}

function modelDisablesReasoningEffort(model?: ProviderRuntimeModel): boolean {
  const compat = model?.compat as { supportsReasoningEffort?: boolean } | undefined;
  return compat?.supportsReasoningEffort === false;
}

/**
 * Provides a narrow replay-policy fallback for providers that do not have an
 * owning runtime plugin.
 *
 * This exists to preserve generic custom-provider behavior. Bundled providers
 * should express replay ownership through `buildReplayPolicy` instead.
 */
function buildUnownedProviderTransportReplayFallback(params: {
  modelApi?: string | null;
  modelId?: string | null;
  model?: ProviderRuntimeModel;
  inHistorySystemUpdates: boolean;
}): ProviderReplayPolicy | undefined {
  const isGoogle = isGoogleModelApi(params.modelApi);
  if (isAnthropicApi(params.modelApi)) {
    return {
      ...buildAnthropicReplayPolicyForModel(
        params.modelId ?? undefined,
        params.model,
        params.inHistorySystemUpdates,
      ),
      ...(modelDisablesReasoningEffort(params.model) ? { dropThinkingBlocks: true } : {}),
    };
  }
  const isStrictOpenAiCompatible = params.modelApi === "openai-completions";
  const isOpenAiResponses = isOpenAiResponsesCompatibleApi(params.modelApi);
  const requiresOpenAiCompatibleToolIdSanitization = isStrictOpenAiCompatible || isOpenAiResponses;

  if (!isGoogle && !requiresOpenAiCompatibleToolIdSanitization) {
    return undefined;
  }

  const modelId = normalizeLowercaseStringOrEmpty(params.modelId);
  const isClaudeOpenAiResponses =
    isOpenAiResponses && /(?:^|[./:_-])claude(?:$|[./:_-])/.test(modelId);
  return {
    sanitizeMode: isGoogle ? "full" : undefined,
    sanitizeToolCallIds: true,
    toolCallIdMode: "strict",
    sanitizeThoughtSignatures: isGoogle
      ? {
          allowBase64Only: true,
          includeCamelCase: true,
        }
      : undefined,
    dropReasoningFromHistory: isStrictOpenAiCompatible
      ? params.model?.reasoning !== true && !requiresReasoningContentReplay(params.modelId)
      : undefined,
    applyAssistantFirstOrderingFix: isGoogle || isStrictOpenAiCompatible ? true : undefined,
    validateGeminiTurns: isGoogle || isStrictOpenAiCompatible ? true : undefined,
    validateAnthropicTurns: isStrictOpenAiCompatible || isClaudeOpenAiResponses ? true : undefined,
    allowSyntheticToolResults: isGoogle || isOpenAiResponses ? true : undefined,
  };
}

const REASONING_CONTENT_REPLAY_MODEL_IDS = new Set([
  "kimi-for-coding",
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
  "kimi-k3",
  "kimi-k2-thinking",
  "kimi-k2-thinking-turbo",
  "mimo-v2-pro",
  "mimo-v2-omni",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro",
  "mimo-v2.6-pro-ultraspeed",
]);

function requiresReasoningContentReplay(modelId: string | null | undefined): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  if (!normalized) {
    return false;
  }
  const parts = normalized.split("/").filter(Boolean);
  const finalPart = parts[parts.length - 1] ?? normalized;
  const candidates = [finalPart];
  const colonParts = finalPart.split(":").filter(Boolean);
  if (colonParts.length > 1) {
    candidates.push(colonParts[0] ?? "", colonParts[colonParts.length - 1] ?? "");
  }
  return candidates.some((candidate) => REASONING_CONTENT_REPLAY_MODEL_IDS.has(candidate));
}

function mergeTranscriptPolicy(
  policy: ProviderReplayPolicy | undefined,
  modelApi: string | null | undefined,
): TranscriptPolicy {
  const merged = {
    ...DEFAULT_TRANSCRIPT_POLICY,
    // Exact-entry caches need earlier temporal carriers to remain in the request prefix.
    appendOnlyRuntimeContext: modelApi === "openai-completions" || modelApi === "ollama",
  };
  for (const [key, value] of Object.entries(policy ?? {})) {
    if (value != null) {
      Object.assign(merged, {
        [key === "applyAssistantFirstOrderingFix" ? "applyGoogleTurnOrdering" : key]: value,
      });
    }
  }
  return merged;
}

/**
 * Resolves the effective replay policy for a provider/model tuple on every call.
 *
 * Deliberately uncached: the previous config-keyed memo served policies from whichever plugin
 * package owned the provider at first resolution, and its fingerprint ignored the installed
 * plugin inventory, so an in-process plugin package swap (e.g. the setup-inference Codex
 * generation install, which clears the loader/metadata caches via
 * `invalidatePluginRuntimeDiscoveryAfterConfigMutation`) kept replaying with the previous
 * package's policy until the config object itself was replaced. Plugin hook invocation is cheap
 * and registry lookups reuse the current runtime snapshots, so resolving fresh on every call
 * keeps policy ownership current.
 */
export function resolveTranscriptPolicy(params: {
  modelApi?: string | null;
  provider?: string | null;
  modelId?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  model?: ProviderRuntimeModel;
  runtimeHandle?: ProviderRuntimePluginHandle;
  directApiKey?: boolean;
}): TranscriptPolicy {
  const provider = normalizeProviderId(params.provider ?? "");
  const runtimePlugin =
    params.runtimeHandle?.plugin ??
    (provider
      ? resolveProviderRuntimePlugin({
          provider,
          modelId: params.modelId,
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: params.env,
        })
      : undefined);
  const context = {
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    provider,
    modelId: params.modelId ?? "",
    modelApi: params.modelApi,
    model: params.model,
    inHistorySystemUpdates:
      supportsNativeOpenAIResponsesEndpoint({
        provider,
        api: params.modelApi ?? "",
        baseUrl: params.model?.baseUrl,
      }) ||
      (params.directApiKey === true &&
        params.modelApi === "anthropic-messages" &&
        isDirectAnthropicModel({ provider, baseUrl: params.model?.baseUrl }, params.env) &&
        supportsClaudeInHistorySystemMessages({
          id: params.modelId ?? undefined,
          params: params.model?.params,
        })),
  };

  // Provider hooks replace the fallback and can override the shared retention default.
  const buildReplayPolicy = runtimePlugin?.buildReplayPolicy;
  const policy = mergeTranscriptPolicy(
    buildReplayPolicy
      ? (buildReplayPolicy(context) ?? undefined)
      : buildUnownedProviderTransportReplayFallback(context),
    params.modelApi,
  );
  if (policy.inHistorySystemUpdates) {
    policy.inHistorySystemUpdates = context.inHistorySystemUpdates;
    policy.appendOnlyRuntimeContext ||= context.inHistorySystemUpdates;
  }
  return policy;
}
