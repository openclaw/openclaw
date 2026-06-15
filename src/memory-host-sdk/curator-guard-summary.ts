import type { MemoryHostEvent } from "./events.js";
import { readMemoryHostEvents } from "./events.js";

export type MemoryCuratorGuardSummary = {
  totalDecisions: number;
  allowed: number;
  denied: number;
  approvalRequired: number;
  redactions: number;
  privateBlocks: number;
  staleRecalls: number;
  contradictions: number;
  approvalRequests: number;
  pendingApprovals: number;
  approvalsAllowedOnce: number;
  approvalDenials: number;
  approvalExpirations: number;
  approvalReplayBlocks: number;
  lastDecisionAt?: string;
  lastApprovalRequestedAt?: string;
  trendBuckets: MemoryCuratorGuardTrendBucket[];
  alerts: MemoryCuratorGuardAlert[];
};

export type MemoryCuratorAuditReport = {
  generatedAt: string;
  windowDays: number;
  sourceEventCount: number;
  curatorEventCount: number;
  summary: MemoryCuratorGuardSummary;
  decisionEventCounts: {
    allow: number;
    deny: number;
    approvalRequired: number;
  };
  approvalEventCounts: {
    requested: number;
    pending: number;
    allowedOnce: number;
    denied: number;
    expired: number;
    replayBlocked: number;
  };
  signalEventCounts: {
    redacted: number;
    privateMemoryBlocked: number;
    staleRecall: number;
    contradictionDetected: number;
  };
  alertCounts: {
    total: number;
    warning: number;
    critical: number;
  };
  trendBuckets: MemoryCuratorGuardTrendBucket[];
};

export type MemoryCuratorGuardAlertMetric =
  | "denied"
  | "privateBlocks"
  | "contradictions"
  | "approvalReplayBlocks"
  | "staleRecalls"
  | "approvalExpirations"
  | "pendingApprovals";

export type MemoryCuratorGuardAlert = {
  id: string;
  severity: "warning" | "critical";
  metric: MemoryCuratorGuardAlertMetric;
  value: number;
  threshold: number;
  message: string;
};

export type MemoryCuratorGuardAlertThresholds = Partial<
  Record<MemoryCuratorGuardAlertMetric, number>
>;

export type MemoryCuratorGuardTrendBucket = {
  bucketStartIso: string;
  bucketEndIso: string;
  allowed: number;
  denied: number;
  approvalRequired: number;
  privateBlocks: number;
  contradictions: number;
  staleRecalls: number;
  approvalReplayBlocks: number;
  approvalExpirations: number;
};

export const EMPTY_MEMORY_CURATOR_GUARD_SUMMARY: MemoryCuratorGuardSummary = {
  totalDecisions: 0,
  allowed: 0,
  denied: 0,
  approvalRequired: 0,
  redactions: 0,
  privateBlocks: 0,
  staleRecalls: 0,
  contradictions: 0,
  approvalRequests: 0,
  pendingApprovals: 0,
  approvalsAllowedOnce: 0,
  approvalDenials: 0,
  approvalExpirations: 0,
  approvalReplayBlocks: 0,
  trendBuckets: [],
  alerts: [],
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TREND_BUCKET_DAYS = 14;
const MAX_TREND_BUCKET_DAYS = 30;
const DEFAULT_AUDIT_WINDOW_DAYS = 30;
const MAX_AUDIT_WINDOW_DAYS = 90;

export const DEFAULT_MEMORY_CURATOR_GUARD_ALERT_THRESHOLDS: Required<MemoryCuratorGuardAlertThresholds> =
  {
    denied: 3,
    privateBlocks: 1,
    contradictions: 1,
    approvalReplayBlocks: 1,
    staleRecalls: 5,
    approvalExpirations: 3,
    pendingApprovals: 3,
  };

type MemoryCuratorGuardOptions = {
  days?: number;
  nowIso?: string;
  alertThresholds?: MemoryCuratorGuardAlertThresholds;
};

function latestIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!right) {
    return left;
  }
  if (!left) {
    return right;
  }
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs)) {
    return right;
  }
  if (!Number.isFinite(rightMs)) {
    return left;
  }
  return rightMs > leftMs ? right : left;
}

function hasRedactedPreview(event: MemoryHostEvent): boolean {
  if (!("redactedPreview" in event) || typeof event.redactedPreview !== "string") {
    return false;
  }
  return /\[REDACTED/i.test(event.redactedPreview);
}

function startOfUtcDayMs(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function normalizeTrendDays(days: number | undefined): number {
  if (!Number.isFinite(days)) {
    return DEFAULT_TREND_BUCKET_DAYS;
  }
  return Math.min(MAX_TREND_BUCKET_DAYS, Math.max(1, Math.floor(days as number)));
}

function normalizeAuditDays(days: number | undefined): number {
  if (!Number.isFinite(days)) {
    return DEFAULT_AUDIT_WINDOW_DAYS;
  }
  return Math.min(MAX_AUDIT_WINDOW_DAYS, Math.max(1, Math.floor(days as number)));
}

function normalizeTrendNowMs(nowIso: string | undefined): number {
  if (!nowIso) {
    return Date.now();
  }
  const parsed = Date.parse(nowIso);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function normalizeAlertThresholds(
  thresholds: MemoryCuratorGuardAlertThresholds | undefined,
): Required<MemoryCuratorGuardAlertThresholds> {
  const normalized = { ...DEFAULT_MEMORY_CURATOR_GUARD_ALERT_THRESHOLDS };
  if (!thresholds) {
    return normalized;
  }
  for (const metric of Object.keys(normalized) as MemoryCuratorGuardAlertMetric[]) {
    const value = thresholds[metric];
    if (Number.isFinite(value)) {
      normalized[metric] = Math.max(1, Math.floor(value as number));
    }
  }
  return normalized;
}

function createGuardAlert(params: {
  id: string;
  severity: "warning" | "critical";
  metric: MemoryCuratorGuardAlertMetric;
  value: number;
  threshold: number;
  label: string;
}): MemoryCuratorGuardAlert {
  return {
    id: params.id,
    severity: params.severity,
    metric: params.metric,
    value: params.value,
    threshold: params.threshold,
    message: `${params.label} reached ${params.value} (threshold ${params.threshold}).`,
  };
}

function buildMemoryCuratorGuardAlerts(
  summary: Pick<
    MemoryCuratorGuardSummary,
    | "denied"
    | "privateBlocks"
    | "contradictions"
    | "approvalReplayBlocks"
    | "staleRecalls"
    | "approvalExpirations"
    | "pendingApprovals"
  >,
  thresholds?: MemoryCuratorGuardAlertThresholds,
): MemoryCuratorGuardAlert[] {
  const activeThresholds = normalizeAlertThresholds(thresholds);
  const definitions: Array<{
    id: string;
    severity: "warning" | "critical";
    metric: MemoryCuratorGuardAlertMetric;
    label: string;
  }> = [
    {
      id: "memory-curator.denied-threshold",
      severity: "warning",
      metric: "denied",
      label: "Denied Memory Curator decisions",
    },
    {
      id: "memory-curator.private-blocks-threshold",
      severity: "critical",
      metric: "privateBlocks",
      label: "Private memory blocks",
    },
    {
      id: "memory-curator.contradictions-threshold",
      severity: "critical",
      metric: "contradictions",
      label: "Contradiction detections",
    },
    {
      id: "memory-curator.replay-blocks-threshold",
      severity: "critical",
      metric: "approvalReplayBlocks",
      label: "Approval replay blocks",
    },
    {
      id: "memory-curator.stale-recalls-threshold",
      severity: "warning",
      metric: "staleRecalls",
      label: "Stale recall events",
    },
    {
      id: "memory-curator.approval-expirations-threshold",
      severity: "warning",
      metric: "approvalExpirations",
      label: "Expired approval decisions",
    },
    {
      id: "memory-curator.pending-approvals-threshold",
      severity: "warning",
      metric: "pendingApprovals",
      label: "Pending Memory Curator approvals",
    },
  ];
  return definitions.flatMap((definition) => {
    const value = summary[definition.metric];
    const threshold = activeThresholds[definition.metric];
    return value >= threshold
      ? [
          createGuardAlert({
            ...definition,
            value,
            threshold,
          }),
        ]
      : [];
  });
}

function createEmptyTrendBucket(bucketStartMs: number): MemoryCuratorGuardTrendBucket {
  return {
    bucketStartIso: new Date(bucketStartMs).toISOString(),
    bucketEndIso: new Date(bucketStartMs + DAY_MS).toISOString(),
    allowed: 0,
    denied: 0,
    approvalRequired: 0,
    privateBlocks: 0,
    contradictions: 0,
    staleRecalls: 0,
    approvalReplayBlocks: 0,
    approvalExpirations: 0,
  };
}

function addTrendEvent(
  buckets: Map<number, MemoryCuratorGuardTrendBucket>,
  event: MemoryHostEvent,
  options?: MemoryCuratorGuardOptions,
): void {
  if (!event.type.startsWith("memory.curator.")) {
    return;
  }
  const eventMs = Date.parse(event.timestamp);
  if (!Number.isFinite(eventMs)) {
    return;
  }
  const days = normalizeTrendDays(options?.days);
  const endMs = startOfUtcDayMs(normalizeTrendNowMs(options?.nowIso)) + DAY_MS;
  const startMs = endMs - days * DAY_MS;
  if (eventMs < startMs || eventMs >= endMs) {
    return;
  }
  const bucketStartMs = startOfUtcDayMs(eventMs);
  const bucket = buckets.get(bucketStartMs) ?? createEmptyTrendBucket(bucketStartMs);
  if (event.type === "memory.curator.decision.allow") {
    bucket.allowed += 1;
  } else if (event.type === "memory.curator.decision.deny") {
    bucket.denied += 1;
  } else if (event.type === "memory.curator.decision.approval_required") {
    bucket.approvalRequired += 1;
  } else if (event.type === "memory.curator.private_memory_blocked") {
    bucket.privateBlocks += 1;
  } else if (event.type === "memory.curator.contradiction_detected") {
    bucket.contradictions += 1;
  } else if (event.type === "memory.curator.stale_recall") {
    bucket.staleRecalls += 1;
  } else if (event.type === "memory.curator.approval.replay_blocked") {
    bucket.approvalReplayBlocks += 1;
  } else if (event.type === "memory.curator.approval.expired") {
    bucket.approvalExpirations += 1;
  } else {
    return;
  }
  buckets.set(bucketStartMs, bucket);
}

function buildTrendBuckets(
  events: readonly MemoryHostEvent[],
  options?: MemoryCuratorGuardOptions,
): MemoryCuratorGuardTrendBucket[] {
  const buckets = new Map<number, MemoryCuratorGuardTrendBucket>();
  for (const event of events) {
    addTrendEvent(buckets, event, options);
  }
  return [...buckets.entries()]
    .toSorted(([left], [right]) => left - right)
    .slice(-MAX_TREND_BUCKET_DAYS)
    .map(([, bucket]) => bucket);
}

function isMemoryCuratorEvent(event: MemoryHostEvent): boolean {
  return event.type.startsWith("memory.curator.");
}

function filterMemoryCuratorEventsByWindow(
  events: readonly MemoryHostEvent[],
  options?: MemoryCuratorGuardOptions,
): MemoryHostEvent[] {
  const days = normalizeAuditDays(options?.days);
  const endMs = startOfUtcDayMs(normalizeTrendNowMs(options?.nowIso)) + DAY_MS;
  const startMs = endMs - days * DAY_MS;
  return events.filter((event) => {
    if (!isMemoryCuratorEvent(event)) {
      return false;
    }
    const eventMs = Date.parse(event.timestamp);
    return Number.isFinite(eventMs) && eventMs >= startMs && eventMs < endMs;
  });
}

export function summarizeMemoryCuratorGuardEvents(
  events: readonly MemoryHostEvent[],
  options?: MemoryCuratorGuardOptions,
): MemoryCuratorGuardSummary {
  const summary: MemoryCuratorGuardSummary = { ...EMPTY_MEMORY_CURATOR_GUARD_SUMMARY };
  const pendingApprovalIds = new Set<string>();
  let anonymousPendingApprovals = 0;
  for (const event of events) {
    if (!event.type.startsWith("memory.curator.")) {
      continue;
    }
    summary.lastDecisionAt = latestIso(summary.lastDecisionAt, event.timestamp);
    if (event.type === "memory.curator.decision.allow") {
      summary.totalDecisions += 1;
      summary.allowed += 1;
      if (hasRedactedPreview(event)) {
        summary.redactions += 1;
      }
      continue;
    }
    if (event.type === "memory.curator.decision.deny") {
      summary.totalDecisions += 1;
      summary.denied += 1;
      if (hasRedactedPreview(event)) {
        summary.redactions += 1;
      }
      continue;
    }
    if (event.type === "memory.curator.decision.approval_required") {
      summary.totalDecisions += 1;
      summary.approvalRequired += 1;
      if (hasRedactedPreview(event)) {
        summary.redactions += 1;
      }
      continue;
    }
    if (event.type === "memory.curator.redacted") {
      summary.redactions += 1;
      continue;
    }
    if (event.type === "memory.curator.private_memory_blocked") {
      summary.privateBlocks += 1;
      continue;
    }
    if (event.type === "memory.curator.stale_recall") {
      summary.staleRecalls += 1;
      continue;
    }
    if (event.type === "memory.curator.contradiction_detected") {
      summary.contradictions += 1;
      continue;
    }
    if (event.type === "memory.curator.approval.requested") {
      summary.approvalRequests += 1;
      summary.lastApprovalRequestedAt = latestIso(summary.lastApprovalRequestedAt, event.timestamp);
      if (event.approvalId) {
        pendingApprovalIds.add(event.approvalId);
      } else {
        anonymousPendingApprovals += 1;
      }
      continue;
    }
    if (event.type === "memory.curator.approval.allowed_once") {
      summary.approvalsAllowedOnce += 1;
      if (event.approvalId) {
        pendingApprovalIds.delete(event.approvalId);
      }
      continue;
    }
    if (event.type === "memory.curator.approval.denied") {
      summary.approvalDenials += 1;
      if (event.approvalId) {
        pendingApprovalIds.delete(event.approvalId);
      }
      continue;
    }
    if (event.type === "memory.curator.approval.expired") {
      summary.approvalExpirations += 1;
      if (event.approvalId) {
        pendingApprovalIds.delete(event.approvalId);
      }
      continue;
    }
    if (event.type === "memory.curator.approval.replay_blocked") {
      summary.approvalReplayBlocks += 1;
      if (event.approvalId) {
        pendingApprovalIds.delete(event.approvalId);
      }
    }
  }
  summary.pendingApprovals = pendingApprovalIds.size + anonymousPendingApprovals;
  summary.trendBuckets = buildTrendBuckets(events, options);
  summary.alerts = buildMemoryCuratorGuardAlerts(summary, options?.alertThresholds);
  return summary;
}

export function buildMemoryCuratorAuditReport(
  events: readonly MemoryHostEvent[],
  options?: MemoryCuratorGuardOptions,
): MemoryCuratorAuditReport {
  const windowDays = normalizeAuditDays(options?.days);
  const generatedAt = new Date(normalizeTrendNowMs(options?.nowIso)).toISOString();
  const curatorEvents = filterMemoryCuratorEventsByWindow(events, {
    ...options,
    days: windowDays,
  });
  const summary = summarizeMemoryCuratorGuardEvents(curatorEvents, {
    ...options,
    days: windowDays,
  });
  return {
    generatedAt,
    windowDays,
    sourceEventCount: events.length,
    curatorEventCount: curatorEvents.length,
    summary,
    decisionEventCounts: {
      allow: summary.allowed,
      deny: summary.denied,
      approvalRequired: summary.approvalRequired,
    },
    approvalEventCounts: {
      requested: summary.approvalRequests,
      pending: summary.pendingApprovals,
      allowedOnce: summary.approvalsAllowedOnce,
      denied: summary.approvalDenials,
      expired: summary.approvalExpirations,
      replayBlocked: summary.approvalReplayBlocks,
    },
    signalEventCounts: {
      redacted: summary.redactions,
      privateMemoryBlocked: summary.privateBlocks,
      staleRecall: summary.staleRecalls,
      contradictionDetected: summary.contradictions,
    },
    alertCounts: {
      total: summary.alerts.length,
      warning: summary.alerts.filter((alert) => alert.severity === "warning").length,
      critical: summary.alerts.filter((alert) => alert.severity === "critical").length,
    },
    trendBuckets: summary.trendBuckets,
  };
}

function mergeTrendBuckets(
  summaries: readonly MemoryCuratorGuardSummary[],
): MemoryCuratorGuardTrendBucket[] {
  const bucketMap = new Map<string, MemoryCuratorGuardTrendBucket>();
  for (const summary of summaries) {
    for (const bucket of summary.trendBuckets) {
      const existing = bucketMap.get(bucket.bucketStartIso) ?? {
        bucketStartIso: bucket.bucketStartIso,
        bucketEndIso: bucket.bucketEndIso,
        allowed: 0,
        denied: 0,
        approvalRequired: 0,
        privateBlocks: 0,
        contradictions: 0,
        staleRecalls: 0,
        approvalReplayBlocks: 0,
        approvalExpirations: 0,
      };
      existing.allowed += bucket.allowed;
      existing.denied += bucket.denied;
      existing.approvalRequired += bucket.approvalRequired;
      existing.privateBlocks += bucket.privateBlocks;
      existing.contradictions += bucket.contradictions;
      existing.staleRecalls += bucket.staleRecalls;
      existing.approvalReplayBlocks += bucket.approvalReplayBlocks;
      existing.approvalExpirations += bucket.approvalExpirations;
      bucketMap.set(bucket.bucketStartIso, existing);
    }
  }
  return [...bucketMap.values()]
    .toSorted((left, right) => Date.parse(left.bucketStartIso) - Date.parse(right.bucketStartIso))
    .slice(-MAX_TREND_BUCKET_DAYS);
}

export function mergeMemoryCuratorGuardSummaries(
  summaries: readonly MemoryCuratorGuardSummary[],
  options?: { alertThresholds?: MemoryCuratorGuardAlertThresholds },
): MemoryCuratorGuardSummary {
  const merged: MemoryCuratorGuardSummary = { ...EMPTY_MEMORY_CURATOR_GUARD_SUMMARY };
  for (const summary of summaries) {
    merged.totalDecisions += summary.totalDecisions;
    merged.allowed += summary.allowed;
    merged.denied += summary.denied;
    merged.approvalRequired += summary.approvalRequired;
    merged.redactions += summary.redactions;
    merged.privateBlocks += summary.privateBlocks;
    merged.staleRecalls += summary.staleRecalls;
    merged.contradictions += summary.contradictions;
    merged.approvalRequests += summary.approvalRequests;
    merged.pendingApprovals += summary.pendingApprovals;
    merged.approvalsAllowedOnce += summary.approvalsAllowedOnce;
    merged.approvalDenials += summary.approvalDenials;
    merged.approvalExpirations += summary.approvalExpirations;
    merged.approvalReplayBlocks += summary.approvalReplayBlocks;
    merged.lastDecisionAt = latestIso(merged.lastDecisionAt, summary.lastDecisionAt);
    merged.lastApprovalRequestedAt = latestIso(
      merged.lastApprovalRequestedAt,
      summary.lastApprovalRequestedAt,
    );
  }
  merged.trendBuckets = mergeTrendBuckets(summaries);
  merged.alerts = buildMemoryCuratorGuardAlerts(merged, options?.alertThresholds);
  return merged;
}

export async function loadMemoryCuratorGuardSummary(params: {
  workspaceDirs: readonly string[];
  limit?: number;
  trendDays?: number;
  nowIso?: string;
  alertThresholds?: MemoryCuratorGuardAlertThresholds;
}): Promise<MemoryCuratorGuardSummary> {
  const summaries = await Promise.all(
    [...new Set(params.workspaceDirs)]
      .filter((workspaceDir) => workspaceDir.trim().length > 0)
      .map(async (workspaceDir) =>
        summarizeMemoryCuratorGuardEvents(
          await readMemoryHostEvents({ workspaceDir, limit: params.limit }),
          {
            days: params.trendDays,
            nowIso: params.nowIso,
            alertThresholds: params.alertThresholds,
          },
        ),
      ),
  );
  return mergeMemoryCuratorGuardSummaries(summaries, {
    alertThresholds: params.alertThresholds,
  });
}

export async function loadMemoryCuratorAuditReport(params: {
  workspaceDirs: readonly string[];
  days?: number;
  nowIso?: string;
  alertThresholds?: MemoryCuratorGuardAlertThresholds;
}): Promise<MemoryCuratorAuditReport> {
  const events = (
    await Promise.all(
      [...new Set(params.workspaceDirs)]
        .filter((workspaceDir) => workspaceDir.trim().length > 0)
        .map(async (workspaceDir) => await readMemoryHostEvents({ workspaceDir })),
    )
  ).flat();
  return buildMemoryCuratorAuditReport(events, {
    days: params.days,
    nowIso: params.nowIso,
    alertThresholds: params.alertThresholds,
  });
}
