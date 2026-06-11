import { listSelfImprovementAuditEvents } from "./audit-events.js";
import { loadSelfImprovementOperationalHealth } from "./operational-health.js";
import { sanitizeRecommendationTexts } from "./text.js";
import type {
  SelfImprovementOperationalHealth,
  SelfImprovementOperationalHealthDimension,
  SelfImprovementOperationalHealthStatus,
  SelfImprovementProductionCheckResult,
  SelfImprovementProductionReadinessEvidence,
} from "./types.js";

function statusRank(status: SelfImprovementOperationalHealthStatus): number {
  switch (status) {
    case "blocked":
      return 3;
    case "degraded":
      return 2;
    case "ready":
      return 1;
  }
}

function worstStatus(
  statuses: readonly SelfImprovementOperationalHealthStatus[],
): SelfImprovementOperationalHealthStatus {
  return statuses.toSorted((left, right) => statusRank(right) - statusRank(left))[0] ?? "ready";
}

function dimensionEvidence(
  dimension: SelfImprovementOperationalHealthDimension,
): SelfImprovementProductionReadinessEvidence {
  return {
    key: dimension.id,
    label: dimension.label,
    status: dimension.status,
    summary: dimension.summary,
    source: `operational-health:${dimension.id}`,
  };
}

function metricBoolean(
  dimension: SelfImprovementOperationalHealthDimension | undefined,
  key: string,
): boolean | undefined {
  const value = dimension?.metrics.find((metric) => metric.key === key)?.value;
  return typeof value === "boolean" ? value : undefined;
}

function auditBoolean(
  metadata: Record<string, string | number | boolean | string[]> | undefined,
  key: string,
): boolean | undefined {
  const value = metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function auditString(
  metadata: Record<string, string | number | boolean | string[]> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function requireDimensionReady(params: {
  dimension: SelfImprovementOperationalHealthDimension | undefined;
  label: string;
  source: string;
  missingBlocker: string;
  evidence: SelfImprovementProductionReadinessEvidence[];
  blockers: string[];
  statuses: SelfImprovementOperationalHealthStatus[];
}) {
  if (!params.dimension) {
    params.statuses.push("blocked");
    params.blockers.push(params.missingBlocker);
    params.evidence.push({
      key: params.source,
      label: params.label,
      status: "blocked",
      summary: params.missingBlocker,
      source: "production-check",
    });
    return;
  }
  const readyMetric = metricBoolean(params.dimension, "ready");
  const status =
    params.dimension.status === "ready" && readyMetric !== false
      ? "ready"
      : params.dimension.status;
  params.statuses.push(status);
  if (status !== "ready") {
    params.blockers.push(`${params.label} is ${status}.`);
  }
}

export async function runSelfImprovementProductionCheck(params?: {
  stateDir?: string;
  days?: number;
  limit?: number;
  failOnDegraded?: boolean;
  failOnBlocked?: boolean;
  requireModelReady?: boolean;
  requireEvalsReady?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<SelfImprovementProductionCheckResult> {
  const checkedAt = params?.now ?? Date.now();
  const healthResult = await loadSelfImprovementOperationalHealth({
    stateDir: params?.stateDir,
    days: params?.days,
    limit: params?.limit,
    env: params?.env,
    now: checkedAt,
  });
  const health = healthResult.current;
  const events = await listSelfImprovementAuditEvents({
    stateDir: params?.stateDir,
    limit: 100,
  });
  const reviewerEval = health.dimensions.find((dimension) => dimension.id === "reviewer");
  const modelReadiness = health.dimensions.find((dimension) => dimension.id === "models");
  const background = health.dimensions.find((dimension) => dimension.id === "background");
  const evidence = health.dimensions.map(dimensionEvidence);
  const statuses: SelfImprovementOperationalHealthStatus[] = [health.status];
  const blockers = [...health.blockers];
  const warnings: string[] = [];

  if (params?.requireModelReady) {
    if (!healthResult.latestModelPreflight) {
      statuses.push("blocked");
      blockers.push("Model readiness proof is required, but no model preflight event exists.");
    } else if (
      auditBoolean(healthResult.latestModelPreflight.metadata, "ready") === false ||
      auditString(healthResult.latestModelPreflight.metadata, "readiness") === "blocked"
    ) {
      statuses.push("blocked");
      blockers.push("Latest model preflight is not ready.");
    }
    requireDimensionReady({
      dimension: modelReadiness,
      label: "Model readiness",
      source: "models",
      missingBlocker: "Model readiness dimension is missing.",
      evidence,
      blockers,
      statuses,
    });
  } else if (modelReadiness?.status !== "ready") {
    warnings.push("Model readiness is not ready; require it with --require-model-ready.");
  }

  if (params?.requireEvalsReady) {
    if (!healthResult.latestReviewerEval) {
      statuses.push("blocked");
      blockers.push("Reviewer eval proof is required, but no reviewer eval event exists.");
    } else if (
      auditBoolean(healthResult.latestReviewerEval.metadata, "ready") === false ||
      auditString(healthResult.latestReviewerEval.metadata, "readiness") === "blocked"
    ) {
      statuses.push("blocked");
      blockers.push("Latest reviewer eval is not ready.");
    }
    requireDimensionReady({
      dimension: reviewerEval,
      label: "Reviewer evals",
      source: "reviewer",
      missingBlocker: "Reviewer eval dimension is missing.",
      evidence,
      blockers,
      statuses,
    });
  } else if (reviewerEval?.status !== "ready") {
    warnings.push("Reviewer evals are not ready; require them with --require-evals-ready.");
  }

  if (background?.status !== "ready") {
    blockers.push("Background cadence is not ready.");
    statuses.push(background?.status ?? "blocked");
  }

  const latestMaintenance = events.find((event) => event.kind === "retention_maintenance");
  evidence.push({
    key: "maintenance",
    label: "Retention maintenance",
    status: latestMaintenance ? "ready" : "degraded",
    summary: latestMaintenance
      ? "Retention maintenance has a sanitized audit event."
      : "No retention maintenance audit event is recorded yet.",
    source: "audit-events:retention_maintenance",
    ...(latestMaintenance ? { generatedAt: latestMaintenance.createdAt } : {}),
  });
  if (!latestMaintenance) {
    warnings.push("No retention maintenance audit event is recorded yet.");
  }

  const status = worstStatus(statuses);
  const sanitizedBlockers = sanitizeRecommendationTexts(blockers, 240);
  const sanitizedWarnings = sanitizeRecommendationTexts(warnings, 240);
  const nextActions = sanitizeRecommendationTexts(
    [...health.nextActions, ...sanitizedWarnings].slice(0, 8),
    240,
  );
  return {
    checkedAt,
    status,
    ready: status === "ready",
    score: health.score,
    failOnDegraded: Boolean(params?.failOnDegraded),
    failOnBlocked: Boolean(params?.failOnBlocked),
    requireModelReady: Boolean(params?.requireModelReady),
    requireEvalsReady: Boolean(params?.requireEvalsReady),
    blockers: sanitizedBlockers,
    warnings: sanitizedWarnings,
    nextActions,
    evidence,
    health: health as SelfImprovementOperationalHealth,
  };
}
