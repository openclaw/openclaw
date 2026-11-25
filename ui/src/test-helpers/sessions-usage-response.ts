import { createEmptyCostUsageTotals } from "../../../src/infra/session-cost-usage-totals.js";

/** Minimal sessions.usage result with every aggregate the Control UI reads. */
export function sessionsUsageResponse(byProvider: unknown[] = []) {
  return {
    sessions: [],
    totals: createEmptyCostUsageTotals(),
    aggregates: { byProvider, byModel: [], modelDaily: [], daily: [] },
  };
}
