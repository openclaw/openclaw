import { expectDefined } from "@openclaw/normalization-core";
import { hasBillableUsage, hasNonzeroUsage, type NormalizedUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginHookReplyUsageState } from "../../plugins/hook-types.js";
import {
  estimateAggregateUsageCost,
  formatTokenCount,
  formatUsd,
} from "../../utils/usage-format.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import { resolveEffectiveResponseUsage } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { loadUsageBarTemplate } from "../usage-bar/template.js";
import { renderUsageBar, type UsageContract } from "../usage-bar/translator.js";

function projectUsage(usage: NonNullable<PluginHookReplyUsageState["usage"]>) {
  const promptTotal = (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.input ?? 0);
  return {
    promptTotal,
    tokens: {
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_read_tokens: usage.cacheRead,
      cache_write_tokens: usage.cacheWrite,
      total_tokens: usage.total,
      cache_hit_pct:
        promptTotal > 0 ? Math.round(((usage.cacheRead ?? 0) / promptTotal) * 100) : undefined,
    },
  };
}

function buildUsageContract(state: PluginHookReplyUsageState, surface?: string): UsageContract {
  const usage = state.usage ?? {};
  const { input, output, cacheRead, cacheWrite, total } = usage;
  const hasSplitTokens = input !== undefined || output !== undefined;
  const hasTotalOnlyTokens = !hasSplitTokens && total !== undefined;
  const hasTokens =
    hasSplitTokens || cacheRead !== undefined || cacheWrite !== undefined || total !== undefined;

  const { promptTotal, tokens } = projectUsage(usage);
  const last = state.lastUsage;

  const maxTokens = state.contextTokenBudget;
  const usedTokens =
    state.contextUsedTokens !== undefined && state.contextUsedTokens > 0
      ? state.contextUsedTokens
      : promptTotal > 0
        ? promptTotal
        : undefined;
  const pctUsed =
    maxTokens && usedTokens !== undefined ? Math.round((usedTokens / maxTokens) * 100) : undefined;

  const overrideSource = state.overrideSource ?? null;
  const isOverride =
    state.overrideSource !== undefined &&
    state.overrideSource !== "" &&
    state.overrideSource !== "auto";

  return {
    schema: "openclaw.usageLine.v1",
    surface: surface ?? null,
    agentId: state.agentId ?? null,
    chat_type: state.chatType ?? null,
    model: {
      id: state.model ?? null,
      display_name: state.model ?? null,
      provider: state.provider ?? null,
      reasoning: state.reasoningEffort ?? null,
      actual: state.resolvedRef ?? null,
      resolved_ref: state.resolvedRef ?? null,
      requested: state.requested ?? null,
      is_fallback: state.fallbackUsed === true,
      is_override: isOverride,
      override_source: overrideSource,
      auth_mode: state.authMode ?? null,
    },
    state: {
      fast_mode: state.fastMode ?? null,
      compactions: state.compactionCount ?? null,
    },
    usage: {
      ...tokens,
      has_tokens: hasTokens,
      has_split_tokens: hasSplitTokens,
      has_total_only_tokens: hasTotalOnlyTokens,
      last: last ? projectUsage(last).tokens : undefined,
    },
    context: {
      used_tokens: usedTokens,
      max_tokens: maxTokens,
      pct_used: pctUsed,
    },
    cost: {
      turn_usd: state.turnUsd ?? null,
      available: state.turnUsd !== undefined,
    },
    timing: {
      duration_ms: state.durationMs ?? null,
    },
    identity: {
      name: state.identity?.name ?? null,
      emoji: state.identity?.emoji ?? null,
      avatar: state.identity?.avatar ?? null,
    },
    session: { id: state.sessionId ?? null },
  };
}

const formatResponseUsageLine = (
  params: Parameters<typeof estimateAggregateUsageCost>[0] & {
    showCost: boolean;
  },
): string | null => {
  const usage = params.usage;
  if (!usage) {
    return null;
  }
  const input = usage.input;
  const output = usage.output;
  const hasSplitTokens = input !== undefined || output !== undefined;
  const inputLabel = input !== undefined ? formatTokenCount(input) : "?";
  const outputLabel = output !== undefined ? formatTokenCount(output) : "?";
  const totalLabel =
    !hasSplitTokens && usage.total !== undefined
      ? `${formatTokenCount(usage.total)} total`
      : undefined;
  const cacheRead = usage.cacheRead;
  const cacheWrite = usage.cacheWrite;
  const canPriceUsage = usage.cost !== undefined || (input !== undefined && output !== undefined);
  const cost = params.showCost && canPriceUsage ? estimateAggregateUsageCost(params) : undefined;
  const costLabel = params.showCost ? formatUsd(cost) : undefined;
  const cacheSuffix =
    (cacheRead ?? 0) > 0 || (cacheWrite ?? 0) > 0
      ? ` · cache ${formatTokenCount(cacheRead ?? 0)} cached / ${formatTokenCount(cacheWrite ?? 0)} new`
      : "";
  if (!hasSplitTokens && !totalLabel && !cacheSuffix && !costLabel) {
    return null;
  }
  const suffix = costLabel ? ` · est ${costLabel}` : "";
  return `Usage: ${totalLabel ?? `${inputLabel} in / ${outputLabel} out`}${cacheSuffix}${suffix}`;
};

export const resolveResponseUsageLine = (params: {
  config: OpenClawConfig;
  agentDir: string;
  sessionRaw?: string | null;
  channel?: string;
  usage?: NormalizedUsage;
  provider?: string;
  model?: string;
  preserveUserFacingSessionState?: boolean;
  replyUsageState?: PluginHookReplyUsageState;
}): string | undefined => {
  const responseUsageMode = resolveEffectiveResponseUsage(
    params.sessionRaw,
    params.config.messages?.responseUsage,
    params.channel,
  );
  const showCost = responseUsageMode === "full";
  const hasUsage = showCost ? hasBillableUsage(params.usage) : hasNonzeroUsage(params.usage);
  if (responseUsageMode === "off" || !hasUsage || params.preserveUserFacingSessionState === true) {
    return undefined;
  }

  const formatted = formatResponseUsageLine({
    usage: params.usage,
    showCost,
    provider: params.provider,
    model: params.model,
    config: params.config,
    agentDir: params.agentDir,
    allowPluginNormalization: false,
  });
  const usageTemplate =
    responseUsageMode === "full" && params.replyUsageState
      ? loadUsageBarTemplate(params.config.messages?.usageTemplate)
      : undefined;
  const rendered =
    usageTemplate && params.replyUsageState
      ? renderUsageBar(usageTemplate, buildUsageContract(params.replyUsageState, params.channel))
      : undefined;

  return rendered || formatted || undefined;
};

export const appendUsageLine = (
  payloads: ReplyPayload[],
  line: string,
  options?: { completedSourceReply?: boolean },
): ReplyPayload[] => {
  const sourceReplyIndex = options?.completedSourceReply
    ? payloads.findLastIndex((payload) => {
        const metadata = getReplyPayloadMetadata(payload);
        return (
          Boolean(payload?.text) &&
          Boolean(metadata?.sourceReplyTranscriptMirror) &&
          metadata?.deliverDespiteSourceReplySuppression === true
        );
      })
    : -1;
  if (options?.completedSourceReply && sourceReplyIndex === -1) {
    // The source reply is already visible; keep private final text suppressed.
    const footer = markReplyPayloadForSourceSuppressionDelivery({
      text: line,
      isStatusNotice: true,
    });
    setReplyPayloadMetadata(footer, { responseUsageLine: line });
    return [...payloads, footer];
  }
  const index =
    sourceReplyIndex >= 0 ? sourceReplyIndex : payloads.findLastIndex((payload) => payload?.text);
  if (index === -1) {
    return [...payloads, { text: line, isStatusNotice: true }];
  }
  const existing = expectDefined(payloads[index], "payloads entry at index");
  const existingText = existing.text ?? "";
  const separator = existingText.endsWith("\n") ? "" : "\n";
  const next = copyReplyPayloadMetadata(existing, {
    ...existing,
    text: `${existingText}${separator}${line}`,
  });
  setReplyPayloadMetadata(next, { responseUsageLine: line });
  const mirror = getReplyPayloadMetadata(existing)?.sourceReplyTranscriptMirror;
  // Transcript mirrors must track the mutated text or source-reply delivery drifts.
  if (mirror) {
    setReplyPayloadMetadata(next, {
      sourceReplyTranscriptMirror: { ...mirror, text: next.text },
    });
  }
  const updated = payloads.slice();
  updated[index] = next;
  return updated;
};
