import crypto from "node:crypto";
import {
  buildSelfImprovementActionQueue,
  deriveSelfImprovementGroupActionability,
} from "./actionability.js";
import { buildSelfImprovementIntelligenceSummary } from "./intelligence.js";
import { sanitizeRecommendationText, sanitizeRecommendationTexts } from "./text.js";
import type {
  SelfImprovementActionQueueSummary,
  SelfImprovementRecommendation,
  SelfImprovementRecommendationAnalysis,
  SelfImprovementRecommendationCategory,
  SelfImprovementRecommendationGroup,
  SelfImprovementRecommendationSeverity,
  SelfImprovementRecommendationStatus,
  SelfImprovementRouteRole,
  SelfImprovementScorecard,
  SelfImprovementScorecardBucket,
  SelfImprovementSummaryResult,
} from "./types.js";

const DAY_MS = 24 * 60 * 60_000;

const SEVERITY_ORDER: Record<SelfImprovementRecommendationSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const ACTIVE_STATUSES = new Set<SelfImprovementRecommendationStatus>([
  "open",
  "acknowledged",
  "assigned",
  "in_progress",
  "reopened",
  "quarantined",
]);

const STATUS_PRIORITY: Record<SelfImprovementRecommendationStatus, number> = {
  reopened: 7,
  quarantined: 6,
  open: 5,
  in_progress: 4,
  assigned: 3,
  acknowledged: 2,
  resolved: 1,
  dismissed: 0,
};

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function label(value: string): string {
  return value.replace(/_/g, " ");
}

function normalizedGroupText(value: string): string {
  return sanitizeRecommendationText(value, 160)
    .toLowerCase()
    .replace(/\bsir_[a-f0-9]+\b/g, "sir")
    .replace(/\btask[-_:][a-z0-9-]+\b/g, "task")
    .replace(/\brun[-_:][a-z0-9-]+\b/g, "run")
    .replace(/\b\d{8}t\d{6}z[-_:]\d+\b/g, "snapshot")
    .replace(/\b[0-9a-f]{8,}\b/g, "id")
    .replace(/\d+/g, "n")
    .replace(/\s+/g, " ")
    .trim();
}

export function isActiveSelfImprovementStatus(
  status: SelfImprovementRecommendationStatus,
): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function deriveSelfImprovementGroupKey(
  recommendation: SelfImprovementRecommendation,
): string {
  const source = recommendation.source;
  const sourceKey =
    source.cronJobId ?? source.proposalId ?? source.agentId ?? source.sessionKey ?? source.kind;
  return [
    recommendation.category,
    source.kind,
    sourceKey,
    normalizedGroupText(recommendation.groupTitle || recommendation.title),
  ]
    .filter(Boolean)
    .join(":");
}

function pickHighestSeverity(
  left: SelfImprovementRecommendationSeverity,
  right: SelfImprovementRecommendationSeverity,
): SelfImprovementRecommendationSeverity {
  return SEVERITY_ORDER[right] > SEVERITY_ORDER[left] ? right : left;
}

function pickStatus(statuses: readonly SelfImprovementRecommendationStatus[]) {
  return statuses.toSorted((left, right) => STATUS_PRIORITY[right] - STATUS_PRIORITY[left])[0];
}

function aggregateAnalysis(params: {
  recommendations: readonly SelfImprovementRecommendation[];
  generatedAt: number;
  title: string;
  count: number;
}): SelfImprovementRecommendationAnalysis {
  const llm = params.recommendations.find((entry) => entry.analysis.mode === "llm")?.analysis;
  if (llm) {
    return llm;
  }
  const evidenceCount = params.recommendations.reduce(
    (sum, entry) => sum + entry.evidence.length,
    0,
  );
  const requiresTests = params.recommendations.some((entry) => entry.safety.requiresTests);
  const requiresApproval = params.recommendations.some((entry) => entry.safety.requiresApproval);
  return {
    mode: "deterministic",
    summary:
      params.count === 1
        ? `One evidence-backed recommendation is ready for routed review: ${params.title}.`
        : `${params.count} related recommendations are grouped for routed review: ${params.title}.`,
    generatedAt: params.generatedAt,
    confidence: Math.min(
      0.95,
      params.recommendations.reduce((sum, entry) => sum + entry.confidence, 0) /
        Math.max(1, params.recommendations.length),
    ),
    promptVersion: "self-improvement-deterministic-v1",
    evidenceCount,
    safetyNotes: [
      "Recommendation-only; the governor does not merge, push, release, or write skills.",
      requiresTests
        ? "Resolution should include test or smoke proof."
        : "Tests are optional unless follow-up changes code or config.",
      requiresApproval
        ? "Follow-up changes require operator approval."
        : "Follow-up can proceed through the routed owner review path.",
    ],
  };
}

function countStatuses(recommendations: readonly SelfImprovementRecommendation[]) {
  const counts = new Map<SelfImprovementRecommendationStatus, number>();
  for (const recommendation of recommendations) {
    counts.set(recommendation.status, (counts.get(recommendation.status) ?? 0) + 1);
  }
  return counts;
}

function groupRecommendations(
  recommendations: readonly SelfImprovementRecommendation[],
  now: number,
): SelfImprovementRecommendationGroup[] {
  const byKey = new Map<string, SelfImprovementRecommendation[]>();
  for (const recommendation of recommendations) {
    const key = recommendation.groupKey || deriveSelfImprovementGroupKey(recommendation);
    byKey.set(key, [...(byKey.get(key) ?? []), recommendation]);
  }
  return [...byKey.entries()]
    .map(([groupKey, groupRecommendations]) => {
      const sorted = groupRecommendations.toSorted(
        (left, right) => right.lastSeenAt - left.lastSeenAt || left.id.localeCompare(right.id),
      );
      const lead = sorted.toSorted(
        (left, right) =>
          SEVERITY_ORDER[right.severity] - SEVERITY_ORDER[left.severity] ||
          right.updatedAt - left.updatedAt ||
          left.id.localeCompare(right.id),
      )[0];
      const statusCounts = countStatuses(sorted);
      const severity = sorted.reduce(
        (highest, entry) => pickHighestSeverity(highest, entry.severity),
        "low" as SelfImprovementRecommendationSeverity,
      );
      const priority = sorted.reduce(
        (highest, entry) => pickHighestSeverity(highest, entry.priority),
        severity,
      );
      const status = pickStatus(sorted.map((entry) => entry.status)) ?? lead.status;
      const topEvidence = sanitizeRecommendationTexts(
        sorted.flatMap((entry) => entry.evidence).filter(Boolean),
        220,
      ).slice(0, 5);
      const group = {
        id: `sig_${hash(groupKey)}`,
        groupKey,
        title: lead.groupTitle || lead.title,
        category: lead.category,
        severity,
        criticality: severity,
        priority,
        status,
        route: lead.route,
        count: sorted.reduce((sum, entry) => sum + Math.max(1, entry.recurrenceCount), 0),
        open: statusCounts.get("open") ?? 0,
        acknowledged: statusCounts.get("acknowledged") ?? 0,
        assigned: statusCounts.get("assigned") ?? 0,
        inProgress: statusCounts.get("in_progress") ?? 0,
        reopened: statusCounts.get("reopened") ?? 0,
        quarantined: statusCounts.get("quarantined") ?? 0,
        resolved: statusCounts.get("resolved") ?? 0,
        dismissed: statusCounts.get("dismissed") ?? 0,
        requiresTests: sorted.some((entry) => entry.safety.requiresTests),
        requiresApproval: sorted.some((entry) => entry.safety.requiresApproval),
        firstSeenAt: Math.min(...sorted.map((entry) => entry.createdAt)),
        lastSeenAt: Math.max(...sorted.map((entry) => entry.lastSeenAt)),
        lastUpdatedAt: Math.max(...sorted.map((entry) => entry.updatedAt)),
        recommendationIds: sorted.map((entry) => entry.id),
        topEvidence,
        recommendedAction: lead.recommendedAction,
        analysis: aggregateAnalysis({
          recommendations: sorted,
          generatedAt: now,
          title: lead.groupTitle || lead.title,
          count: sorted.length,
        }),
      } satisfies SelfImprovementRecommendationGroup;
      return {
        ...group,
        actionability: deriveSelfImprovementGroupActionability(group, sorted, now),
      } satisfies SelfImprovementRecommendationGroup;
    })
    .toSorted(
      (left, right) =>
        SEVERITY_ORDER[right.priority] - SEVERITY_ORDER[left.priority] ||
        right.lastSeenAt - left.lastSeenAt ||
        left.title.localeCompare(right.title),
    );
}

function bucketCounts<T extends string>(
  values: readonly T[],
  labelFor: (value: T) => string,
): SelfImprovementScorecardBucket[] {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: labelFor(key), count }))
    .toSorted((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function buildScorecard(params: {
  recommendations: readonly SelfImprovementRecommendation[];
  groups: readonly SelfImprovementRecommendationGroup[];
  activeGroupCount: number;
  actionQueue: SelfImprovementActionQueueSummary;
  now: number;
}): SelfImprovementScorecard {
  const activeRecommendations = params.recommendations.filter((entry) =>
    isActiveSelfImprovementStatus(entry.status),
  );
  const openLike = activeRecommendations.filter((entry) => entry.status !== "acknowledged");
  const resolvedCutoff = params.now - DAY_MS;
  return {
    generatedAt: params.now,
    totalRecommendations: params.recommendations.length,
    activeRecommendations: activeRecommendations.length,
    groupedRecommendations: params.activeGroupCount,
    criticalOpen: openLike.filter((entry) => entry.priority === "critical").length,
    highOpen: openLike.filter((entry) => entry.priority === "high").length,
    testRequired: activeRecommendations.filter((entry) => entry.safety.requiresTests).length,
    approvalRequired: activeRecommendations.filter((entry) => entry.safety.requiresApproval).length,
    reopenedLast24h: activeRecommendations.filter(
      (entry) => entry.status === "reopened" && entry.updatedAt >= resolvedCutoff,
    ).length,
    resolvedLast24h: params.recommendations.filter(
      (entry) => entry.status === "resolved" && entry.updatedAt >= resolvedCutoff,
    ).length,
    byCategory: bucketCounts(
      activeRecommendations.map((entry) => entry.category),
      (category: SelfImprovementRecommendationCategory) => label(category),
    ),
    byRoute: bucketCounts(
      activeRecommendations.map((entry) => entry.route.role),
      (role: SelfImprovementRouteRole) => label(role),
    ),
    needsApproval: params.groups
      .filter((group) => group.requiresApproval && isActiveSelfImprovementStatus(group.status))
      .slice(0, 5),
    whatImproved: params.groups
      .filter((group) => group.resolved > 0)
      .toSorted((left, right) => right.lastUpdatedAt - left.lastUpdatedAt)
      .slice(0, 5),
    whatWorsened: params.groups
      .filter(
        (group) => group.reopened > 0 || group.status === "open" || group.status === "quarantined",
      )
      .slice(0, 5),
    actionQueue: params.actionQueue,
    intelligence: buildSelfImprovementIntelligenceSummary({
      recommendations: activeRecommendations,
      groups: params.groups.filter((group) => isActiveSelfImprovementStatus(group.status)),
      now: params.now,
    }),
  };
}

export function summarizeSelfImprovementRecommendations(params: {
  recommendations: readonly SelfImprovementRecommendation[];
  now?: number;
  statuses?: readonly SelfImprovementRecommendationStatus[];
  routes?: readonly SelfImprovementRouteRole[];
  limit?: number;
}): SelfImprovementSummaryResult {
  const now = params.now ?? Date.now();
  const statusFilter = params.statuses ? new Set(params.statuses) : ACTIVE_STATUSES;
  const routeFilter = params.routes ? new Set(params.routes) : null;
  const filtered = params.recommendations.filter(
    (entry) =>
      statusFilter.has(entry.status) && (!routeFilter || routeFilter.has(entry.route.role)),
  );
  const allGroups = groupRecommendations(params.recommendations, now);
  const groups = groupRecommendations(filtered, now);
  const limit = params.limit && params.limit > 0 ? params.limit : groups.length;
  const actionQueue = buildSelfImprovementActionQueue({
    recommendations: filtered,
    groups,
    now,
    limit: 10,
  });
  return {
    scorecard: buildScorecard({
      recommendations: params.recommendations,
      groups: allGroups,
      activeGroupCount: groups.length,
      actionQueue,
      now,
    }),
    groups: groups.slice(0, limit),
    totalGroups: groups.length,
    actionQueue,
  };
}
