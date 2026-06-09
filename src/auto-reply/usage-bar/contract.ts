// Build the `openclaw.usageLine.v1` contract that the translator consumes from
// the per-turn `reply_payload_sending` usage snapshot. This is the in-core port
// of the usage-footer plugin's `buildContract`, so the same template renders
// identically whether driven by the plugin or by the native /usage full path.
import type { PluginHookReplyUsageState } from "../../plugins/hook-types.js";
import type { UsageContract } from "./translator.js";

export function buildUsageContract(
  state: PluginHookReplyUsageState,
  surface?: string,
): UsageContract {
  const usage = state.usage ?? {};
  const input = usage.input;
  const output = usage.output;
  const cacheRead = usage.cacheRead;
  const cacheWrite = usage.cacheWrite;
  const total = usage.total;

  // cache_hit_pct: cacheRead only (writes are misses being cached). Matches
  // core status-message.ts.
  const promptTotal = (cacheRead ?? 0) + (cacheWrite ?? 0) + (input ?? 0);
  const cacheHitPct =
    promptTotal > 0 ? Math.round(((cacheRead ?? 0) / promptTotal) * 100) : undefined;

  // Last-call usage (final model call only) so templates can render the last
  // exchange instead of the turn aggregate. Its cache_hit_pct is computed over
  // the last call's prompt total, same formula as the turn-level one.
  const last = state.lastUsage;
  const lastPromptTotal = last
    ? (last.cacheRead ?? 0) + (last.cacheWrite ?? 0) + (last.input ?? 0)
    : 0;
  const lastCacheHitPct =
    last && lastPromptTotal > 0
      ? Math.round(((last.cacheRead ?? 0) / lastPromptTotal) * 100)
      : undefined;

  const maxTokens = state.contextTokenBudget;
  // Context occupancy is a point-in-time STATE, never an aggregate. Prefer the
  // turn's real end-of-turn context size (final call's prompt tokens); fall back
  // to the aggregate prompt total only for harnesses that don't report it
  // (single-call turns, where the two coincide). The aggregate over a multi-call
  // tool loop overstates occupancy — often past the window — pinning the gauge.
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
    // agentId is exposed flat so templates can key per-agent (e.g. emoji map).
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
      // Turn aggregate: summed across every model call in the turn's tool loop.
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      total_tokens: total,
      cache_hit_pct: cacheHitPct,
      // Final model call only. Templates choose `{usage.input_tokens}` (turn)
      // vs `{usage.last.input_tokens}` (last exchange). Absent → segment drops.
      last: last
        ? {
            input_tokens: last.input,
            output_tokens: last.output,
            cache_read_tokens: last.cacheRead,
            cache_write_tokens: last.cacheWrite,
            total_tokens: last.total,
            cache_hit_pct: lastCacheHitPct,
          }
        : undefined,
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
    ...(state.limits ? { limits: state.limits } : {}),
  };
}
