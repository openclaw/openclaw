// Control UI module resolves the context limit that usage is measured against.
import type { GatewaySessionRow } from "../../api/types.ts";

type ContextBudgetSource = Pick<GatewaySessionRow, "contextTokens" | "contextBudgetStatus">;

/**
 * Usage has to be measured against the ceiling the runtime actually enforces,
 * not the model's catalog context window. Reserves (output headroom, tool
 * result truncation margin) shrink the usable space, so a session can be
 * compacting while a catalog-based meter still reads comfortable.
 *
 * `contextTokenBudget` is that enforced ceiling. The catalog value stays as the
 * fallback for sessions that have not produced a budget snapshot yet: a session
 * with no run since start, or a gateway older than the field.
 */
export function resolveEffectiveContextTokens(
  session: ContextBudgetSource | undefined,
  fallback?: number | null,
): number {
  const budget = session?.contextBudgetStatus?.contextTokenBudget;
  if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) {
    return budget;
  }
  return session?.contextTokens ?? fallback ?? 0;
}
