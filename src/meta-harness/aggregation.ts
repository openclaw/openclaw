/**
 * Daily/Weekly summary aggregation
 *
 * Reads flow traces and child traces from the runtime directories
 * and produces aggregated summaries for observability.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type {
  FlowTrace,
  ChildTrace,
  DailySummary,
  WeeklySummary,
  RunOutcome,
  TriageDomain,
  AutomationLevel,
} from "./types.js";
import { listTraces } from "./writer.js";

/**
 * Build a daily summary from all traces for a given date.
 */
export async function buildDailySummary(
  workspaceDir: string,
  date: string, // YYYY-MM-DD
): Promise<DailySummary> {
  const allFlowTraces = await listTraces<FlowTrace>(workspaceDir, "traces");
  const allChildTraces = await listTraces<ChildTrace>(workspaceDir, "children");

  // Filter flow traces by date
  const dayTraces = allFlowTraces.filter((t) => t.data.timestamp.startsWith(date));

  // Also collect child traces linked to today's flows
  const todayFlowIds = new Set(dayTraces.map((t) => t.data.trace_id));
  const linkedChildren = allChildTraces.filter(
    (t) => todayFlowIds.has(t.data.parent_trace_id) || t.data.timestamp.startsWith(date),
  );

  const summary: DailySummary = {
    date,
    total_runs: dayTraces.length,
    outcomes: emptyCount<RunOutcome>(["completed", "partial", "failed", "escalated", "aborted"]),
    domains: emptyCount<TriageDomain>([
      "strategy",
      "research",
      "build",
      "delivery",
      "growth",
      "ops",
      "governance",
      "unknown",
    ]),
    automation_levels: emptyCount<AutomationLevel>(["A", "B", "C", "D", "X"]),
    tool_error_frequency: 0,
    tool_error_count: 0,
    tool_call_count: 0,
    delegation_count: linkedChildren.length,
    delegation_failures: 0,
    escalations: 0,
    flow_trace_ids: dayTraces.map((t) => t.data.trace_id),
    child_trace_ids: linkedChildren.map((t) => t.data.child_trace_id),
  };

  let totalToolCalls = 0;
  let totalToolErrors = 0;

  for (const trace of dayTraces) {
    const t = trace.data;
    summary.outcomes[t.outcome] = (summary.outcomes[t.outcome] || 0) + 1;
    summary.domains[t.triage_domain] = (summary.domains[t.triage_domain] || 0) + 1;
    summary.automation_levels[t.automation_level] =
      (summary.automation_levels[t.automation_level] || 0) + 1;
    if (t.outcome === "escalated") {
      summary.escalations++;
    }
    summary.delegation_count += t.delegation_list.length;

    for (const tool of t.tool_outcomes) {
      totalToolCalls++;
      if (!tool.success) {
        totalToolErrors++;
      }
    }
  }

  for (const child of linkedChildren) {
    const c = child.data;
    if (c.status === "failed" || c.status === "escalated") {
      summary.delegation_failures++;
    }
    for (const tool of c.summarized_tool_calls) {
      totalToolCalls++;
      if (!tool.success) {
        totalToolErrors++;
      }
    }
  }

  summary.tool_call_count = totalToolCalls;
  summary.tool_error_count = totalToolErrors;
  summary.tool_error_frequency = totalToolCalls > 0 ? totalToolErrors / totalToolCalls : 0;

  return summary;
}

/**
 * Build a weekly summary from daily summaries.
 */
export async function buildWeeklySummary(
  workspaceDir: string,
  weekStart: string, // YYYY-MM-DD (Monday)
  weekEnd: string, // YYYY-MM-DD (Sunday)
): Promise<WeeklySummary> {
  const dailyDir = path.join(workspaceDir, "data/meta-harness/daily");
  const dailyCounts: number[] = [];
  let totalToolErrors = 0;
  let totalEscalations = 0;

  // Iterate each day of the week
  const start = new Date(weekStart);
  const end = new Date(weekEnd);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    const filePath = path.join(dailyDir, `daily-${dateStr}.json`);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const daily: DailySummary = JSON.parse(raw);
      dailyCounts.push(daily.total_runs);
      totalToolErrors += daily.tool_error_count;
      totalEscalations += daily.escalations;
    } catch {
      dailyCounts.push(0);
    }
  }

  const avgRuns =
    dailyCounts.length > 0 ? dailyCounts.reduce((a, b) => a + b, 0) / dailyCounts.length : 0;

  return {
    week_start: weekStart,
    week_end: weekEnd,
    daily_counts: dailyCounts,
    avg_runs_per_day: Math.round(avgRuns * 100) / 100,
    total_tool_errors: totalToolErrors,
    total_escalations: totalEscalations,
    top_failure_domains: [],
    top_failure_tools: [],
  };
}

function emptyCount<T extends string>(keys: T[]): Record<T, number> {
  const result = {} as Record<T, number>;
  for (const key of keys) {
    result[key] = 0;
  }
  return result;
}
