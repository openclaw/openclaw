import { sanitizeRecommendationText, sanitizeRecommendationTexts } from "./text.js";
import type {
  SelfImprovementActionQueueItem,
  SelfImprovementActionQueueSummary,
  SelfImprovementActionability,
  SelfImprovementActionabilityClosureState,
  SelfImprovementActionabilityOwnerState,
  SelfImprovementActionabilityProofState,
  SelfImprovementActionabilitySlaState,
  SelfImprovementRecommendation,
  SelfImprovementRecommendationGroup,
  SelfImprovementRecommendationSeverity,
  SelfImprovementRecommendationStatus,
} from "./types.js";

const DAY_MS = 24 * 60 * 60_000;

const SLA_MS_BY_PRIORITY: Record<SelfImprovementRecommendationSeverity, number> = {
  critical: DAY_MS,
  high: 3 * DAY_MS,
  medium: 7 * DAY_MS,
  low: 14 * DAY_MS,
};

const PRIORITY_RANK: Record<SelfImprovementRecommendationSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const CLOSED_STATUSES = new Set<SelfImprovementRecommendationStatus>(["resolved", "dismissed"]);

function isClosed(status: SelfImprovementRecommendationStatus): boolean {
  return CLOSED_STATUSES.has(status);
}

function hasText(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function ownerState(value: {
  status: SelfImprovementRecommendationStatus;
  assignedTargetAgentId?: string;
  claimedBy?: string;
}): SelfImprovementActionabilityOwnerState {
  if (hasText(value.claimedBy)) {
    return "claimed";
  }
  if (
    hasText(value.assignedTargetAgentId) ||
    value.status === "assigned" ||
    value.status === "in_progress"
  ) {
    return "assigned";
  }
  return "unassigned";
}

function proofState(value: {
  requiresTests: boolean;
  requiresApproval: boolean;
  resolutionProof?: string;
}): SelfImprovementActionabilityProofState {
  if (hasText(value.resolutionProof)) {
    return "attached";
  }
  return value.requiresTests || value.requiresApproval ? "missing" : "not_required";
}

function slaState(params: {
  status: SelfImprovementRecommendationStatus;
  now: number;
  updatedAt: number;
  slaMs: number;
}): SelfImprovementActionabilitySlaState {
  if (isClosed(params.status)) {
    return "fresh";
  }
  const ageMs = Math.max(0, params.now - params.updatedAt);
  if (ageMs > params.slaMs) {
    return "overdue";
  }
  return ageMs >= Math.floor(params.slaMs * 0.7) ? "aging" : "fresh";
}

function closureState(params: {
  status: SelfImprovementRecommendationStatus;
  ownerState: SelfImprovementActionabilityOwnerState;
  proofState: SelfImprovementActionabilityProofState;
}): SelfImprovementActionabilityClosureState {
  if (isClosed(params.status)) {
    return "closed";
  }
  if (params.proofState === "missing") {
    return "blocked";
  }
  if (params.ownerState === "unassigned") {
    return "blocked";
  }
  return "ready_to_resolve";
}

function nextAction(params: {
  ownerState: SelfImprovementActionabilityOwnerState;
  slaState: SelfImprovementActionabilitySlaState;
  proofState: SelfImprovementActionabilityProofState;
  closureState: SelfImprovementActionabilityClosureState;
}): string {
  if (params.closureState === "closed") {
    return "No action required.";
  }
  if (params.slaState === "overdue" && params.ownerState === "unassigned") {
    return "Assign an owner immediately and attach the proof path.";
  }
  if (params.ownerState === "unassigned") {
    return "Assign the routed owner.";
  }
  if (params.proofState === "missing") {
    return "Attach verification or approval proof before resolving.";
  }
  if (params.slaState === "overdue") {
    return "Resolve or escalate the overdue item with proof.";
  }
  return "Resolve when the owner confirms the proof.";
}

function rank(params: {
  priority: SelfImprovementRecommendationSeverity;
  ownerState: SelfImprovementActionabilityOwnerState;
  slaState: SelfImprovementActionabilitySlaState;
  proofState: SelfImprovementActionabilityProofState;
  closureState: SelfImprovementActionabilityClosureState;
}): number {
  if (params.closureState === "closed") {
    return 0;
  }
  return (
    PRIORITY_RANK[params.priority] * 1_000 +
    (params.slaState === "overdue" ? 500 : params.slaState === "aging" ? 150 : 0) +
    (params.ownerState === "unassigned" ? 250 : params.ownerState === "assigned" ? 100 : 0) +
    (params.proofState === "missing" ? 200 : 0) +
    (params.closureState === "ready_to_resolve" ? 75 : 0)
  );
}

function deriveActionability(params: {
  status: SelfImprovementRecommendationStatus;
  priority: SelfImprovementRecommendationSeverity;
  updatedAt: number;
  now: number;
  requiresTests: boolean;
  requiresApproval: boolean;
  assignedTargetAgentId?: string;
  claimedBy?: string;
  resolutionProof?: string;
}): SelfImprovementActionability {
  const slaMs = SLA_MS_BY_PRIORITY[params.priority];
  const ageMs = Math.max(0, params.now - params.updatedAt);
  const dueAt = params.updatedAt + slaMs;
  const owner = ownerState(params);
  const proof = proofState(params);
  const sla = slaState({
    status: params.status,
    now: params.now,
    updatedAt: params.updatedAt,
    slaMs,
  });
  const closure = closureState({
    status: params.status,
    ownerState: owner,
    proofState: proof,
  });
  const blockers = sanitizeRecommendationTexts(
    [
      owner === "unassigned" && !isClosed(params.status) ? "No owner assigned." : "",
      sla === "overdue" ? "SLA is overdue." : "",
      proof === "missing" ? "Resolution proof is missing." : "",
    ].filter(Boolean),
    180,
  );
  return {
    ownerState: owner,
    slaState: sla,
    proofState: proof,
    closureState: closure,
    rank: rank({
      priority: params.priority,
      ownerState: owner,
      slaState: sla,
      proofState: proof,
      closureState: closure,
    }),
    ageMs,
    slaMs,
    dueAt,
    overdueMs: Math.max(0, params.now - dueAt),
    blockers,
    nextAction: sanitizeRecommendationText(
      nextAction({
        ownerState: owner,
        slaState: sla,
        proofState: proof,
        closureState: closure,
      }),
      180,
    ),
  };
}

export function deriveSelfImprovementRecommendationActionability(
  recommendation: SelfImprovementRecommendation,
  now = Date.now(),
): SelfImprovementActionability {
  return deriveActionability({
    status: recommendation.status,
    priority: recommendation.priority,
    updatedAt: Math.max(recommendation.updatedAt, recommendation.lastSeenAt),
    now,
    requiresTests: recommendation.safety.requiresTests,
    requiresApproval: recommendation.safety.requiresApproval,
    assignedTargetAgentId: recommendation.assignedTargetAgentId,
    claimedBy: recommendation.claimedBy,
    resolutionProof: recommendation.resolutionProof,
  });
}

export function deriveSelfImprovementGroupActionability(
  group: SelfImprovementRecommendationGroup,
  recommendations: readonly SelfImprovementRecommendation[],
  now = Date.now(),
): SelfImprovementActionability {
  const groupRecommendations = recommendations.filter((entry) =>
    group.recommendationIds.includes(entry.id),
  );
  const assigned = groupRecommendations.find((entry) => hasText(entry.assignedTargetAgentId));
  const claimed = groupRecommendations.find((entry) => hasText(entry.claimedBy));
  const proof = groupRecommendations.find((entry) => hasText(entry.resolutionProof));
  return deriveActionability({
    status: group.status,
    priority: group.priority,
    updatedAt: group.lastUpdatedAt,
    now,
    requiresTests: group.requiresTests,
    requiresApproval: group.requiresApproval,
    assignedTargetAgentId: assigned?.assignedTargetAgentId,
    claimedBy: claimed?.claimedBy,
    resolutionProof: proof?.resolutionProof,
  });
}

function queueItemFromRecommendation(
  recommendation: SelfImprovementRecommendation,
  now: number,
): SelfImprovementActionQueueItem {
  const actionability =
    recommendation.actionability ??
    deriveSelfImprovementRecommendationActionability(recommendation, now);
  return {
    kind: "recommendation",
    id: recommendation.id,
    title: recommendation.title,
    status: recommendation.status,
    priority: recommendation.priority,
    route: recommendation.route,
    actionability,
  };
}

export function buildSelfImprovementActionQueue(params: {
  recommendations: readonly SelfImprovementRecommendation[];
  groups?: readonly SelfImprovementRecommendationGroup[];
  now?: number;
  limit?: number;
}): SelfImprovementActionQueueSummary {
  const now = params.now ?? Date.now();
  const sourceItems =
    params.groups && params.groups.length > 0
      ? params.groups.map((group) => ({
          kind: "group" as const,
          id: group.id,
          title: group.title,
          status: group.status,
          priority: group.priority,
          route: group.route,
          actionability:
            group.actionability ??
            deriveSelfImprovementGroupActionability(group, params.recommendations, now),
        }))
      : params.recommendations.map((recommendation) =>
          queueItemFromRecommendation(recommendation, now),
        );
  const activeItems = sourceItems.filter(
    (item) => item.status !== "resolved" && item.status !== "dismissed",
  );
  const sorted = activeItems.toSorted(
    (left, right) =>
      right.actionability.rank - left.actionability.rank ||
      right.actionability.overdueMs - left.actionability.overdueMs ||
      left.title.localeCompare(right.title),
  );
  const limit = params.limit && params.limit > 0 ? params.limit : 10;
  return {
    generatedAt: now,
    total: activeItems.length,
    unassigned: activeItems.filter((item) => item.actionability.ownerState === "unassigned").length,
    overdue: activeItems.filter((item) => item.actionability.slaState === "overdue").length,
    proofMissing: activeItems.filter((item) => item.actionability.proofState === "missing").length,
    readyToResolve: activeItems.filter(
      (item) => item.actionability.closureState === "ready_to_resolve",
    ).length,
    blocked: activeItems.filter((item) => item.actionability.closureState === "blocked").length,
    items: sorted.slice(0, limit),
  };
}
