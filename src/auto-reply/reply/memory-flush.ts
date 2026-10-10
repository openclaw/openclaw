import { resolveAnthropicServerCompactionPlan } from "@openclaw/ai/internal/anthropic";
import { resolveOpenAIResponsesServerCompactionPlan } from "@openclaw/ai/internal/openai-responses-payload-policy";
import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { estimateMessagesTokens } from "../../agents/compaction.js";
import { resolveModelExtraParamSources } from "../../agents/model-extra-params.js";
import { normalizeStaticProviderModelId } from "../../agents/model-ref-shared.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import {
  findConfiguredProviderModel,
  resolveMergedModelProviderConfig,
} from "../../config/model-provider-config.js";
import { resolveFreshSessionTotalTokens, type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function resolveEffectivePromptTokens(
  basePromptTokens?: number,
  lastOutputTokens?: number,
  promptTokenEstimate?: number,
): number {
  const base = Math.max(0, basePromptTokens ?? 0);
  const output = Math.max(0, lastOutputTokens ?? 0);
  const estimate = Math.max(0, promptTokenEstimate ?? 0);
  // Flush gating projects the next input context by adding the previous
  // completion and the current user prompt estimate.
  return base + output + estimate;
}

export function estimatePromptTokensForMemoryFlush(prompt?: string): number | undefined {
  const trimmed = normalizeOptionalString(prompt);
  if (!trimmed) {
    return undefined;
  }
  const message: AgentMessage = { role: "user", content: trimmed, timestamp: Date.now() };
  const tokens = asPositiveFiniteNumber(estimateMessagesTokens([message]));
  return tokens === undefined ? undefined : Math.ceil(tokens);
}

export function resolveCompactionThreshold(params: {
  contextWindowTokens: number;
  reserveTokensFloor: number;
  minimumThresholdTokens?: number;
}): number {
  const contextWindow = Math.max(1, Math.floor(params.contextWindowTokens));
  const reserveTokens = Math.max(0, Math.floor(params.reserveTokensFloor));
  return Math.max(0, contextWindow - reserveTokens, Math.floor(params.minimumThresholdTokens ?? 0));
}

export function resolveResponsesServerCompactionThreshold(params: {
  contextWindowTokens: number;
  cfg?: OpenClawConfig;
  provider?: string;
  modelId?: string;
}): number | undefined {
  const provider = params.provider?.trim();
  const modelId = params.modelId?.trim();
  if (!provider || !modelId) {
    return undefined;
  }
  const normalizedProvider = normalizeProviderId(provider);
  const normalizeModelId = (value: string) =>
    normalizeStaticProviderModelId(normalizedProvider, value).trim().toLowerCase();
  const providerConfig = resolveMergedModelProviderConfig(params.cfg, provider);
  const configuredModel = findConfiguredProviderModel(
    providerConfig,
    provider,
    modelId,
    normalizeModelId,
  );
  const { defaultParams, modelParams } = resolveModelExtraParamSources({
    config: params.cfg,
    provider,
    modelId,
  });
  const extraParams = { ...defaultParams, ...modelParams };
  const compactionModel = {
    provider,
    api: configuredModel?.api ?? providerConfig?.api,
    baseUrl: configuredModel?.baseUrl ?? providerConfig?.baseUrl,
    contextWindow: configuredModel?.contextWindow ?? params.contextWindowTokens,
  };
  if (normalizedProvider === "anthropic") {
    return resolveAnthropicServerCompactionPlan(
      { ...compactionModel, api: compactionModel.api ?? "anthropic-messages" },
      extraParams,
    ).threshold;
  }
  return resolveOpenAIResponsesServerCompactionPlan(
    {
      ...compactionModel,
      api:
        compactionModel.api ?? (normalizedProvider === "openai" ? "openai-responses" : undefined),
      baseUrl:
        compactionModel.baseUrl ??
        (normalizedProvider === "openai" ? "https://api.openai.com/v1" : undefined),
      compat: configuredModel?.compat,
      contextTokens: configuredModel?.contextTokens ?? params.contextWindowTokens,
    },
    extraParams,
  ).threshold;
}

export function shouldRunMemoryFlush(params: {
  entry?: Pick<
    SessionEntry,
    "totalTokens" | "totalTokensFresh" | "totalTokensVersion" | "compactionCount" | "memoryFlush"
  >;
  /**
   * Optional token count override for flush gating. When provided, this value is
   * treated as a fresh context snapshot and used instead of the cached
   * SessionEntry.totalTokens (which may be stale/unknown).
   */
  tokenCount?: number;
  threshold: number;
}): boolean {
  return Boolean(
    shouldRunPreflightCompaction(params) &&
    params.entry &&
    !hasAlreadyFlushedForCurrentCompaction(params.entry),
  );
}

export function shouldRunPreflightCompaction(params: {
  entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh" | "totalTokensVersion">;
  /**
   * Optional projected token count override for pre-run compaction gating.
   * When provided, this value is treated as a fresh estimate and used instead
   * of any cached SessionEntry total.
   */
  tokenCount?: number;
  threshold: number;
}): boolean {
  if (!params.entry) {
    return false;
  }
  const projectedTokens = asPositiveFiniteNumber(params.tokenCount);
  const totalTokens =
    projectedTokens === undefined
      ? resolveFreshSessionTotalTokens(params.entry)
      : Math.floor(projectedTokens);
  return (
    typeof totalTokens === "number" &&
    totalTokens > 0 &&
    params.threshold > 0 &&
    totalTokens >= params.threshold
  );
}

/** One flush per compaction cycle, regardless of token or transcript-size trigger. */
export function hasAlreadyFlushedForCurrentCompaction(
  entry: Pick<SessionEntry, "compactionCount" | "memoryFlush">,
): boolean {
  const compactionCount = entry.compactionCount ?? 0;
  const lastFlushAt = entry.memoryFlush?.compactionCount;
  return typeof lastFlushAt === "number" && lastFlushAt === compactionCount;
}
