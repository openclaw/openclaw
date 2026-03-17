import type { OpenClawConfig } from "../config/config.js";
import { readCronRunLogEntriesPageAll } from "../cron/run-log.js";
import { resolveCronStorePath } from "../cron/store.js";
import type { CostUsageSummary, CostUsageTotals } from "../infra/session-cost-usage.js";
import { loadCostUsageSummary } from "../infra/session-cost-usage.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { formatTokenCount, formatUsd } from "../utils/usage-format.js";

// Source labels for breakdown display
const SOURCE_LABELS: Record<string, string> = {
  cron: "cron",
  direct: "direct",
};

export type UsageCommandOptions = {
  today?: boolean;
  week?: boolean;
  month?: boolean;
  bySource?: boolean;
  json?: boolean;
  agent?: string;
  config?: OpenClawConfig;
};

type CronUsageRow = {
  jobId: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCost: number;
};

type SourceBreakdown = {
  source: string;
  runs: number;
  totalTokens: number;
  totalCost: number;
};

type UsageCommandResult = {
  window: string;
  startDate: string;
  endDate: string;
  summary: CostUsageSummary;
  cronBreakdown?: CronUsageRow[];
  sourceBreakdown?: SourceBreakdown[];
};

function resolveWindowMs(opts: UsageCommandOptions): {
  startMs: number;
  endMs: number;
  label: string;
} {
  const now = Date.now();
  const endMs = now;

  if (opts.today) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return { startMs: todayStart.getTime(), endMs, label: "today" };
  }

  if (opts.week) {
    return { startMs: endMs - 7 * 24 * 60 * 60 * 1000, endMs, label: "last 7 days" };
  }

  if (opts.month) {
    return { startMs: endMs - 30 * 24 * 60 * 60 * 1000, endMs, label: "last 30 days" };
  }

  // Default: today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  return { startMs: todayStart.getTime(), endMs, label: "today" };
}

async function loadCronSourceBreakdown(params: {
  config?: OpenClawConfig;
  startMs: number;
  endMs: number;
  agentId?: string;
}): Promise<{ cronBreakdown: CronUsageRow[]; bySource: SourceBreakdown[] }> {
  const storePath = resolveCronStorePath(params.config?.cron?.store);
  const page = await readCronRunLogEntriesPageAll({
    storePath,
    limit: 200,
    sortDir: "desc",
  }).catch(() => null);

  if (!page) {
    return { cronBreakdown: [], bySource: [] };
  }

  const jobMap = new Map<string, CronUsageRow>();
  let cronTotalTokens = 0;
  let cronTotalCost = 0;
  let cronRuns = 0;

  for (const entry of page.entries) {
    // Filter by time range
    if (entry.ts < params.startMs || entry.ts > params.endMs) {
      continue;
    }
    // Only count successful/completed runs with usage data
    if (entry.status === "skipped") {
      continue;
    }
    // Filter by agent when --agent flag is provided
    if (params.agentId) {
      const entryAgentId = resolveAgentIdFromSessionKey(entry.sessionKey);
      if (entryAgentId !== params.agentId) {
        continue;
      }
    }

    const inputTokens = entry.usage?.input_tokens ?? 0;
    const outputTokens = entry.usage?.output_tokens ?? 0;
    const cacheReadTokens = entry.usage?.cache_read_tokens ?? 0;
    const cacheWriteTokens = entry.usage?.cache_write_tokens ?? 0;
    const totalTokens =
      entry.usage?.total_tokens ?? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    const totalCost = 0; // cron run-log does not store cost, only tokens

    const existing = jobMap.get(entry.jobId) ?? {
      jobId: entry.jobId,
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      totalCost: 0,
    };

    existing.runs += 1;
    existing.inputTokens += inputTokens;
    existing.outputTokens += outputTokens;
    existing.cacheReadTokens += cacheReadTokens;
    existing.cacheWriteTokens += cacheWriteTokens;
    existing.totalTokens += totalTokens;
    existing.totalCost += totalCost;
    jobMap.set(entry.jobId, existing);

    cronTotalTokens += totalTokens;
    cronTotalCost += totalCost;
    cronRuns += 1;
  }

  const cronBreakdown = Array.from(jobMap.values()).toSorted(
    (a, b) => b.totalTokens - a.totalTokens,
  );

  const bySource: SourceBreakdown[] = [
    {
      source: SOURCE_LABELS.cron ?? "cron",
      runs: cronRuns,
      totalTokens: cronTotalTokens,
      totalCost: cronTotalCost,
    },
  ];

  return { cronBreakdown, bySource };
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-CA");
}

function formatTotalsRow(totals: CostUsageTotals, rich: boolean): string {
  const tokens = formatTokenCount(totals.totalTokens);
  const cost = formatUsd(totals.totalCost) ?? "$0.0000";
  const input = formatTokenCount(totals.input);
  const output = formatTokenCount(totals.output);
  const parts = [`tokens: ${tokens}`, `input: ${input}`, `output: ${output}`, `cost: ${cost}`];
  if (totals.cacheRead > 0 || totals.cacheWrite > 0) {
    parts.push(`cache-read: ${formatTokenCount(totals.cacheRead)}`);
    parts.push(`cache-write: ${formatTokenCount(totals.cacheWrite)}`);
  }
  const line = parts.join("  ");
  return rich ? theme.info(line) : line;
}

function printUsageText(result: UsageCommandResult, runtime: RuntimeEnv): void {
  const rich = isRich();
  const { summary } = result;

  const headerText = `Usage report — ${result.window} (${result.startDate} to ${result.endDate})`;
  runtime.log(rich ? theme.heading(headerText) : headerText);
  runtime.log("");

  if (summary.daily.length === 0) {
    runtime.log(
      rich
        ? theme.muted("No usage data found for this period.")
        : "No usage data found for this period.",
    );
    return;
  }

  // Daily breakdown table
  const dailyHeader =
    "Date         Tokens       Input        Output       Cache-R      Cache-W      Cost";
  runtime.log(rich ? theme.heading(dailyHeader) : dailyHeader);

  for (const day of summary.daily) {
    const date = day.date.padEnd(12);
    const tokens = formatTokenCount(day.totalTokens).padEnd(12);
    const input = formatTokenCount(day.input).padEnd(12);
    const output = formatTokenCount(day.output).padEnd(12);
    const cacheR = formatTokenCount(day.cacheRead).padEnd(12);
    const cacheW = formatTokenCount(day.cacheWrite).padEnd(12);
    const cost = (formatUsd(day.totalCost) ?? "$0.0000").padEnd(10);
    const line = `${date} ${tokens} ${input} ${output} ${cacheR} ${cacheW} ${cost}`;
    runtime.log(rich ? theme.info(line) : line);
  }

  runtime.log("");
  const totalsLabel = "Totals:";
  runtime.log(rich ? theme.heading(totalsLabel) : totalsLabel);
  runtime.log(formatTotalsRow(summary.totals, rich));

  if (summary.totals.missingCostEntries > 0) {
    const warnMsg = `Note: ${summary.totals.missingCostEntries} entries missing cost data (model pricing not configured).`;
    runtime.log(rich ? theme.warn(warnMsg) : warnMsg);
  }

  // By-source breakdown
  if (result.sourceBreakdown && result.sourceBreakdown.length > 0) {
    runtime.log("");
    const srcHeader = "By source:";
    runtime.log(rich ? theme.heading(srcHeader) : srcHeader);
    for (const src of result.sourceBreakdown) {
      const line = `  ${src.source.padEnd(10)} runs: ${String(src.runs).padEnd(6)} tokens: ${formatTokenCount(src.totalTokens).padEnd(10)} cost: ${formatUsd(src.totalCost) ?? "n/a"}`;
      runtime.log(rich ? theme.info(line) : line);
    }
  }

  // Cron job breakdown
  if (result.cronBreakdown && result.cronBreakdown.length > 0) {
    runtime.log("");
    const cronHeader = "By cron job (token counts only — cost requires model pricing config):";
    runtime.log(rich ? theme.heading(cronHeader) : cronHeader);
    const cronColHeader = `  ${"Job ID".padEnd(38)} ${"Runs".padEnd(6)} ${"Tokens".padEnd(12)} ${"Input".padEnd(12)} ${"Output".padEnd(12)}`;
    runtime.log(rich ? colorize(rich, theme.muted, cronColHeader) : cronColHeader);
    for (const job of result.cronBreakdown) {
      const line = `  ${job.jobId.padEnd(38)} ${String(job.runs).padEnd(6)} ${formatTokenCount(job.totalTokens).padEnd(12)} ${formatTokenCount(job.inputTokens).padEnd(12)} ${formatTokenCount(job.outputTokens).padEnd(12)}`;
      runtime.log(rich ? theme.info(line) : line);
    }
  }
}

export async function usageCommand(opts: UsageCommandOptions, runtime: RuntimeEnv): Promise<void> {
  const { startMs, endMs, label } = resolveWindowMs(opts);

  const [summary, cronData] = await Promise.all([
    loadCostUsageSummary({
      startMs,
      endMs,
      config: opts.config,
      agentId: opts.agent,
    }),
    opts.bySource
      ? loadCronSourceBreakdown({
          config: opts.config,
          startMs,
          endMs,
          agentId: opts.agent,
        })
      : Promise.resolve(null),
  ]);

  // Build final source breakdown including "direct" (non-cron) sessions.
  // direct = total tokens from loadCostUsageSummary minus tokens attributed to cron runs.
  let sourceBreakdown = cronData?.bySource;
  if (cronData) {
    const cronTotalTokens =
      cronData.bySource.find((s) => s.source === SOURCE_LABELS.cron)?.totalTokens ?? 0;
    const cronTotalCost =
      cronData.bySource.find((s) => s.source === SOURCE_LABELS.cron)?.totalCost ?? 0;
    const directTokens = Math.max(0, summary.totals.totalTokens - cronTotalTokens);
    const directCost = Math.max(0, summary.totals.totalCost - cronTotalCost);
    const cronRuns = cronData.bySource.find((s) => s.source === SOURCE_LABELS.cron)?.runs ?? 0;
    sourceBreakdown = [
      {
        source: SOURCE_LABELS.cron ?? "cron",
        runs: cronRuns,
        totalTokens: cronTotalTokens,
        totalCost: cronTotalCost,
      },
      {
        source: SOURCE_LABELS.direct ?? "direct",
        runs: 0, // direct session run count is not tracked at this layer
        totalTokens: directTokens,
        totalCost: directCost,
      },
    ];
  }

  const result: UsageCommandResult = {
    window: label,
    startDate: formatDate(startMs),
    endDate: formatDate(endMs),
    summary,
    cronBreakdown: cronData?.cronBreakdown,
    sourceBreakdown,
  };

  if (opts.json) {
    runtime.log(JSON.stringify(result, null, 2));
    return;
  }

  printUsageText(result, runtime);
}
