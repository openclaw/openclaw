import type { CostUsageSummary, LogEntry } from "../types.ts";
import type { DashboardSummaryResult } from "./dashboard.ts";

const DASHBOARD_TIMELINE_WINDOW_MS = 15 * 60 * 1000;
const DASHBOARD_TIMELINE_BUCKET_MS = 15 * 1000;

export type DashboardTimelinePoint = {
  ts: number;
  cost: number | null;
  queueSize: number;
  pendingReplies: number;
  activeEmbeddedRuns: number;
  approvals: number;
  pendingDevices: number;
  securityCritical: number;
  securityWarn: number;
  logWarnings: number;
  logErrors: number;
  nodes: number;
};

export type DashboardTimelineState = {
  dashboardTimeline: DashboardTimelinePoint[];
  dashboardSummary: DashboardSummaryResult | null;
  usageCostSummary: CostUsageSummary | null;
  logsEntries: LogEntry[];
};

function roundTimelineBucket(ts: number) {
  return ts - (ts % DASHBOARD_TIMELINE_BUCKET_MS);
}

function resolveRecentLogCounts(entries: LogEntry[]) {
  return entries.slice(-80).reduce(
    (acc, entry) => {
      if (entry.level === "warn") {
        acc.warn += 1;
      }
      if (entry.level === "error" || entry.level === "fatal") {
        acc.error += 1;
      }
      return acc;
    },
    { warn: 0, error: 0 },
  );
}

function buildDashboardTimelinePoint(
  state: DashboardTimelineState,
  ts: number,
): DashboardTimelinePoint | null {
  const summary = state.dashboardSummary;
  const hasUsage = state.usageCostSummary?.totals != null;
  const hasLogs = state.logsEntries.length > 0;
  if (!summary && !hasUsage && !hasLogs) {
    return null;
  }
  const logCounts = resolveRecentLogCounts(state.logsEntries);
  return {
    ts,
    cost: state.usageCostSummary?.totals.totalCost ?? null,
    queueSize: summary?.runtime.queueSize ?? 0,
    pendingReplies: summary?.runtime.pendingReplies ?? 0,
    activeEmbeddedRuns: summary?.runtime.activeEmbeddedRuns ?? 0,
    approvals: summary?.approvals.count ?? 0,
    pendingDevices: summary?.devices.pending ?? 0,
    securityCritical: summary?.security.summary.critical ?? 0,
    securityWarn: summary?.security.summary.warn ?? 0,
    logWarnings: logCounts.warn,
    logErrors: logCounts.error,
    nodes: summary?.nodes.count ?? 0,
  };
}

export function captureDashboardTimeline(state: DashboardTimelineState, opts?: { ts?: number }) {
  const bucketTs = roundTimelineBucket(opts?.ts ?? Date.now());
  const nextPoint = buildDashboardTimelinePoint(state, bucketTs);
  if (!nextPoint) {
    return;
  }
  const cutoffTs = bucketTs - DASHBOARD_TIMELINE_WINDOW_MS;
  const points = state.dashboardTimeline.filter((entry) => entry.ts >= cutoffTs);
  const lastIndex = points.length - 1;
  if (lastIndex >= 0 && points[lastIndex]?.ts === bucketTs) {
    points[lastIndex] = nextPoint;
  } else {
    points.push(nextPoint);
  }
  state.dashboardTimeline = points;
}
