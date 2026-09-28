// Builds memory flush prompts when conversation context exceeds model budget.
import { resolveAnthropicServerCompactionPlan } from "@openclaw/ai/internal/anthropic";
import { resolveOpenAIResponsesServerCompactionPlan } from "@openclaw/ai/internal/openai-responses-payload-policy";
import { resolveModelExtraParamSources } from "../../agents/model-extra-params.js";
import { normalizeStaticProviderModelId } from "../../agents/model-ref-shared.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { parseNonNegativeByteSize } from "../../config/byte-size.js";
import {
  findConfiguredProviderModel,
  resolveMergedModelProviderConfig,
} from "../../config/model-provider-config.js";
import { resolveFreshSessionTotalTokens, type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function resolveMaxActiveTranscriptBytes(cfg?: OpenClawConfig): number | undefined {
  const parsed = parseNonNegativeByteSize(
    cfg?.agents?.defaults?.compaction?.maxActiveTranscriptBytes,
  );
  return typeof parsed === "number" && parsed > 0 ? parsed : undefined;
}

function resolvePositiveTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

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

/** Resolves the blocking threshold using the selected reserve and server floor. */
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
  if (normalizedProvider === "anthropic") {
    return resolveAnthropicServerCompactionPlan(
      {
        provider,
        api: configuredModel?.api ?? providerConfig?.api ?? "anthropic-messages",
        baseUrl: configuredModel?.baseUrl ?? providerConfig?.baseUrl,
        contextWindow: configuredModel?.contextWindow ?? params.contextWindowTokens,
      },
      extraParams,
    ).threshold;
  }
  const defaultOpenAIBaseUrl =
    normalizedProvider === "openai" ? "https://api.openai.com/v1" : undefined;
  return resolveOpenAIResponsesServerCompactionPlan(
    {
      provider,
      api:
        configuredModel?.api ??
        providerConfig?.api ??
        (normalizedProvider === "openai" ? "openai-responses" : undefined),
      baseUrl: configuredModel?.baseUrl ?? providerConfig?.baseUrl ?? defaultOpenAIBaseUrl,
      compat: configuredModel?.compat,
      contextTokens: configuredModel?.contextTokens ?? params.contextWindowTokens,
      contextWindow: configuredModel?.contextWindow ?? params.contextWindowTokens,
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
  const totalTokens =
    resolvePositiveTokenCount(params.tokenCount) ?? resolveFreshSessionTotalTokens(params.entry);
  return (
    typeof totalTokens === "number" &&
    totalTokens > 0 &&
    params.threshold > 0 &&
    totalTokens >= params.threshold
  );
}

/**
 * Returns true when a memory flush has already been performed for the current
 * compaction cycle. This prevents repeated flush runs within the same cycle —
 * important for both the token-based and transcript-size–based trigger paths.
 */
export function hasAlreadyFlushedForCurrentCompaction(
  entry: Pick<SessionEntry, "compactionCount" | "memoryFlush">,
): boolean {
  const compactionCount = entry.compactionCount ?? 0;
  const lastFlushAt = entry.memoryFlush?.compactionCount;
  return typeof lastFlushAt === "number" && lastFlushAt === compactionCount;
}
