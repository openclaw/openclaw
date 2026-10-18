import type { PluginHookReplyUsageState } from "../../plugins/hook-types.js";
import type { UsageContract } from "./translator.js";

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

export function buildUsageContract(
  state: PluginHookReplyUsageState,
  surface?: string,
): UsageContract {
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
    typeof state.contextUsedTokens === "number" && state.contextUsedTokens > 0
      ? state.contextUsedTokens
      : promptTotal > 0
        ? promptTotal
        : undefined;
  const pctUsed =
    maxTokens && usedTokens !== undefined ? Math.round((usedTokens / maxTokens) * 100) : undefined;

  const overrideSource = state.overrideSource ?? null;
  const isOverride =
    typeof state.overrideSource === "string" &&
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
      fast_mode: typeof state.fastMode === "boolean" ? state.fastMode : null,
      compactions: typeof state.compactionCount === "number" ? state.compactionCount : null,
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
      turn_usd: typeof state.turnUsd === "number" ? state.turnUsd : null,
      available: typeof state.turnUsd === "number",
    },
    timing: {
      duration_ms: typeof state.durationMs === "number" ? state.durationMs : null,
    },
    identity: {
      name: state.identity?.name ?? null,
      emoji: state.identity?.emoji ?? null,
      avatar: state.identity?.avatar ?? null,
    },
    session: { id: state.sessionId ?? null },
  };
}
