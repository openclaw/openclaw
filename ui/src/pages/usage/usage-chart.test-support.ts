import type { CostDailyEntry, UsageTotals } from "./types.ts";

export const totals: UsageTotals = {
  input: 100,
  output: 40,
  cacheRead: 300,
  cacheWrite: 600,
  totalTokens: 1040,
  totalCost: 0,
  inputCost: 0,
  outputCost: 0,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  missingCostEntries: 0,
};

export function dailyEntry(date: string, totalTokens: number, totalCost = 0): CostDailyEntry {
  return {
    ...totals,
    date,
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    totalCost,
  };
}
