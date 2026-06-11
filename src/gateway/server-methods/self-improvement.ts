import { resolveStateDir } from "../../config/paths.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { deriveSelfImprovementRecommendationActionability } from "../../self-improvement/actionability.js";
import { runSelfImprovementAnalysis } from "../../self-improvement/analysis.js";
import {
  appendSelfImprovementAuditEvent,
  appendSelfImprovementModelPreflightAuditEvent,
  listSelfImprovementAuditEvents,
} from "../../self-improvement/audit-events.js";
import { preflightSelfImprovementReviewModels } from "../../self-improvement/llm-reviewer.js";
import { runSelfImprovementMaintenance } from "../../self-improvement/maintenance.js";
import { loadSelfImprovementOperationalHealth } from "../../self-improvement/operational-health.js";
import { runSelfImprovementProductionCheck } from "../../self-improvement/production-readiness.js";
import {
  getSelfImprovementProposal,
  listSelfImprovementProposals,
  updateSelfImprovementCuratorStatus,
  updateSelfImprovementProposalStatus,
} from "../../self-improvement/proposals.js";
import { runSelfImprovementReviewerEvals } from "../../self-improvement/reviewer-evals.js";
import { runSelfImprovementGovernorScan } from "../../self-improvement/runner.js";
import { listSelfImprovementDailyScorecards } from "../../self-improvement/scorecard-store.js";
import {
  getSelfImprovementRecommendation,
  listSelfImprovementRecommendations,
  updateSelfImprovementRecommendationStatus,
} from "../../self-improvement/store.js";
import { summarizeSelfImprovementRecommendations } from "../../self-improvement/summary.js";
import type {
  SelfImprovementRecommendation,
  SelfImprovementAuditEventKind,
  SelfImprovementRecommendationCategory,
  SelfImprovementRecommendationSeverity,
  SelfImprovementRecommendationStatus,
  SelfImprovementProposalKind,
  SelfImprovementProposalStatus,
  SelfImprovementCuratorStatus,
  SelfImprovementRouteRole,
} from "../../self-improvement/types.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type SelfImprovementRecommendationsListParams,
  type SelfImprovementRecommendationsSummaryParams,
  validateSelfImprovementAnalysisRunParams,
  validateSelfImprovementAuditEventsListParams,
  validateSelfImprovementCuratorGetParams,
  validateSelfImprovementCuratorListParams,
  validateSelfImprovementCuratorUpdateParams,
  validateSelfImprovementHealthParams,
  validateSelfImprovementProductionCheckParams,
  validateSelfImprovementMaintenanceRunParams,
  validateSelfImprovementModelPreflightParams,
  validateSelfImprovementReviewerEvalRunParams,
  validateSelfImprovementGroupsUpdateParams,
  validateSelfImprovementProposalsGetParams,
  validateSelfImprovementProposalsListParams,
  validateSelfImprovementProposalsUpdateParams,
  validateSelfImprovementRecommendationsGetParams,
  validateSelfImprovementRecommendationsListParams,
  validateSelfImprovementRecommendationsSummaryParams,
  validateSelfImprovementRecommendationsUpdateParams,
  validateSelfImprovementScorecardParams,
  validateSelfImprovementScanParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_RECOMMENDATIONS_LIMIT = 100;
const MAX_RECOMMENDATIONS_LIMIT = 500;
const SENSITIVE_MARKER_PATTERN =
  /\[redacted(?:-token)?\]|\b(?:api[_-]?key|token|secret|password)\s*=\s*\[redacted\]/i;
const ALL_RECOMMENDATION_STATUSES: SelfImprovementRecommendationStatus[] = [
  "open",
  "acknowledged",
  "assigned",
  "in_progress",
  "reopened",
  "quarantined",
  "resolved",
  "dismissed",
];

function parseCursor(cursor: string | undefined): number | null {
  if (!cursor) {
    return 0;
  }
  if (!/^\d+$/.test(cursor.trim())) {
    return null;
  }
  const parsed = Number(cursor);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizeFilterSet<T extends string>(value: T | T[] | undefined): Set<T> | null {
  if (!value) {
    return null;
  }
  return new Set(Array.isArray(value) ? value : [value]);
}

function recommendationMatchesFilters(
  recommendation: SelfImprovementRecommendation,
  params: SelfImprovementRecommendationsListParams,
): boolean {
  const status = normalizeFilterSet(
    params.status as
      | SelfImprovementRecommendationStatus
      | SelfImprovementRecommendationStatus[]
      | undefined,
  );
  if (status && !status.has(recommendation.status)) {
    return false;
  }
  const severity = normalizeFilterSet(
    params.severity as
      | SelfImprovementRecommendationSeverity
      | SelfImprovementRecommendationSeverity[]
      | undefined,
  );
  if (severity && !severity.has(recommendation.severity)) {
    return false;
  }
  const route = normalizeFilterSet(
    params.route as SelfImprovementRouteRole | SelfImprovementRouteRole[] | undefined,
  );
  if (route && !route.has(recommendation.route.role)) {
    return false;
  }
  const category = normalizeFilterSet(
    params.category as
      | SelfImprovementRecommendationCategory
      | SelfImprovementRecommendationCategory[]
      | undefined,
  );
  return !category || category.has(recommendation.category);
}

function withRecommendationActionability(
  recommendation: SelfImprovementRecommendation,
): SelfImprovementRecommendation {
  return {
    ...recommendation,
    actionability: deriveSelfImprovementRecommendationActionability(recommendation),
  };
}

function proposalContainsSensitiveMarker(proposal: {
  title?: string;
  summary?: string;
  recommendedAction?: string;
  requiredEvidence?: readonly string[];
  safetyNotes?: readonly string[];
}): boolean {
  const text = [
    proposal.title,
    proposal.summary,
    proposal.recommendedAction,
    ...(proposal.requiredEvidence ?? []),
    ...(proposal.safetyNotes ?? []),
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join("\n");
  return SENSITIVE_MARKER_PATTERN.test(text);
}

function normalizeStatusList(
  params: SelfImprovementRecommendationsSummaryParams,
): SelfImprovementRecommendationStatus[] | undefined {
  if (!params.status) {
    return undefined;
  }
  return Array.isArray(params.status)
    ? (params.status as SelfImprovementRecommendationStatus[])
    : [params.status as SelfImprovementRecommendationStatus];
}

function normalizeRouteList(
  params: SelfImprovementRecommendationsSummaryParams,
): SelfImprovementRouteRole[] | undefined {
  if (!params.route) {
    return undefined;
  }
  return Array.isArray(params.route)
    ? (params.route as SelfImprovementRouteRole[])
    : [params.route as SelfImprovementRouteRole];
}

function invalidParams(method: string, errors: unknown) {
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `invalid ${method} params: ${formatValidationErrors(
      errors as Parameters<typeof formatValidationErrors>[0],
    )}`,
  );
}

export const selfImprovementHandlers: GatewayRequestHandlers = {
  "selfImprovement.scan": async ({ params, respond, context }) => {
    if (!validateSelfImprovementScanParams(params)) {
      respond(
        false,
        undefined,
        invalidParams("selfImprovement.scan", validateSelfImprovementScanParams.errors),
      );
      return;
    }
    try {
      const result = await runSelfImprovementGovernorScan({
        cfg: context.getRuntimeConfig(),
        trigger: "manual",
        listCronJobs: async () => await context.cron.list({ includeDisabled: true }),
      });
      respond(true, result);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "selfImprovement.recommendations.list": async ({ params, respond }) => {
    if (!validateSelfImprovementRecommendationsListParams(params)) {
      respond(
        false,
        undefined,
        invalidParams(
          "selfImprovement.recommendations.list",
          validateSelfImprovementRecommendationsListParams.errors,
        ),
      );
      return;
    }
    const cursor = parseCursor(params.cursor);
    if (cursor === null) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid selfImprovement recommendations cursor"),
      );
      return;
    }
    const stateDir = resolveStateDir();
    const limit = Math.min(
      params.limit ?? DEFAULT_RECOMMENDATIONS_LIMIT,
      MAX_RECOMMENDATIONS_LIMIT,
    );
    const recommendations = (await listSelfImprovementRecommendations({ stateDir })).filter(
      (recommendation) => recommendationMatchesFilters(recommendation, params),
    );
    const page = recommendations.slice(cursor, cursor + limit).map(withRecommendationActionability);
    const nextOffset = cursor + page.length;
    respond(true, {
      recommendations: page,
      total: recommendations.length,
      ...(nextOffset < recommendations.length ? { nextCursor: String(nextOffset) } : {}),
    });
  },
  "selfImprovement.summary": async ({ params, respond }) => {
    if (!validateSelfImprovementRecommendationsSummaryParams(params)) {
      respond(
        false,
        undefined,
        invalidParams(
          "selfImprovement.summary",
          validateSelfImprovementRecommendationsSummaryParams.errors,
        ),
      );
      return;
    }
    const recommendations = await listSelfImprovementRecommendations({
      stateDir: resolveStateDir(),
    });
    respond(
      true,
      summarizeSelfImprovementRecommendations({
        recommendations,
        statuses: normalizeStatusList(params),
        routes: normalizeRouteList(params),
        limit: params.limit,
      }),
    );
  },
  "selfImprovement.scorecard": async ({ params, respond }) => {
    if (!validateSelfImprovementScorecardParams(params)) {
      respond(
        false,
        undefined,
        invalidParams("selfImprovement.scorecard", validateSelfImprovementScorecardParams.errors),
      );
      return;
    }
    const stateDir = resolveStateDir();
    const recommendations = await listSelfImprovementRecommendations({ stateDir });
    const current = summarizeSelfImprovementRecommendations({ recommendations }).scorecard;
    const scorecards = await listSelfImprovementDailyScorecards({
      stateDir,
      days: params.days,
      limit: params.limit,
    });
    respond(true, { current, scorecards });
  },
  "selfImprovement.health": async ({ params, respond }) => {
    if (!validateSelfImprovementHealthParams(params)) {
      respond(
        false,
        undefined,
        invalidParams("selfImprovement.health", validateSelfImprovementHealthParams.errors),
      );
      return;
    }
    const result = await loadSelfImprovementOperationalHealth({
      stateDir: resolveStateDir(),
      days: params.days,
      limit: params.limit,
      env: process.env,
    });
    respond(true, result);
  },
  "selfImprovement.productionCheck": async ({ params, respond }) => {
    if (!validateSelfImprovementProductionCheckParams(params)) {
      respond(
        false,
        undefined,
        invalidParams(
          "selfImprovement.productionCheck",
          validateSelfImprovementProductionCheckParams.errors,
        ),
      );
      return;
    }
    const result = await runSelfImprovementProductionCheck({
      stateDir: resolveStateDir(),
      days: params.days,
      limit: params.limit,
      failOnDegraded: params.failOnDegraded,
      failOnBlocked: params.failOnBlocked,
      requireModelReady: params.requireModelReady,
      requireEvalsReady: params.requireEvalsReady,
      env: process.env,
    });
    respond(true, result);
  },
  "selfImprovement.maintenance.run": async ({ params, respond }) => {
    if (!validateSelfImprovementMaintenanceRunParams(params)) {
      respond(
        false,
        undefined,
        invalidParams(
          "selfImprovement.maintenance.run",
          validateSelfImprovementMaintenanceRunParams.errors,
        ),
      );
      return;
    }
    try {
      const result = await runSelfImprovementMaintenance({
        stateDir: resolveStateDir(),
        apply: params.apply,
      });
      respond(true, result);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "selfImprovement.auditEvents.list": async ({ params, respond }) => {
    if (!validateSelfImprovementAuditEventsListParams(params)) {
      respond(
        false,
        undefined,
        invalidParams(
          "selfImprovement.auditEvents.list",
          validateSelfImprovementAuditEventsListParams.errors,
        ),
      );
      return;
    }
    const kind = normalizeFilterSet(
      params.kind as SelfImprovementAuditEventKind | SelfImprovementAuditEventKind[] | undefined,
    );
    const events = await listSelfImprovementAuditEvents({
      stateDir: resolveStateDir(),
      kind: kind ? [...kind] : undefined,
      limit: Math.min(params.limit ?? DEFAULT_RECOMMENDATIONS_LIMIT, MAX_RECOMMENDATIONS_LIMIT),
    });
    respond(true, { events, total: events.length });
  },
  "selfImprovement.analysis.run": async ({ params, respond, context }) => {
    if (!validateSelfImprovementAnalysisRunParams(params)) {
      respond(
        false,
        undefined,
        invalidParams(
          "selfImprovement.analysis.run",
          validateSelfImprovementAnalysisRunParams.errors,
        ),
      );
      return;
    }
    try {
      const result = await runSelfImprovementAnalysis({
        cfg: context.getRuntimeConfig(),
        stateDir: resolveStateDir(),
        limit: params.limit,
        llm: params.llm,
        llmApproval: params.llmApproval,
        modelId: params.modelId,
        reviewModelId: params.reviewModelId,
        fallbackModelId: params.fallbackModelId,
        strategicModelId: params.strategicModelId,
        localFirst: params.localFirst,
        allowStrategicLocal: params.allowStrategicLocal,
        allowHostedEscalation: params.allowHostedEscalation,
        reviewerAgentId: params.reviewerAgentId,
        env: process.env,
      });
      respond(true, result);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "selfImprovement.models.preflight": async ({ params, respond, context }) => {
    if (!validateSelfImprovementModelPreflightParams(params)) {
      respond(
        false,
        undefined,
        invalidParams(
          "selfImprovement.models.preflight",
          validateSelfImprovementModelPreflightParams.errors,
        ),
      );
      return;
    }
    try {
      const result = await preflightSelfImprovementReviewModels({
        cfg: context.getRuntimeConfig(),
        requested: params.llm,
        approved: params.llmApproval,
        modelId: params.modelId,
        reviewModelId: params.reviewModelId,
        fallbackModelId: params.fallbackModelId,
        strategicModelId: params.strategicModelId,
        localFirst: params.localFirst,
        allowStrategicLocal: params.allowStrategicLocal,
        allowHostedEscalation: params.allowHostedEscalation,
        strategic: params.strategic,
        reviewerAgentId: params.reviewerAgentId,
        env: process.env,
      });
      await appendSelfImprovementModelPreflightAuditEvent({
        stateDir: resolveStateDir(),
        result,
        actor: "gateway",
      });
      respond(true, result);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "selfImprovement.evals.run": async ({ params, respond, context }) => {
    if (!validateSelfImprovementReviewerEvalRunParams(params)) {
      respond(
        false,
        undefined,
        invalidParams(
          "selfImprovement.evals.run",
          validateSelfImprovementReviewerEvalRunParams.errors,
        ),
      );
      return;
    }
    try {
      const result = await runSelfImprovementReviewerEvals({
        cfg: context.getRuntimeConfig(),
        stateDir: resolveStateDir(),
        fixtureSet: params.fixtureSet,
        limit: params.limit,
        reviewModelId: params.reviewModelId,
        fallbackModelId: params.fallbackModelId,
        strategicModelId: params.strategicModelId,
        localFirst: params.localFirst,
        allowStrategicLocal: params.allowStrategicLocal,
        allowHostedEscalation: params.allowHostedEscalation,
        llmApproval: params.llmApproval,
        reviewerAgentId: params.reviewerAgentId,
        env: process.env,
      });
      if (params.failOnThreshold && !result.ready) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `self-improvement reviewer evals did not meet thresholds: ${result.readiness}`,
          ),
        );
        return;
      }
      respond(true, result);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "selfImprovement.recommendations.get": async ({ params, respond }) => {
    if (!validateSelfImprovementRecommendationsGetParams(params)) {
      respond(
        false,
        undefined,
        invalidParams(
          "selfImprovement.recommendations.get",
          validateSelfImprovementRecommendationsGetParams.errors,
        ),
      );
      return;
    }
    const recommendation = await getSelfImprovementRecommendation({
      id: params.id,
      stateDir: resolveStateDir(),
    });
    if (!recommendation) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `recommendation not found: ${params.id}`),
      );
      return;
    }
    respond(true, { recommendation: withRecommendationActionability(recommendation) });
  },
  "selfImprovement.recommendations.update": async ({ params, respond }) => {
    if (!validateSelfImprovementRecommendationsUpdateParams(params)) {
      respond(
        false,
        undefined,
        invalidParams(
          "selfImprovement.recommendations.update",
          validateSelfImprovementRecommendationsUpdateParams.errors,
        ),
      );
      return;
    }
    const existing = await getSelfImprovementRecommendation({
      id: params.id,
      stateDir: resolveStateDir(),
    });
    if (!existing) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `recommendation not found: ${params.id}`),
      );
      return;
    }
    if (
      params.status === "resolved" &&
      existing.safety.requiresTests &&
      !existing.resolutionProof?.trim() &&
      !params.resolutionProof?.trim()
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "resolution proof is required for test-required self-improvement recommendations",
        ),
      );
      return;
    }
    if (
      params.status === "dismissed" &&
      !existing.dismissalReason?.trim() &&
      !params.dismissalReason?.trim()
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "dismissal reason is required for self-improvement recommendations",
        ),
      );
      return;
    }
    const recommendation = await updateSelfImprovementRecommendationStatus({
      id: params.id,
      status: params.status,
      note: params.note,
      assignedTargetAgentId: params.assignedTargetAgentId,
      claimedBy: params.claimedBy,
      resolutionProof: params.resolutionProof,
      dismissalReason: params.dismissalReason,
      stateDir: resolveStateDir(),
    });
    if (!recommendation) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `recommendation not found: ${params.id}`),
      );
      return;
    }
    await appendSelfImprovementAuditEvent({
      stateDir: resolveStateDir(),
      event: {
        actor: "gateway",
        kind: "recommendation_status_updated",
        targetId: recommendation.id,
        summary: `Updated recommendation ${recommendation.id} to ${recommendation.status}.`,
        metadata: {
          status: recommendation.status,
          route: recommendation.route.role,
          assignedTargetAgentId: recommendation.assignedTargetAgentId ?? "",
          claimedBy: recommendation.claimedBy ?? "",
          proofPresent: Boolean(recommendation.resolutionProof?.trim()),
          dismissalReasonPresent: Boolean(recommendation.dismissalReason?.trim()),
        },
      },
    });
    respond(true, { recommendation: withRecommendationActionability(recommendation) });
  },
  "selfImprovement.groups.update": async ({ params, respond }) => {
    if (!validateSelfImprovementGroupsUpdateParams(params)) {
      respond(
        false,
        undefined,
        invalidParams(
          "selfImprovement.groups.update",
          validateSelfImprovementGroupsUpdateParams.errors,
        ),
      );
      return;
    }
    const stateDir = resolveStateDir();
    const recommendations = await listSelfImprovementRecommendations({ stateDir });
    const summary = summarizeSelfImprovementRecommendations({
      recommendations,
      statuses: ALL_RECOMMENDATION_STATUSES,
      limit: MAX_RECOMMENDATIONS_LIMIT,
    });
    const group = summary.groups.find(
      (entry) => entry.id === params.id || entry.groupKey === params.id,
    );
    if (!group) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `recommendation group not found: ${params.id}`),
      );
      return;
    }
    if (
      params.status === "resolved" &&
      group.requiresTests &&
      group.actionability?.proofState !== "attached" &&
      !params.resolutionProof?.trim()
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "resolution proof is required for test-required self-improvement recommendation groups",
        ),
      );
      return;
    }
    if (params.status === "dismissed" && !params.dismissalReason?.trim()) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "dismissal reason is required for self-improvement recommendation groups",
        ),
      );
      return;
    }
    const now = Date.now();
    const updated: SelfImprovementRecommendation[] = [];
    for (const id of group.recommendationIds) {
      const recommendation = await updateSelfImprovementRecommendationStatus({
        id,
        status: params.status as SelfImprovementRecommendationStatus,
        note: params.note,
        assignedTargetAgentId: params.assignedTargetAgentId,
        claimedBy: params.claimedBy,
        resolutionProof: params.resolutionProof,
        dismissalReason: params.dismissalReason,
        stateDir,
        now,
      });
      if (recommendation) {
        updated.push(recommendation);
      }
    }
    const after = summarizeSelfImprovementRecommendations({
      recommendations: await listSelfImprovementRecommendations({ stateDir }),
      statuses: ALL_RECOMMENDATION_STATUSES,
      limit: MAX_RECOMMENDATIONS_LIMIT,
    });
    const updatedGroup =
      after.groups.find((entry) => entry.id === group.id || entry.groupKey === group.groupKey) ??
      group;
    await appendSelfImprovementAuditEvent({
      stateDir,
      event: {
        createdAt: now,
        actor: "gateway",
        kind: "recommendation_group_updated",
        targetId: group.id,
        summary: `Updated recommendation group ${group.id} to ${params.status}.`,
        metadata: {
          status: params.status,
          route: group.route.role,
          assignedTargetAgentId: params.assignedTargetAgentId ?? "",
          claimedBy: params.claimedBy ?? "",
          proofPresent: Boolean(params.resolutionProof?.trim()),
          dismissalReasonPresent: Boolean(params.dismissalReason?.trim()),
          recommendationIds: group.recommendationIds,
        },
      },
    });
    respond(true, {
      group: updatedGroup,
      recommendations: updated.map(withRecommendationActionability),
    });
  },
  "selfImprovement.proposals.list": async ({ params, respond }) => {
    if (!validateSelfImprovementProposalsListParams(params)) {
      respond(
        false,
        undefined,
        invalidParams(
          "selfImprovement.proposals.list",
          validateSelfImprovementProposalsListParams.errors,
        ),
      );
      return;
    }
    const cursor = parseCursor(params.cursor);
    if (cursor === null) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid selfImprovement proposals cursor"),
      );
      return;
    }
    const status = normalizeFilterSet(
      params.status as SelfImprovementProposalStatus | SelfImprovementProposalStatus[] | undefined,
    );
    const kind = normalizeFilterSet(
      params.kind as SelfImprovementProposalKind | SelfImprovementProposalKind[] | undefined,
    );
    const proposals = await listSelfImprovementProposals({
      stateDir: resolveStateDir(),
      status: status ? [...status] : undefined,
      kind: kind ? [...kind] : undefined,
    });
    const limit = Math.min(
      params.limit ?? DEFAULT_RECOMMENDATIONS_LIMIT,
      MAX_RECOMMENDATIONS_LIMIT,
    );
    const page = proposals.slice(cursor, cursor + limit);
    const nextOffset = cursor + page.length;
    respond(true, {
      proposals: page,
      total: proposals.length,
      ...(nextOffset < proposals.length ? { nextCursor: String(nextOffset) } : {}),
    });
  },
  "selfImprovement.proposals.get": async ({ params, respond }) => {
    if (!validateSelfImprovementProposalsGetParams(params)) {
      respond(
        false,
        undefined,
        invalidParams(
          "selfImprovement.proposals.get",
          validateSelfImprovementProposalsGetParams.errors,
        ),
      );
      return;
    }
    const proposal = await getSelfImprovementProposal({
      id: params.id,
      stateDir: resolveStateDir(),
    });
    if (!proposal) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `proposal not found: ${params.id}`),
      );
      return;
    }
    respond(true, { proposal });
  },
  "selfImprovement.proposals.update": async ({ params, respond }) => {
    if (!validateSelfImprovementProposalsUpdateParams(params)) {
      respond(
        false,
        undefined,
        invalidParams(
          "selfImprovement.proposals.update",
          validateSelfImprovementProposalsUpdateParams.errors,
        ),
      );
      return;
    }
    const existing = await getSelfImprovementProposal({
      id: params.id,
      stateDir: resolveStateDir(),
    });
    if (!existing) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `proposal not found: ${params.id}`),
      );
      return;
    }
    if (
      params.status === "approved" &&
      existing.approvalRequired &&
      !existing.approvalProof?.trim() &&
      !params.approvalProof?.trim()
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "approval proof is required before approving this self-improvement proposal",
        ),
      );
      return;
    }
    const proposal = await updateSelfImprovementProposalStatus({
      id: params.id,
      status: params.status as SelfImprovementProposalStatus,
      note: params.note,
      approvalProof: params.approvalProof,
      dismissalReason: params.dismissalReason,
      stateDir: resolveStateDir(),
    });
    if (!proposal) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `proposal not found: ${params.id}`),
      );
      return;
    }
    await appendSelfImprovementAuditEvent({
      stateDir: resolveStateDir(),
      event: {
        actor: "gateway",
        kind: "proposal_status_updated",
        targetId: proposal.id,
        summary: `Updated proposal ${proposal.id} to ${proposal.status}.`,
        metadata: {
          status: proposal.status,
          kind: proposal.kind,
          route: proposal.route.role,
        },
      },
    });
    respond(true, { proposal });
  },
  "selfImprovement.curator.list": async ({ params, respond }) => {
    if (!validateSelfImprovementCuratorListParams(params)) {
      respond(
        false,
        undefined,
        invalidParams(
          "selfImprovement.curator.list",
          validateSelfImprovementCuratorListParams.errors,
        ),
      );
      return;
    }
    const cursor = parseCursor(params.cursor);
    if (cursor === null) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid selfImprovement curator cursor"),
      );
      return;
    }
    const status = normalizeFilterSet(
      params.status as SelfImprovementCuratorStatus | SelfImprovementCuratorStatus[] | undefined,
    );
    const proposals = (
      await listSelfImprovementProposals({
        stateDir: resolveStateDir(),
        kind: ["memory_skill"],
      })
    ).filter((proposal) => !status || status.has(proposal.curatorStatus ?? "pending_review"));
    const limit = Math.min(
      params.limit ?? DEFAULT_RECOMMENDATIONS_LIMIT,
      MAX_RECOMMENDATIONS_LIMIT,
    );
    const page = proposals.slice(cursor, cursor + limit);
    const nextOffset = cursor + page.length;
    respond(true, {
      proposals: page,
      total: proposals.length,
      ...(nextOffset < proposals.length ? { nextCursor: String(nextOffset) } : {}),
    });
  },
  "selfImprovement.curator.get": async ({ params, respond }) => {
    if (!validateSelfImprovementCuratorGetParams(params)) {
      respond(
        false,
        undefined,
        invalidParams(
          "selfImprovement.curator.get",
          validateSelfImprovementCuratorGetParams.errors,
        ),
      );
      return;
    }
    const proposal = await getSelfImprovementProposal({
      id: params.id,
      stateDir: resolveStateDir(),
    });
    if (!proposal || proposal.kind !== "memory_skill") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `curator proposal not found: ${params.id}`),
      );
      return;
    }
    respond(true, { proposal });
  },
  "selfImprovement.curator.update": async ({ params, respond }) => {
    if (!validateSelfImprovementCuratorUpdateParams(params)) {
      respond(
        false,
        undefined,
        invalidParams(
          "selfImprovement.curator.update",
          validateSelfImprovementCuratorUpdateParams.errors,
        ),
      );
      return;
    }
    const stateDir = resolveStateDir();
    const existing = await getSelfImprovementProposal({ id: params.id, stateDir });
    if (!existing || existing.kind !== "memory_skill") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `curator proposal not found: ${params.id}`),
      );
      return;
    }
    const hasProof =
      Boolean(params.proof?.trim()) ||
      (params.curatorStatus === "promoted"
        ? Boolean(existing.promotionProof?.trim())
        : Boolean(existing.curatorProof?.trim()));
    const hasReason = Boolean(params.reason?.trim() || existing.curatorReason?.trim());
    const hasWorkshopProposal = Boolean(
      params.workshopProposalId?.trim() || existing.workshopProposalId?.trim(),
    );
    const workshopProposalStatus =
      params.workshopProposalStatus ?? existing.workshopProposalStatus ?? "pending";
    if (
      (params.curatorStatus === "accepted_for_workshop" || params.curatorStatus === "promoted") &&
      !hasProof
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "curator proof is required before accepting or promoting memory/skill proposals",
        ),
      );
      return;
    }
    if (
      params.curatorStatus === "promoted" &&
      (!hasWorkshopProposal || workshopProposalStatus === "quarantined")
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "a non-quarantined Skill Workshop proposal link is required before promotion proof can close a curator proposal",
        ),
      );
      return;
    }
    if (
      (params.curatorStatus === "rejected" ||
        params.curatorStatus === "needs_more_evidence" ||
        params.curatorStatus === "superseded") &&
      !hasReason
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "a curator reason is required before rejecting, superseding, or requesting more evidence",
        ),
      );
      return;
    }
    if (
      (params.curatorStatus === "accepted_for_workshop" || params.curatorStatus === "promoted") &&
      proposalContainsSensitiveMarker(existing)
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "curator proposal still contains redacted sensitive markers and must be rewritten before workshop acceptance",
        ),
      );
      return;
    }
    const proposal = await updateSelfImprovementCuratorStatus({
      id: params.id,
      curatorStatus: params.curatorStatus as SelfImprovementCuratorStatus,
      proof: params.proof,
      reason: params.reason,
      workshopProposalId: params.workshopProposalId,
      workshopProposalStatus: params.workshopProposalStatus,
      note: params.note,
      stateDir,
    });
    if (!proposal) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `curator proposal not found: ${params.id}`),
      );
      return;
    }
    await appendSelfImprovementAuditEvent({
      stateDir,
      event: {
        actor: "gateway",
        kind: "curator_status_updated",
        targetId: proposal.id,
        summary: `Updated curator proposal ${proposal.id} to ${proposal.curatorStatus ?? "pending_review"}.`,
        metadata: {
          curatorStatus: proposal.curatorStatus ?? "pending_review",
          proposalKind: proposal.kind,
          route: proposal.route.role,
          proofPresent: Boolean(
            (params.curatorStatus === "promoted"
              ? proposal.promotionProof
              : proposal.curatorProof
            )?.trim(),
          ),
          reasonPresent: Boolean(proposal.curatorReason?.trim()),
          workshopProposalId: proposal.workshopProposalId ?? "",
          workshopProposalStatus: proposal.workshopProposalStatus ?? "",
        },
      },
    });
    respond(true, { proposal });
  },
};
