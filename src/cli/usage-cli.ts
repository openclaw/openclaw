import type { Command } from "commander";
import { loadConfig } from "../config/config.js";
import {
  type CostUsageSummary,
  type SessionCostSummary,
  discoverAllSessions,
  loadCostUsageSummary,
  loadSessionCostSummary,
} from "../infra/session-cost-usage.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { formatUsd } from "../utils/usage-format.js";

function roundCost(value?: number): number {
  if (value === undefined || value === 0) {
    return 0;
  }
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

type UsageCliOptions = {
  today?: boolean;
  week?: boolean;
  month?: boolean;
  days?: string;
  sessions?: boolean;
  byModel?: boolean;
  from?: string;
  to?: string;
  json?: boolean;
  limit?: string;
  agentId?: string;
};

function resolveDateRange(opts: UsageCliOptions): {
  startMs: number;
  endMs: number;
  label: string;
} {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let startMs: number;
  let endMs: number;
  let label: string;

  if (opts.from || opts.to) {
    const start = opts.from ? new Date(opts.from) : new Date(today);
    const end = opts.to ? new Date(opts.to + "T23:59:59.999") : now;
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error(`Invalid date range: --from ${opts.from} --to ${opts.to}`);
    }
    startMs = start.getTime();
    endMs = end.getTime();
    label = `${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}`;
  } else if (opts.today) {
    startMs = today.getTime();
    endMs = now.getTime();
    label = "Today";
  } else if (opts.week) {
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - 6);
    startMs = weekStart.getTime();
    endMs = now.getTime();
    label = "Last 7 days";
  } else if (opts.month) {
    const monthStart = new Date(today);
    monthStart.setDate(monthStart.getDate() - 29);
    startMs = monthStart.getTime();
    endMs = now.getTime();
    label = "Last 30 days";
  } else {
    startMs = today.getTime();
    endMs = now.getTime();
    label = "Today";
  }

  if (opts.days) {
    const days = Number.parseInt(opts.days, 10);
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error(`--days must be a positive integer, got: ${opts.days}`);
    }
    if (opts.from || opts.to || opts.today || opts.week || opts.month) {
      throw new Error("--days cannot be combined with --from/--to/--today/--week/--month");
    }
    const rangeStart = new Date(today);
    rangeStart.setDate(rangeStart.getDate() - (days - 1));
    startMs = rangeStart.getTime();
    endMs = now.getTime();
    label = `Last ${days} days`;
  }

  return { startMs, endMs, label };
}

function parseLimit(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}K`;
  }
  return String(n);
}

function padRight(s: string, len: number): string {
  return s.length < len ? s + " ".repeat(len - s.length) : s.slice(0, len);
}

function padLeft(s: string, len: number): string {
  return s.length < len ? " ".repeat(len - s.length) + s : s.slice(-len);
}

function formatUsageSummaryText(
  summary: CostUsageSummary,
  label: string,
  opts: UsageCliOptions,
  sessionSummaries: SessionCostSummary[],
): string {
  const lines: string[] = [];
  const rich = isRich();

  const header = rich
    ? colorize(true, theme.accent, `📊 OpenClaw Usage — ${label}`)
    : `OpenClaw Usage — ${label}`;
  lines.push(header);
  lines.push("");

  const t = summary.totals;

  lines.push(
    `  Tokens:   ${formatTokenCount(t.totalTokens).padStart(8)} (${formatTokenCount(t.input)} in, ${formatTokenCount(t.output)} out)`,
  );
  const costStr = t.totalCost > 0 ? (formatUsd(t.totalCost) ?? "$0.00") : "$0.00";
  lines.push(`  Cost:     ${costStr.padStart(8)}`);
  if (t.cacheRead > 0 || t.cacheWrite > 0) {
    lines.push(
      `  Cache:    ${formatTokenCount(t.cacheRead)} read, ${formatTokenCount(t.cacheWrite)} write`,
    );
  }
  lines.push("");

  if (opts.sessions && sessionSummaries.length > 0) {
    lines.push("  Top Sessions:");
    const sorted = [...sessionSummaries]
      .filter((s) => (s.totalCost ?? 0) > 0)
      .toSorted((a, b) => (b.totalCost ?? 0) - (a.totalCost ?? 0))
      .slice(0, parseLimit(opts.limit, 10));

    const nameWidth = Math.min(30, Math.max(12, ...sorted.map((s) => (s.sessionId ?? "").length)));

    for (const session of sorted) {
      const name = (session.sessionId ?? "unknown").slice(0, nameWidth);
      const cost = formatUsd(session.totalCost) ?? "$0.00";
      const tokens = formatTokenCount(session.totalTokens ?? 0);
      const calls = session.messageCounts?.assistant ?? 0;
      lines.push(
        `    ${padRight(name, nameWidth)} ${padLeft(cost, 8)}  ${padLeft(tokens, 8)} tokens  ${calls} calls`,
      );
    }
    lines.push("");
  }

  if (opts.byModel && sessionSummaries.length > 0) {
    const modelMap = new Map<string, { tokens: number; cost: number; calls: number }>();

    for (const session of sessionSummaries) {
      const models = session.modelUsage ?? [];
      for (const mu of models) {
        const key = mu.model ?? "unknown";
        const existing = modelMap.get(key) ?? { tokens: 0, cost: 0, calls: 0 };
        existing.tokens += mu.totals.totalTokens ?? 0;
        existing.cost += mu.totals.totalCost ?? 0;
        existing.calls += mu.count ?? 0;
        modelMap.set(key, existing);
      }
    }

    if (modelMap.size > 0) {
      lines.push("  By Model:");
      const sortedModels = Array.from(modelMap.entries()).toSorted((a, b) => b[1].cost - a[1].cost);
      const modelWidth = Math.min(35, Math.max(12, ...sortedModels.map(([k]) => k.length)));

      for (const [model, data] of sortedModels) {
        const cost = formatUsd(data.cost) ?? "$0.00";
        const tokens = formatTokenCount(data.tokens);
        lines.push(
          `    ${padRight(model, modelWidth)} ${padLeft(cost, 8)}  ${padLeft(tokens, 8)} tokens  ${data.calls} calls`,
        );
      }
      lines.push("");
    }
  }

  if (summary.daily.length > 1 && !opts.sessions && !opts.byModel) {
    lines.push("  Daily:");
    for (const day of summary.daily) {
      const cost = formatUsd(day.totalCost) ?? "$0.00";
      const tokens = formatTokenCount(day.totalTokens);
      lines.push(`    ${day.date}  ${padLeft(cost, 8)}  ${padLeft(tokens, 8)} tokens`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatUsageSummaryJson(
  summary: CostUsageSummary,
  sessionSummaries: SessionCostSummary[],
  opts: UsageCliOptions,
): string {
  const { startMs, endMs, label } = resolveDateRange(opts);

  const sessions = (opts.sessions ? sessionSummaries : []).map((s) => ({
    sessionId: s.sessionId,
    totalTokens: s.totalTokens,
    totalCost: roundCost(s.totalCost),
    inputTokens: s.input,
    outputTokens: s.output,
    cacheReadTokens: s.cacheRead,
    cacheWriteTokens: s.cacheWrite,
    messageCount: s.messageCounts?.total ?? 0,
    modelUsage: (s.modelUsage ?? []).map((m) => ({
      model: m.model,
      provider: m.provider,
      tokens: m.totals.totalTokens,
      cost: roundCost(m.totals.totalCost),
      calls: m.count,
    })),
  }));

  const models: Array<{
    model: string;
    provider?: string;
    tokens: number;
    cost: number;
    calls: number;
  }> = [];

  if (opts.byModel) {
    const modelMap = new Map<string, (typeof models)[number]>();
    for (const session of sessionSummaries) {
      for (const mu of session.modelUsage ?? []) {
        const key = `${mu.provider ?? ""}/${mu.model ?? ""}`;
        const existing = modelMap.get(key) ?? {
          model: mu.model ?? "",
          provider: mu.provider,
          tokens: 0,
          cost: 0,
          calls: 0,
        };
        existing.tokens += mu.totals.totalTokens ?? 0;
        existing.cost += mu.totals.totalCost ?? 0;
        existing.calls += mu.count ?? 0;
        modelMap.set(key, existing);
      }
    }
    models.push(...Array.from(modelMap.values()));
  }

  return JSON.stringify(
    {
      period: { label, from: new Date(startMs).toISOString(), to: new Date(endMs).toISOString() },
      totals: {
        inputTokens: summary.totals.input,
        outputTokens: summary.totals.output,
        cacheReadTokens: summary.totals.cacheRead,
        cacheWriteTokens: summary.totals.cacheWrite,
        totalTokens: summary.totals.totalTokens,
        totalCost: roundCost(summary.totals.totalCost),
      },
      daily: summary.daily.map((d) => ({
        date: d.date,
        totalTokens: d.totalTokens,
        totalCost: roundCost(d.totalCost),
      })),
      sessions,
      models,
    },
    null,
    2,
  );
}

export function registerUsageCli(program: Command): void {
  const usage = program
    .command("usage")
    .description("Show token usage and cost summaries")
    .option("--today", "Show today's usage (default)", false)
    .option("--week", "Show last 7 days", false)
    .option("--month", "Show last 30 days", false)
    .option("--days <n>", "Show last N days")
    .option("--from <date>", "Start date (YYYY-MM-DD)")
    .option("--to <date>", "End date (YYYY-MM-DD)")
    .option("--sessions", "Break down by session", false)
    .option("--by-model", "Break down by model", false)
    .option("--limit <n>", "Max sessions to show (default: 10)", "10")
    .option("--json", "Output JSON", false)
    .option("--agent-id <id>", "Agent ID to query", "main");

  usage.action(async (opts: UsageCliOptions) => {
    const config = loadConfig();
    const { startMs, endMs, label } = resolveDateRange(opts);

    const summary = await loadCostUsageSummary({
      startMs,
      endMs,
      config,
      agentId: opts.agentId,
    });

    let sessionSummaries: SessionCostSummary[] = [];
    if (opts.sessions || opts.byModel) {
      const sessions = await discoverAllSessions({ agentId: opts.agentId });
      const loadLimit = 100;
      const topSessions = sessions.toSorted((a, b) => b.mtime - a.mtime).slice(0, loadLimit);

      const batchSize = 10;
      for (let i = 0; i < topSessions.length; i += batchSize) {
        const batch = topSessions.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(async (session) => {
            return loadSessionCostSummary({
              sessionFile: session.sessionFile,
              startMs,
              endMs,
              config,
              agentId: opts.agentId,
            });
          }),
        );
        for (let j = 0; j < results.length; j++) {
          const r = results[j];
          if (r.status === "fulfilled" && r.value) {
            sessionSummaries.push({
              ...r.value,
              sessionId: batch[j].sessionId,
              sessionFile: batch[j].sessionFile,
            });
          }
        }
      }
    }

    if (opts.json) {
      console.log(formatUsageSummaryJson(summary, sessionSummaries, opts));
    } else {
      if (summary.daily.length === 0) {
        console.log("No usage data found for the specified period.");
        return;
      }
      console.log(formatUsageSummaryText(summary, label, opts, sessionSummaries));
    }
  });
}
