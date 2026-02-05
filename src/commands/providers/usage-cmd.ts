/**
 * Provider usage command implementation.
 * Shows LLM usage statistics by provider/model.
 */

import type { RuntimeEnv } from "../../runtime.js";
import type { UsagePeriod } from "./types.js";
import { defaultRuntime } from "../../runtime.js";
import { renderTable, type TableColumn } from "../../terminal/table.js";
import { theme, isRich } from "../../terminal/theme.js";
import { formatUsageForDisplay, getUsage, isUsageTrackingAvailable } from "./usage.js";

export type ProvidersUsageOptions = {
  /** Time period for aggregation */
  period?: UsagePeriod;
  /** Filter by provider ID */
  provider?: string;
  /** Filter by model ID */
  model?: string;
  /** Output as JSON */
  json?: boolean;
  /** Plain output (no colors/formatting) */
  plain?: boolean;
};

const VALID_PERIODS: UsagePeriod[] = ["today", "week", "month", "all"];

export async function providersUsageCommand(
  opts: ProvidersUsageOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  // Validate period
  const period = opts.period ?? "all";
  if (!VALID_PERIODS.includes(period)) {
    runtime.error(`Invalid period: ${period}. Valid values: ${VALID_PERIODS.join(", ")}`);
    runtime.exit(1);
    return;
  }

  // Check if tracking infrastructure is available
  const availability = await isUsageTrackingAvailable();
  if (!availability.database) {
    if (opts.json) {
      runtime.log(
        JSON.stringify({
          error: "Database not available",
          message: "Usage tracking requires PostgreSQL. Start with: docker compose up -d postgres",
        }),
      );
    } else {
      runtime.error("Usage tracking requires PostgreSQL connection.");
      runtime.log(theme.muted("Start the database with: docker compose up -d postgres"));
      runtime.log(theme.muted("Or configure POSTGRES_HOST, POSTGRES_PORT, etc."));
    }
    runtime.exit(1);
    return;
  }

  // Query usage
  const { usage, totals } = await getUsage({
    period,
    providerId: opts.provider,
    modelId: opts.model,
  });

  if (opts.json) {
    runtime.log(JSON.stringify({ usage, totals, period }, null, 2));
    return;
  }

  if (opts.plain) {
    for (const u of usage) {
      runtime.log(
        `${u.providerId}\t${u.modelId}\t${u.requests}\t${u.inputTokens}\t${u.outputTokens}\t${u.estimatedCost.toFixed(4)}`,
      );
    }
    runtime.log(
      `TOTAL\t-\t${totals.requests}\t${totals.inputTokens}\t${totals.outputTokens}\t${totals.estimatedCost.toFixed(4)}`,
    );
    return;
  }

  if (usage.length === 0) {
    runtime.log(theme.muted(`No usage data for period: ${period}`));
    if (period !== "all") {
      runtime.log(theme.muted("Try --period all to see all-time usage."));
    }
    return;
  }

  const rich = isRich();
  const periodLabel = formatPeriodLabel(period);

  runtime.log("");
  runtime.log(rich ? theme.heading(`LLM Usage (${periodLabel})`) : `## LLM Usage (${periodLabel})`);
  runtime.log("");

  const formatted = formatUsageForDisplay(usage);
  const rows = formatted.rows.map((row) => ({
    provider: rich ? theme.accent(row.provider) : row.provider,
    model: row.model,
    requests: rich ? theme.info(row.requests) : row.requests,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cost: rich ? theme.success(row.cost) : row.cost,
  }));

  const columns: TableColumn[] = [
    { key: "provider", header: "Provider", minWidth: 14 },
    { key: "model", header: "Model", minWidth: 24, flex: true },
    { key: "requests", header: "Requests", minWidth: 10, align: "right" },
    { key: "inputTokens", header: "Input Tokens", minWidth: 14, align: "right" },
    { key: "outputTokens", header: "Output Tokens", minWidth: 14, align: "right" },
    { key: "cost", header: "Cost (USD)", minWidth: 12, align: "right" },
  ];

  const table = renderTable({ columns, rows, border: "none" });
  runtime.log(table);

  // Totals row
  runtime.log("");
  const divider = "─".repeat(80);
  runtime.log(rich ? theme.muted(divider) : divider);

  const totalRow = [
    rich ? theme.heading("TOTAL") : "TOTAL",
    "",
    rich ? theme.info(formatted.totals.requests) : formatted.totals.requests,
    formatted.totals.inputTokens,
    formatted.totals.outputTokens,
    rich ? theme.success(formatted.totals.cost) : formatted.totals.cost,
  ];
  runtime.log(
    `${totalRow[0].padEnd(14)} ${totalRow[1].padEnd(24)} ${totalRow[2].padStart(10)} ${totalRow[3].padStart(14)} ${totalRow[4].padStart(14)} ${totalRow[5].padStart(12)}`,
  );

  runtime.log("");
}

function formatPeriodLabel(period: UsagePeriod): string {
  switch (period) {
    case "today":
      return "Today";
    case "week":
      return "Last 7 Days";
    case "month":
      return "Last 30 Days";
    case "all":
      return "All Time";
  }
}
