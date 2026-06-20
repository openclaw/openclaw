import type { SessionStoreOperationMetric } from "./store-observability.js";

export type SessionStoreRuntimeHealthSample = {
  eventLoopLagMs?: number;
  rssBytes?: number;
  cpuPercent?: number;
};

export type SessionStoreHealthBudget = {
  requireRecentMetrics?: boolean;
  maxMetricsAgeMs?: number;
  minRecentOperations?: number;
  maxOperationDurationMs?: number;
  maxErrorRate?: number;
  maxRecentFailures?: number;
  maxListPageEntries?: number;
  maxListTotalCount?: number;
  maxTranscriptChunkPageEntries?: number;
  maxTranscriptChunkPageBytes?: number;
  maxTranscriptChunkTotalCount?: number;
  maxSessionTurnPageEntries?: number;
  maxSessionTurnTotalCount?: number;
  maxEventLoopLagMs?: number;
  maxRssBytes?: number;
  maxCpuPercent?: number;
};

export type SessionStoreHealthDenialCode =
  | "missing_metrics"
  | "stale_metrics"
  | "insufficient_metrics"
  | "operation_latency"
  | "operation_errors"
  | "operation_error_rate"
  | "list_page_size"
  | "list_total_count"
  | "transcript_chunk_page_size"
  | "transcript_chunk_page_bytes"
  | "transcript_chunk_total_count"
  | "session_turn_page_size"
  | "session_turn_total_count"
  | "event_loop_lag"
  | "rss"
  | "cpu";

export type SessionStoreHealthDenial = {
  code: SessionStoreHealthDenialCode;
  message: string;
  observed?: number;
  limit?: number;
};

export type SessionStoreHealthSnapshot = {
  ok: boolean;
  denials: SessionStoreHealthDenial[];
  totalOperations: number;
  recentOperations: number;
  failedOperations: number;
  errorRate: number;
  maxDurationMs: number;
  maxListPageEntries: number;
  maxListTotalCount: number;
  maxTranscriptChunkPageEntries: number;
  maxTranscriptChunkPageBytes: number;
  maxTranscriptChunkTotalCount: number;
  maxSessionTurnPageEntries: number;
  maxSessionTurnTotalCount: number;
  newestMetricAgeMs?: number;
};

export type EvaluateSessionStoreHealthOptions = {
  metrics: readonly SessionStoreOperationMetric[];
  budget: SessionStoreHealthBudget;
  runtime?: SessionStoreRuntimeHealthSample;
  nowMs?: number;
};

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function addDenial(denials: SessionStoreHealthDenial[], params: SessionStoreHealthDenial): void {
  denials.push(params);
}

export function evaluateSessionStoreHealth(
  options: EvaluateSessionStoreHealthOptions,
): SessionStoreHealthSnapshot {
  const budget = options.budget;
  const nowMs = finiteNonNegative(options.nowMs) ?? Date.now();
  const maxMetricsAgeMs = finiteNonNegative(budget.maxMetricsAgeMs);
  const metrics = [...options.metrics].toSorted(
    (left, right) => left.startedAtMs - right.startedAtMs,
  );
  const newestMetric = metrics.at(-1);
  const newestMetricAgeMs = newestMetric
    ? Math.max(0, nowMs - newestMetric.startedAtMs)
    : undefined;
  const recentMetrics =
    maxMetricsAgeMs === undefined
      ? metrics
      : metrics.filter((metric) => nowMs - metric.startedAtMs <= maxMetricsAgeMs);
  const failedOperations = recentMetrics.filter((metric) => !metric.ok).length;
  const errorRate = recentMetrics.length > 0 ? failedOperations / recentMetrics.length : 0;
  const maxDurationMs = Math.max(0, ...recentMetrics.map((metric) => metric.durationMs));
  const listMetrics = recentMetrics.filter((metric) => metric.operation === "listEntries");
  const maxListPageEntries = Math.max(0, ...listMetrics.map((metric) => metric.entryCount ?? 0));
  const maxListTotalCount = Math.max(0, ...listMetrics.map((metric) => metric.totalCount ?? 0));
  const transcriptChunkListMetrics = recentMetrics.filter(
    (metric) => metric.operation === "listTranscriptChunks",
  );
  const maxTranscriptChunkPageEntries = Math.max(
    0,
    ...transcriptChunkListMetrics.map((metric) => metric.chunkCount ?? 0),
  );
  const maxTranscriptChunkPageBytes = Math.max(
    0,
    ...transcriptChunkListMetrics.map((metric) => metric.byteCount ?? 0),
  );
  const maxTranscriptChunkTotalCount = Math.max(
    0,
    ...transcriptChunkListMetrics.map((metric) => metric.totalCount ?? 0),
  );
  const sessionTurnListMetrics = recentMetrics.filter(
    (metric) => metric.operation === "listSessionTurns",
  );
  const maxSessionTurnPageEntries = Math.max(
    0,
    ...sessionTurnListMetrics.map((metric) => metric.turnCount ?? 0),
  );
  const maxSessionTurnTotalCount = Math.max(
    0,
    ...sessionTurnListMetrics.map((metric) => metric.totalCount ?? 0),
  );
  const denials: SessionStoreHealthDenial[] = [];

  if (budget.requireRecentMetrics !== false && metrics.length === 0) {
    addDenial(denials, {
      code: "missing_metrics",
      message: "No session-store metrics are available; fail-closed before admitting work",
    });
  }
  if (
    budget.requireRecentMetrics !== false &&
    maxMetricsAgeMs !== undefined &&
    metrics.length > 0 &&
    recentMetrics.length === 0
  ) {
    addDenial(denials, {
      code: "stale_metrics",
      message: "Session-store metrics are stale; fail-closed before admitting work",
      observed: newestMetricAgeMs,
      limit: maxMetricsAgeMs,
    });
  }
  const minRecentOperations = finiteNonNegative(budget.minRecentOperations);
  if (
    minRecentOperations !== undefined &&
    budget.requireRecentMetrics !== false &&
    recentMetrics.length < minRecentOperations
  ) {
    addDenial(denials, {
      code: "insufficient_metrics",
      message: "Not enough recent session-store metrics are available",
      observed: recentMetrics.length,
      limit: minRecentOperations,
    });
  }
  const maxOperationDurationMs = finiteNonNegative(budget.maxOperationDurationMs);
  if (maxOperationDurationMs !== undefined && maxDurationMs > maxOperationDurationMs) {
    addDenial(denials, {
      code: "operation_latency",
      message: "Session-store operation latency exceeds budget",
      observed: maxDurationMs,
      limit: maxOperationDurationMs,
    });
  }
  const maxRecentFailures = finiteNonNegative(budget.maxRecentFailures);
  if (maxRecentFailures !== undefined && failedOperations > maxRecentFailures) {
    addDenial(denials, {
      code: "operation_errors",
      message: "Session-store recent failure count exceeds budget",
      observed: failedOperations,
      limit: maxRecentFailures,
    });
  }
  const maxErrorRate = finiteNonNegative(budget.maxErrorRate);
  if (maxErrorRate !== undefined && errorRate > maxErrorRate) {
    addDenial(denials, {
      code: "operation_error_rate",
      message: "Session-store recent error rate exceeds budget",
      observed: errorRate,
      limit: maxErrorRate,
    });
  }
  const maxPageEntries = finiteNonNegative(budget.maxListPageEntries);
  if (maxPageEntries !== undefined && maxListPageEntries > maxPageEntries) {
    addDenial(denials, {
      code: "list_page_size",
      message: "Session-store list page size exceeds bounded-read budget",
      observed: maxListPageEntries,
      limit: maxPageEntries,
    });
  }
  const maxTotalCount = finiteNonNegative(budget.maxListTotalCount);
  if (maxTotalCount !== undefined && maxListTotalCount > maxTotalCount) {
    addDenial(denials, {
      code: "list_total_count",
      message: "Session-store list total count exceeds admission budget",
      observed: maxListTotalCount,
      limit: maxTotalCount,
    });
  }
  const maxTranscriptChunkPageEntriesBudget = finiteNonNegative(
    budget.maxTranscriptChunkPageEntries,
  );
  if (
    maxTranscriptChunkPageEntriesBudget !== undefined &&
    maxTranscriptChunkPageEntries > maxTranscriptChunkPageEntriesBudget
  ) {
    addDenial(denials, {
      code: "transcript_chunk_page_size",
      message: "Session transcript chunk page size exceeds bounded-read budget",
      observed: maxTranscriptChunkPageEntries,
      limit: maxTranscriptChunkPageEntriesBudget,
    });
  }
  const maxTranscriptChunkPageBytesBudget = finiteNonNegative(budget.maxTranscriptChunkPageBytes);
  if (
    maxTranscriptChunkPageBytesBudget !== undefined &&
    maxTranscriptChunkPageBytes > maxTranscriptChunkPageBytesBudget
  ) {
    addDenial(denials, {
      code: "transcript_chunk_page_bytes",
      message: "Session transcript chunk page bytes exceed bounded-read budget",
      observed: maxTranscriptChunkPageBytes,
      limit: maxTranscriptChunkPageBytesBudget,
    });
  }
  const maxTranscriptChunkTotalCountBudget = finiteNonNegative(budget.maxTranscriptChunkTotalCount);
  if (
    maxTranscriptChunkTotalCountBudget !== undefined &&
    maxTranscriptChunkTotalCount > maxTranscriptChunkTotalCountBudget
  ) {
    addDenial(denials, {
      code: "transcript_chunk_total_count",
      message: "Session transcript chunk total count exceeds admission budget",
      observed: maxTranscriptChunkTotalCount,
      limit: maxTranscriptChunkTotalCountBudget,
    });
  }

  const maxSessionTurnPageEntriesBudget = finiteNonNegative(budget.maxSessionTurnPageEntries);
  if (
    maxSessionTurnPageEntriesBudget !== undefined &&
    maxSessionTurnPageEntries > maxSessionTurnPageEntriesBudget
  ) {
    addDenial(denials, {
      code: "session_turn_page_size",
      message: "Session turn page size exceeds bounded-read budget",
      observed: maxSessionTurnPageEntries,
      limit: maxSessionTurnPageEntriesBudget,
    });
  }
  const maxSessionTurnTotalCountBudget = finiteNonNegative(budget.maxSessionTurnTotalCount);
  if (
    maxSessionTurnTotalCountBudget !== undefined &&
    maxSessionTurnTotalCount > maxSessionTurnTotalCountBudget
  ) {
    addDenial(denials, {
      code: "session_turn_total_count",
      message: "Session turn total count exceeds admission budget",
      observed: maxSessionTurnTotalCount,
      limit: maxSessionTurnTotalCountBudget,
    });
  }
  const runtime = options.runtime;
  const maxEventLoopLagMs = finiteNonNegative(budget.maxEventLoopLagMs);
  const eventLoopLagMs = finiteNonNegative(runtime?.eventLoopLagMs);
  if (
    maxEventLoopLagMs !== undefined &&
    eventLoopLagMs !== undefined &&
    eventLoopLagMs > maxEventLoopLagMs
  ) {
    addDenial(denials, {
      code: "event_loop_lag",
      message: "Gateway event-loop lag exceeds admission budget",
      observed: eventLoopLagMs,
      limit: maxEventLoopLagMs,
    });
  }
  const maxRssBytes = finiteNonNegative(budget.maxRssBytes);
  const rssBytes = finiteNonNegative(runtime?.rssBytes);
  if (maxRssBytes !== undefined && rssBytes !== undefined && rssBytes > maxRssBytes) {
    addDenial(denials, {
      code: "rss",
      message: "Gateway RSS exceeds admission budget",
      observed: rssBytes,
      limit: maxRssBytes,
    });
  }
  const maxCpuPercent = finiteNonNegative(budget.maxCpuPercent);
  const cpuPercent = finiteNonNegative(runtime?.cpuPercent);
  if (maxCpuPercent !== undefined && cpuPercent !== undefined && cpuPercent > maxCpuPercent) {
    addDenial(denials, {
      code: "cpu",
      message: "Gateway CPU exceeds admission budget",
      observed: cpuPercent,
      limit: maxCpuPercent,
    });
  }

  return {
    ok: denials.length === 0,
    denials,
    totalOperations: metrics.length,
    recentOperations: recentMetrics.length,
    failedOperations,
    errorRate,
    maxDurationMs,
    maxListPageEntries,
    maxListTotalCount,
    maxTranscriptChunkPageEntries,
    maxTranscriptChunkPageBytes,
    maxTranscriptChunkTotalCount,
    maxSessionTurnPageEntries,
    maxSessionTurnTotalCount,
    ...(newestMetricAgeMs !== undefined ? { newestMetricAgeMs } : {}),
  };
}

export function shouldAdmitSessionStoreWork(options: EvaluateSessionStoreHealthOptions):
  | { admitted: true; health: SessionStoreHealthSnapshot }
  | {
      admitted: false;
      reason: "session_store_health";
      health: SessionStoreHealthSnapshot;
    } {
  const health = evaluateSessionStoreHealth(options);
  if (health.ok) {
    return { admitted: true, health };
  }
  return { admitted: false, reason: "session_store_health", health };
}
