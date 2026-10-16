import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { resolveAgentIdentity } from "../../agents/identity.js";
import { deriveContextPromptTokens, type NormalizedUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/config.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { PluginHookReplyUsageState } from "../../plugins/hook-types.js";
import { estimateAggregateUsageCost } from "../../utils/usage-format.js";

const TTL_MS = 5 * 60_000;
const MAX_REPLY_USAGE_STATE_ENTRIES = 1_024;

const store = new Map<string, { snapshot: PluginHookReplyUsageState; expiresAt: number }>();

function projectHookUsage(usage?: NormalizedUsage): PluginHookReplyUsageState["usage"] {
  if (!usage) {
    return undefined;
  }
  const { input, output, cacheRead, cacheWrite, total } = usage;
  return { input, output, cacheRead, cacheWrite, total };
}

export function buildReplyUsageState(
  params: Omit<
    PluginHookReplyUsageState,
    "resolvedRef" | "requested" | "turnUsd" | "identity" | "usage" | "lastUsage"
  > & {
    config: OpenClawConfig;
    agentDir: string;
    agentId: string;
    sessionId: string;
    fallbackExhausted?: boolean;
    winnerProvider?: string;
    winnerModel?: string;
    requestedProvider?: string;
    requestedModel?: string;
    promptTokens?: number;
    usage?: NormalizedUsage;
    lastCallUsage?: NormalizedUsage;
  },
): PluginHookReplyUsageState {
  const resolvedProvider = params.fallbackExhausted ? undefined : params.winnerProvider;
  const resolvedModel = params.fallbackExhausted ? undefined : params.winnerModel;
  return {
    provider: params.provider,
    model: params.model,
    resolvedRef:
      resolvedProvider && resolvedModel ? `${resolvedProvider}/${resolvedModel}` : undefined,
    reasoningEffort: params.reasoningEffort,
    fastMode: params.fastMode,
    fallbackUsed: params.fallbackUsed,
    agentId: params.agentId,
    sessionId: params.sessionId,
    chatType: params.chatType,
    authMode: params.authMode,
    overrideSource: params.overrideSource,
    requested:
      params.requestedProvider && params.requestedModel
        ? `${params.requestedProvider}/${params.requestedModel}`
        : undefined,
    turnUsd: estimateAggregateUsageCost({
      usage: params.usage,
      provider: params.provider,
      model: params.model,
      config: params.config,
      agentDir: params.agentDir,
    }),
    durationMs: params.durationMs,
    identity: resolveAgentIdentity(params.config, params.agentId),
    compactionCount: params.compactionCount,
    contextTokenBudget: asFiniteNumber(params.contextTokenBudget),
    contextUsedTokens:
      asFiniteNumber(params.contextUsedTokens) ??
      deriveContextPromptTokens({
        lastCallUsage: params.lastCallUsage,
        promptTokens: params.promptTokens,
        usage: params.usage,
      }),
    usage: projectHookUsage(params.usage),
    lastUsage: projectHookUsage(params.lastCallUsage),
  };
}

function prune(now: number): void {
  for (const [key, value] of store) {
    if (value.expiresAt < now) {
      store.delete(key);
    }
  }
  // This handoff is best-effort metadata for an optional hook. Bound bursts so
  // completed runs cannot retain one full snapshot each for the whole TTL.
  pruneMapToMaxSize(store, MAX_REPLY_USAGE_STATE_ENTRIES);
}

export function recordReplyUsageState(
  runId: string | undefined,
  snapshot: PluginHookReplyUsageState,
): void {
  if (!runId) {
    return;
  }
  const now = Date.now();
  store.set(runId, { snapshot, expiresAt: now + TTL_MS });
  prune(now);
}

export function consumeReplyUsageState(runId?: string): PluginHookReplyUsageState | undefined {
  if (!runId) {
    return undefined;
  }
  const value = store.get(runId);
  return value && value.expiresAt >= Date.now() ? value.snapshot : undefined;
}
