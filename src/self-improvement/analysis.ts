import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  appendSelfImprovementAuditEvent,
  buildSelfImprovementModelAttemptAuditMetadata,
} from "./audit-events.js";
import {
  reviewSelfImprovementGroupsWithLlm,
  summarizeSelfImprovementModelReadiness,
  summarizeSelfImprovementReviewPreflightAttempts,
} from "./llm-reviewer.js";
import { writeSelfImprovementOperationalHealthSnapshot } from "./operational-health.js";
import {
  buildSelfImprovementProposalsFromGroups,
  upsertSelfImprovementProposals,
} from "./proposals.js";
import { writeSelfImprovementDailyScorecardSnapshot } from "./scorecard-store.js";
import { listSelfImprovementRecommendations } from "./store.js";
import { summarizeSelfImprovementRecommendations } from "./summary.js";
import type {
  SelfImprovementAnalysisRunResult,
  SelfImprovementRecommendationGroup,
} from "./types.js";

const PROMPT_VERSION = "self-improvement-governor-analysis-v1";

function summarizeAnalysisConfidence(
  groups: readonly SelfImprovementRecommendationGroup[],
): number | undefined {
  const confidences = groups
    .map((group) => group.analysis.confidence)
    .filter((confidence) => Number.isFinite(confidence));
  if (confidences.length === 0) {
    return undefined;
  }
  const average = confidences.reduce((sum, confidence) => sum + confidence, 0) / confidences.length;
  return Math.round(Math.min(1, Math.max(0, average)) * 1_000) / 1_000;
}

export async function runSelfImprovementAnalysis(params?: {
  cfg?: OpenClawConfig;
  stateDir?: string;
  now?: number;
  limit?: number;
  llm?: boolean;
  llmApproval?: boolean;
  modelId?: string;
  reviewModelId?: string;
  fallbackModelId?: string;
  strategicModelId?: string;
  localFirst?: boolean;
  allowStrategicLocal?: boolean;
  allowHostedEscalation?: boolean;
  reviewerAgentId?: string;
  env?: NodeJS.ProcessEnv;
  writeHealthSnapshot?: boolean;
  llmCompletion?: Parameters<typeof reviewSelfImprovementGroupsWithLlm>[0]["completion"];
  llmPreflight?: Parameters<typeof reviewSelfImprovementGroupsWithLlm>[0]["preflight"];
}): Promise<SelfImprovementAnalysisRunResult> {
  const now = params?.now ?? Date.now();
  const recommendations = await listSelfImprovementRecommendations({ stateDir: params?.stateDir });
  const summary = summarizeSelfImprovementRecommendations({
    recommendations,
    now,
    limit: params?.limit ?? 25,
  });
  const llmReview = await reviewSelfImprovementGroupsWithLlm({
    cfg: params?.cfg,
    groups: summary.groups,
    requested: params?.llm === true,
    approved: params?.llmApproval === true,
    modelId: params?.modelId,
    reviewModelId: params?.reviewModelId,
    fallbackModelId: params?.fallbackModelId,
    strategicModelId: params?.strategicModelId,
    localFirst: params?.localFirst === true,
    allowStrategicLocal: params?.allowStrategicLocal === true,
    allowHostedEscalation: params?.allowHostedEscalation === true,
    reviewerAgentId: params?.reviewerAgentId,
    env: params?.env,
    now,
    completion: params?.llmCompletion,
    preflight: params?.llmPreflight,
  });
  const reviewedGroups: SelfImprovementRecommendationGroup[] = llmReview.groups;
  const proposals = buildSelfImprovementProposalsFromGroups({
    groups: reviewedGroups,
    now,
    limit: params?.limit ?? 25,
  });
  const proposalWrite = await upsertSelfImprovementProposals({
    proposals,
    stateDir: params?.stateDir,
  });
  await writeSelfImprovementDailyScorecardSnapshot({
    scorecard: summary.scorecard,
    stateDir: params?.stateDir,
    now,
  });

  const localFirst = params?.localFirst === true;
  const mode =
    llmReview.status.mode !== "disabled" && llmReview.status.mode !== "fallback"
      ? llmReview.status.mode
      : llmReview.status.mode === "fallback"
        ? "fallback"
        : "deterministic";
  const fallbackReason = llmReview.status.mode === "fallback" ? llmReview.status.reason : undefined;
  const groupsReviewedByLlm =
    llmReview.status.mode !== "disabled" && llmReview.status.mode !== "fallback"
      ? llmReview.status.groupsReviewed
      : 0;
  const groupsReviewedByLocalLlm = llmReview.status.groupsReviewedByLocalLlm;
  const modelStatus = llmReview.status.mode === "disabled" ? undefined : llmReview.status;
  const effectiveModelId =
    llmReview.status.mode !== "disabled" && llmReview.status.mode !== "fallback"
      ? (llmReview.status.modelId ?? params?.reviewModelId ?? params?.modelId)
      : (modelStatus?.modelId ?? params?.reviewModelId ?? params?.modelId);
  const preflight = summarizeSelfImprovementReviewPreflightAttempts(llmReview.status.attempts);
  const modelReadiness =
    llmReview.status.attempts.length > 0
      ? summarizeSelfImprovementModelReadiness(llmReview.status.attempts)
      : undefined;
  const confidence = summarizeAnalysisConfidence(reviewedGroups);

  await appendSelfImprovementAuditEvent({
    stateDir: params?.stateDir,
    event: {
      createdAt: now,
      actor: "governor",
      kind: "analysis_run",
      targetId: "self-improvement",
      summary:
        mode !== "deterministic" && mode !== "fallback"
          ? "Ran model-reviewed self-improvement analysis."
          : mode === "fallback"
            ? "Ran deterministic self-improvement analysis after model review fallback."
            : "Ran deterministic self-improvement analysis.",
      metadata: {
        mode,
        reviewPolicy: llmReview.status.reviewPolicy,
        groupsAnalyzed: summary.groups.length,
        groupsReviewedByLlm,
        groupsReviewedByLocalLlm,
        proposalsCreated: proposalWrite.created,
        proposalsUpdated: proposalWrite.updated,
        llmRequested: params?.llm === true,
        llmApproved: params?.llmApproval === true,
        localFirst,
        hostedEscalationAllowed: params?.allowHostedEscalation === true,
        strategicLocalAllowed: params?.allowStrategicLocal === true,
        schemaValidated: llmReview.status.schemaValidated,
        ...buildSelfImprovementModelAttemptAuditMetadata(llmReview.status.attempts),
        ...(modelReadiness ? { modelReady: modelReadiness.ready } : {}),
        ...(modelReadiness?.readiness ? { modelReadiness: modelReadiness.readiness } : {}),
        ...(modelReadiness?.readyTier ? { readyTier: modelReadiness.readyTier } : {}),
        ...(modelReadiness?.readyModelId ? { readyModelId: modelReadiness.readyModelId } : {}),
        ...(modelReadiness?.blockedPrimaryReason
          ? { blockedPrimaryReason: modelReadiness.blockedPrimaryReason }
          : {}),
        ...(confidence !== undefined ? { confidence } : {}),
        ...(preflight.preflightStatus ? { preflightStatus: preflight.preflightStatus } : {}),
        ...(preflight.preflightMs !== undefined ? { preflightMs: preflight.preflightMs } : {}),
        ...(effectiveModelId ? { modelId: effectiveModelId } : {}),
        ...(modelStatus?.modelTier ? { modelTier: modelStatus.modelTier } : {}),
        ...(fallbackReason ? { fallbackReason } : {}),
        ...(modelStatus?.escalationReason
          ? { escalationReason: modelStatus.escalationReason }
          : {}),
      },
    },
  });
  if (proposalWrite.created > 0) {
    await appendSelfImprovementAuditEvent({
      stateDir: params?.stateDir,
      event: {
        createdAt: now,
        actor: "governor",
        kind: "proposal_created",
        targetId: "self-improvement",
        summary: `Created ${proposalWrite.created} self-improvement proposal(s).`,
        metadata: {
          proposalIds: proposalWrite.proposals
            .filter((proposal) => proposals.some((created) => created.id === proposal.id))
            .slice(0, proposalWrite.created)
            .map((proposal) => proposal.id),
        },
      },
    });
  }
  await appendSelfImprovementAuditEvent({
    stateDir: params?.stateDir,
    event: {
      createdAt: now,
      actor: "governor",
      kind: "scorecard_snapshot_written",
      targetId: "self-improvement",
      summary: "Wrote daily self-improvement scorecard snapshot.",
      metadata: {
        activeRecommendations: summary.scorecard.activeRecommendations,
        groupedRecommendations: summary.scorecard.groupedRecommendations,
      },
    },
  });
  if (params?.writeHealthSnapshot !== false) {
    await writeSelfImprovementOperationalHealthSnapshot({
      stateDir: params?.stateDir,
      now,
      env: params?.env,
    });
  }

  return {
    analyzedAt: now,
    mode,
    ...(effectiveModelId ? { modelId: effectiveModelId } : {}),
    ...(modelReadiness ? { ready: modelReadiness.ready } : {}),
    ...(modelReadiness?.readiness ? { readiness: modelReadiness.readiness } : {}),
    ...(modelReadiness?.readyTier ? { readyTier: modelReadiness.readyTier } : {}),
    ...(modelReadiness?.readyModelId ? { readyModelId: modelReadiness.readyModelId } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    reviewPolicy: llmReview.status.reviewPolicy,
    ...(modelStatus?.modelTier ? { modelTier: modelStatus.modelTier } : {}),
    ...(modelStatus?.reviewModelId ? { reviewModelId: modelStatus.reviewModelId } : {}),
    ...(modelStatus?.fallbackModelId ? { fallbackModelId: modelStatus.fallbackModelId } : {}),
    ...(modelStatus?.strategicModelId ? { strategicModelId: modelStatus.strategicModelId } : {}),
    promptVersion: PROMPT_VERSION,
    llmRequested: params?.llm === true,
    llmApproved: params?.llmApproval === true,
    localFirst,
    hostedEscalationAllowed: params?.allowHostedEscalation === true,
    strategicLocalAllowed: params?.allowStrategicLocal === true,
    groupsAnalyzed: summary.groups.length,
    groupsReviewedByLlm,
    groupsReviewedByLocalLlm,
    recommendationsUpdated: 0,
    proposalsCreated: proposalWrite.created,
    attempts: llmReview.status.attempts,
    schemaValidated: llmReview.status.schemaValidated,
    ...(preflight.preflightStatus ? { preflightStatus: preflight.preflightStatus } : {}),
    ...(preflight.preflightMs !== undefined ? { preflightMs: preflight.preflightMs } : {}),
    ...(modelStatus?.escalationReason ? { escalationReason: modelStatus.escalationReason } : {}),
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(modelReadiness?.blockedPrimaryReason
      ? { blockedPrimaryReason: modelReadiness.blockedPrimaryReason }
      : {}),
    scorecard: summary.scorecard,
    proposals: proposalWrite.proposals.filter((proposal) =>
      proposals.some((entry) => entry.id === proposal.id),
    ),
  };
}
