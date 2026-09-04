// Control UI module resolves the context limit that usage is measured against.
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
 */
export function resolveEffectiveContextLimit(
  session: ContextBudgetSource | undefined,
  fallback?: number | null,
): EffectiveContextLimit {
  const status = session?.contextBudgetStatus;
  const promptBudget = status?.promptBudgetBeforeReserve;
  if (isPositiveTokenCount(promptBudget)) {
    return { tokens: promptBudget, reserveAdjusted: true };
  }
  const contextTokenBudget = status?.contextTokenBudget;
  if (isPositiveTokenCount(contextTokenBudget)) {
    return { tokens: contextTokenBudget, reserveAdjusted: false };
  }
  return { tokens: session?.contextTokens ?? fallback ?? 0, reserveAdjusted: false };
}

/** Token ceiling only, for callers that render no limit label. */
export function resolveEffectiveContextTokens(
  session: ContextBudgetSource | undefined,
  fallback?: number | null,
): number {
  return resolveEffectiveContextLimit(session, fallback).tokens;
}
