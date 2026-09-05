// Control UI module resolves the context limit that usage is measured against.
import { resolveEffectiveCompactionReserveTokens } from "../../../../src/agents/agent-compaction-constants.js";
import type { GatewaySessionRow } from "../../api/types.ts";

type ContextBudgetSource = Pick<GatewaySessionRow, "contextTokens" | "contextBudgetStatus">;

export type EffectiveContextLimit = {
  /** Token ceiling the displayed usage is measured against. */
  tokens: number;
  /**
   * True when `tokens` is the reserve-adjusted prompt budget, so 100% is the
   * point where the runtime compacts. False when the value is a plain window
   * and 100% only means "out of window".
   */
  reserveAdjusted: boolean;
};

function isPositiveTokenCount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isReserveTokenCount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Widest limit the session's current cap still allows, or `undefined` when the
 * row publishes no cap to bound against.
 *
 * A budget snapshot records the cap it was measured against, and nothing
 * refreshes it while a session sits idle: `buildGatewaySessionRow()` in
 * `src/gateway/session-utils-row.ts` projects the current cap into
 * `contextTokens` on every row but forwards `contextBudgetStatus` unchanged.
 * Lower a model's configured `contextTokens` from 1,000,000 to 200,000 and the
 * retained snapshot still claims a 980,000-token prompt budget, so 160,000
 * tokens would read 16% where the runtime is at 89% of the boundary it will
 * enforce on the next prompt.
 *
 * The authored effective cap owns the current selection
 * (`src/config/sessions/context-token-provenance.ts`), so the snapshot may
 * bound the displayed limit but never widen it past that cap. Re-deriving the
 * prompt budget with the runtime's own reserve rule keeps 100% on the
 * compaction point rather than dropping back to a plain window.
 */
function resolveCurrentCapCeiling(
  contextTokens: number | undefined,
  reserveTokens: number | undefined,
): EffectiveContextLimit | undefined {
  if (!isPositiveTokenCount(contextTokens)) {
    return undefined;
  }
  // Without a recorded reserve there is no honest way to place the compaction
  // point under the cap, so the cap itself is the ceiling and 100% only means
  // "out of window" again.
  if (!isReserveTokenCount(reserveTokens)) {
    return { tokens: contextTokens, reserveAdjusted: false };
  }
  const effectiveReserveTokens = resolveEffectiveCompactionReserveTokens({
    contextTokenBudget: contextTokens,
    reserveTokens,
  });
  return {
    tokens: Math.max(1, contextTokens - effectiveReserveTokens),
    reserveAdjusted: true,
  };
}

/**
 * Usage has to be measured against the boundary the runtime enforces, not the
 * model's catalog context window. `resolveCompactionPressureDecision()` in
 * `src/agents/embedded-agent-runner/run/preemptive-compaction.ts` compacts once
 * the prompt exceeds `promptBudgetBeforeReserve`, which is `contextTokenBudget`
 * minus the effective output reserve. That is the only denominator where 100%
 * marks the compaction point.
 *
 * `contextTokenBudget` is kept as an intermediate step for snapshots that do
 * not carry the prompt budget: it is still the enforced ceiling, so it is
 * closer than the catalog window even though compaction starts below it.
 *
 * The catalog window stays as the last fallback for sessions that have not
 * produced a budget snapshot yet: a session with no run since start, or a
 * gateway older than the field.
 *
 * Every snapshot step is bounded by `resolveCurrentCapCeiling()`, so a budget
 * left over from a wider cap cannot outlive the setting it was measured
 * against. The clamp is deliberately one-directional: a snapshot narrower than
 * the current cap is kept, because that is also what a legitimately tighter
 * runtime budget looks like from the row, and the two are indistinguishable
 * here. Preferring the tighter boundary keeps the meter from reading
 * comfortable while the runtime is already compacting.
 */
export function resolveEffectiveContextLimit(
  session: ContextBudgetSource | undefined,
  fallback?: number | null,
): EffectiveContextLimit {
  const status = session?.contextBudgetStatus;
  const contextTokens = session?.contextTokens;
  const ceiling = resolveCurrentCapCeiling(contextTokens, status?.reserveTokens);
  const promptBudget = status?.promptBudgetBeforeReserve;
  if (isPositiveTokenCount(promptBudget)) {
    return ceiling && ceiling.tokens < promptBudget
      ? ceiling
      : { tokens: promptBudget, reserveAdjusted: true };
  }
  const contextTokenBudget = status?.contextTokenBudget;
  if (isPositiveTokenCount(contextTokenBudget)) {
    // This step reports a plain window, so it is bounded by the cap itself
    // rather than by the reserve-adjusted ceiling: labelling a prompt-only
    // budget "Context window" would be the same lie in the other direction.
    return isPositiveTokenCount(contextTokens) && contextTokens < contextTokenBudget
      ? { tokens: contextTokens, reserveAdjusted: false }
      : { tokens: contextTokenBudget, reserveAdjusted: false };
  }
  return { tokens: contextTokens ?? fallback ?? 0, reserveAdjusted: false };
}

/** Token ceiling only, for callers that render no limit label. */
export function resolveEffectiveContextTokens(
  session: ContextBudgetSource | undefined,
  fallback?: number | null,
): number {
  return resolveEffectiveContextLimit(session, fallback).tokens;
}
