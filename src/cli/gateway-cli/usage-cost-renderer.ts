import { colorize, theme } from "../../../packages/terminal-core/src/theme.js";
import { formatMissingCostEntries } from "../../infra/session-cost-usage-totals.js";
import type { CostUsageSummary } from "../../infra/session-cost-usage.types.js";
import {
  formatCostUsageCachePrefix,
  formatTokenCount,
  formatUsd,
} from "../../utils/usage-format.js";

export function renderGatewayCostUsageSummary(
  summary: CostUsageSummary,
  days: number,
  rich: boolean,
): string[] {
  const formatTotals = (totals: CostUsageSummary["totals"]) => {
    const known = `${formatUsd(totals.totalCost) ?? "$0.00"} · ${formatTokenCount(totals.totalTokens) ?? "0"} tokens`;
    return totals.usageReport?.state === "unavailable"
      ? `unavailable (known subtotal: ${known})`
      : known;
  };
  const cachePrefix = formatCostUsageCachePrefix(summary.cacheStatus);
  const lines = [
    colorize(rich, theme.heading, `Usage cost (${days} days)`),
    `${cachePrefix}${colorize(rich, theme.muted, "Total:")} ${formatTotals(summary.totals)}`,
  ];

  if (summary.totals.missingCostEntries > 0) {
    lines.push(
      `${colorize(rich, theme.muted, "Missing cost:")} ${formatMissingCostEntries(summary.totals)}`,
    );
  }

  const latest = summary.daily.at(-1);
  if (latest) {
    lines.push(
      `${colorize(rich, theme.muted, "Latest day:")} ${latest.date} · ${formatTotals(latest)}`,
    );
  }

  return lines;
}
