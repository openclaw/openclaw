import type { GatewaySessionRow } from "../../api/types.ts";

/** Gateway projection rejects budgets from a different selection or effective cap. */
export function resolveSessionContextLimit(
  session: Pick<GatewaySessionRow, "contextTokens" | "contextBudgetStatus"> | undefined,
): { tokens: number; fromLastPrompt: boolean } {
  const promptBudget = session?.contextBudgetStatus?.promptBudgetBeforeReserve;
  if (typeof promptBudget === "number" && Number.isFinite(promptBudget) && promptBudget > 0) {
    return { tokens: promptBudget, fromLastPrompt: true };
  }
  return { tokens: session?.contextTokens ?? 0, fromLastPrompt: false };
}
