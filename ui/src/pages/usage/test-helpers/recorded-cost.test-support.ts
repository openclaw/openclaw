import {
  addCostUsageTotals,
  cloneCostUsageTotals,
  createEmptyCostUsageTotals,
} from "../../../../../src/infra/session-cost-usage-totals.js";
import { usageSession } from "../view.test-support.ts";

export function createRecordedCostUsage(updatedAt = Date.UTC(2026, 4, 14, 12)) {
  const sessions = [
    { label: "Known zero", totalCost: 0, missingCostEntries: 0 },
    { label: "Known positive", totalCost: 0.2, missingCostEntries: 0 },
    { label: "Unpriced usage", totalCost: 0, missingCostEntries: 1 },
  ].map(({ label, totalCost, missingCostEntries }, index) => {
    const session = usageSession(`agent:main:cost-hint-${index}`, "main", "fixture", {
      totalCost,
      inputCost: totalCost,
      outputCost: 0,
      missingCostEntries,
    });
    session.label = label;
    session.updatedAt = updatedAt - index * 86_400_000;
    return session;
  });
  const totals = createEmptyCostUsageTotals();
  const costDaily = sessions
    .map((session) => {
      const usage = session.usage!;
      const timestamp = session.updatedAt!;
      const date = new Date(timestamp).toISOString().slice(0, 10);
      const day = { date, ...cloneCostUsageTotals(usage) };
      usage.activityDates = [date];
      usage.firstActivity = timestamp - 1_000;
      usage.lastActivity = timestamp;
      usage.durationMs = 1_000;
      usage.dailyBreakdown = [{ ...day, tokens: day.totalTokens, cost: day.totalCost }];
      addCostUsageTotals(totals, usage);
      return day;
    })
    .toSorted((a, b) => a.date.localeCompare(b.date));
  return { sessions, totals, costDaily };
}
