import {
  addCostUsageTotals,
  createEmptyCostUsageTotals,
} from "../infra/session-cost-usage-totals.js";
import type { CostUsageTotals } from "../infra/session-cost-usage.types.js";
import type { SessionUsageEntry, UsageOverviewOptions } from "./usage-types.js";

export const USAGE_OVERVIEW_PAGE_SIZE = 50;

export function sessionRowTotals(
  session: SessionUsageEntry,
  days: ReadonlySet<string>,
): CostUsageTotals {
  const usage = session.usage;
  if (!days.size || !usage?.dailyBreakdown?.length) {
    return usage ?? createEmptyCostUsageTotals();
  }
  const totals = createEmptyCostUsageTotals();
  for (const day of usage.dailyBreakdown) {
    if (days.has(day.date)) {
      addCostUsageTotals(totals, { ...day, totalTokens: day.tokens, totalCost: day.cost });
    }
  }
  return totals;
}
function compareUsageOverviewSessions(
  options: UsageOverviewOptions,
  sortValue?: (entry: SessionUsageEntry) => number | undefined,
) {
  if (options.recentKeys) {
    const recentKeys = options.recentKeys;
    return (a: SessionUsageEntry, b: SessionUsageEntry) =>
      recentKeys.indexOf(a.key) - recentKeys.indexOf(b.key);
  }
  const days = new Set(options.selectedDays);
  const rowTotals = new Map<SessionUsageEntry, ReturnType<typeof sessionRowTotals>>();
  const sortValues = sortValue ? new Map<SessionUsageEntry, number | undefined>() : undefined;
  const totals = (entry: SessionUsageEntry) => {
    let result = rowTotals.get(entry);
    if (!result) {
      result = sessionRowTotals(entry, days);
      rowTotals.set(entry, result);
    }
    return result;
  };
  const value = (entry: SessionUsageEntry) => {
    if (sortValue && sortValues) {
      if (!sortValues.has(entry)) {
        sortValues.set(entry, sortValue(entry));
      }
      const prepared = sortValues.get(entry);
      if (prepared !== undefined) {
        return prepared;
      }
    }
    switch (options.sort) {
      case "tokens":
        return totals(entry).totalTokens;
      case "cost":
        return totals(entry).totalCost;
      case "messages":
        return entry.usage?.messageCounts?.total ?? 0;
      case "errors":
        return entry.usage?.messageCounts?.errors ?? 0;
      default:
        return entry.updatedAt ?? 0;
    }
  };
  const direction = options.sortDirection === "asc" ? -1 : 1;
  return (a: SessionUsageEntry, b: SessionUsageEntry) =>
    direction *
    (value(b) - value(a) ||
      (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
      (a.label || a.key).localeCompare(b.label || b.key));
}

/** Page an already-filtered roster, optionally reading metrics from its packed usage. */
export function usageOverviewPage(
  roster: SessionUsageEntry[],
  options: UsageOverviewOptions,
  sortValue?: (entry: SessionUsageEntry) => number | undefined,
) {
  if (options.limit === 0) {
    return [];
  }
  return roster
    .toSorted(compareUsageOverviewSessions(options, sortValue))
    .slice(
      options.offset ?? 0,
      (options.offset ?? 0) + (options.limit ?? USAGE_OVERVIEW_PAGE_SIZE),
    );
}
