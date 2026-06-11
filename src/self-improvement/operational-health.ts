import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { appendSelfImprovementAuditEvent, listSelfImprovementAuditEvents } from "./audit-events.js";
import { listSelfImprovementProposals } from "./proposals.js";
import { listSelfImprovementRecommendations } from "./store.js";
import { summarizeSelfImprovementRecommendations } from "./summary.js";
import { sanitizeRecommendationText, sanitizeRecommendationTexts } from "./text.js";
import type {
  SelfImprovementActionQueueSummary,
  SelfImprovementAuditEvent,
  SelfImprovementIntelligenceOpportunity,
  SelfImprovementOperationalHealth,
  SelfImprovementOperationalHealthDimension,
  SelfImprovementOperationalHealthMetric,
  SelfImprovementOperationalHealthResult,
  SelfImprovementOperationalHealthSnapshot,
  SelfImprovementOperationalHealthSnapshotStoreFile,
  SelfImprovementOperationalHealthStatus,
  SelfImprovementOperationalHealthTrend,
  SelfImprovementProposal,
  SelfImprovementRecommendation,
  SelfImprovementScorecard,
} from "./types.js";

const STORE_VERSION = 1;
const STORE_DIR = "self-improvement";
const STORE_FILENAME = "health-snapshots.json";
const MAX_SNAPSHOTS = 400;
const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000;
const REVIEWER_STALE_MS = DAY_MS;
const MODEL_PREFLIGHT_STALE_MS = DAY_MS;
const PROPOSAL_STALE_MS = 7 * DAY_MS;
const VERIFICATION_STALE_MS = 3 * DAY_MS;

function snapshotId(value: string): string {
  return `sih_${crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStatus(value: unknown): value is SelfImprovementOperationalHealthStatus {
  return value === "ready" || value === "degraded" || value === "blocked";
}

function isTrend(value: unknown): value is SelfImprovementOperationalHealthTrend {
  return (
    value === "improving" || value === "stable" || value === "worsening" || value === "unknown"
  );
}

function metric(
  key: string,
  label: string,
  value: string | number | boolean,
): SelfImprovementOperationalHealthMetric {
  return { key, label, value };
}

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

function boundedScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function dateKeyForTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function resolveIntervalMs(env: NodeJS.ProcessEnv | undefined): number {
  const raw = env?.OPENCLAW_SELF_IMPROVEMENT_INTERVAL_MS?.trim();
  if (!raw) {
    return DEFAULT_INTERVAL_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_INTERVAL_MS;
}

function cloneSnapshot(
  snapshot: SelfImprovementOperationalHealthSnapshot,
): SelfImprovementOperationalHealthSnapshot {
  return structuredClone(snapshot);
}

function parseDimension(value: unknown): SelfImprovementOperationalHealthDimension | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.label !== "string" ||
    !isStatus(value.status) ||
    typeof value.score !== "number" ||
    typeof value.summary !== "string"
  ) {
    return null;
  }
  return {
    id: value.id as SelfImprovementOperationalHealthDimension["id"],
    label: sanitizeRecommendationText(value.label, 120),
    status: value.status,
    score: boundedScore(value.score),
    summary: sanitizeRecommendationText(value.summary, 360),
    metrics: Array.isArray(value.metrics)
      ? value.metrics
          .map((entry) => {
            if (
              !isRecord(entry) ||
              typeof entry.key !== "string" ||
              typeof entry.label !== "string"
            ) {
              return null;
            }
            const metricValue = entry.value;
            if (
              typeof metricValue !== "string" &&
              typeof metricValue !== "number" &&
              typeof metricValue !== "boolean"
            ) {
              return null;
            }
            return metric(
              sanitizeRecommendationText(entry.key, 80),
              sanitizeRecommendationText(entry.label, 120),
              typeof metricValue === "string"
                ? sanitizeRecommendationText(metricValue, 240)
                : metricValue,
            );
          })
          .filter((entry): entry is SelfImprovementOperationalHealthMetric => Boolean(entry))
      : [],
    blockers: sanitizeRecommendationTexts(Array.isArray(value.blockers) ? value.blockers : [], 240),
    nextActions: sanitizeRecommendationTexts(
      Array.isArray(value.nextActions) ? value.nextActions : [],
      240,
    ),
  };
}

function parseHealth(value: unknown): SelfImprovementOperationalHealth | null {
  if (
    !isRecord(value) ||
    typeof value.generatedAt !== "number" ||
    !isStatus(value.status) ||
    typeof value.score !== "number" ||
    !isTrend(value.trend) ||
    !Array.isArray(value.dimensions)
  ) {
    return null;
  }
  const dimensions = value.dimensions
    .map(parseDimension)
    .filter((entry): entry is SelfImprovementOperationalHealthDimension => Boolean(entry));
  return {
    generatedAt: Math.max(0, Math.floor(value.generatedAt)),
    status: value.status,
    score: boundedScore(value.score),
    trend: value.trend,
    intervalMs:
      typeof value.intervalMs === "number" && Number.isFinite(value.intervalMs)
        ? Math.max(0, Math.floor(value.intervalMs))
        : DEFAULT_INTERVAL_MS,
    staleAfterMs:
      typeof value.staleAfterMs === "number" && Number.isFinite(value.staleAfterMs)
        ? Math.max(0, Math.floor(value.staleAfterMs))
        : DEFAULT_INTERVAL_MS * 2,
    dimensions,
    blockers: sanitizeRecommendationTexts(Array.isArray(value.blockers) ? value.blockers : [], 240),
    nextActions: sanitizeRecommendationTexts(
      Array.isArray(value.nextActions) ? value.nextActions : [],
      240,
    ),
    ...(typeof value.previousSnapshotId === "string"
      ? { previousSnapshotId: sanitizeRecommendationText(value.previousSnapshotId, 120) }
      : {}),
    ...(typeof value.latestReviewerEvalAt === "number"
      ? { latestReviewerEvalAt: Math.max(0, Math.floor(value.latestReviewerEvalAt)) }
      : {}),
    ...(typeof value.latestModelPreflightAt === "number"
      ? { latestModelPreflightAt: Math.max(0, Math.floor(value.latestModelPreflightAt)) }
      : {}),
    ...(typeof value.latestAnalysisAt === "number"
      ? { latestAnalysisAt: Math.max(0, Math.floor(value.latestAnalysisAt)) }
      : {}),
    ...(typeof value.latestBackgroundAt === "number"
      ? { latestBackgroundAt: Math.max(0, Math.floor(value.latestBackgroundAt)) }
      : {}),
  };
}

function parseSnapshot(value: unknown): SelfImprovementOperationalHealthSnapshot | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.createdAt !== "number") {
    return null;
  }
  const health = parseHealth(value.health);
  if (!health) {
    return null;
  }
  return {
    id: sanitizeRecommendationText(value.id, 120),
    createdAt: Math.max(0, Math.floor(value.createdAt)),
    health,
  };
}

function normalizeStore(value: unknown): SelfImprovementOperationalHealthSnapshotStoreFile {
  if (!isRecord(value) || !Array.isArray(value.snapshots)) {
    return { version: STORE_VERSION, snapshots: [] };
  }
  return {
    version: STORE_VERSION,
    snapshots: value.snapshots
      .map(parseSnapshot)
      .filter((entry): entry is SelfImprovementOperationalHealthSnapshot => Boolean(entry)),
  };
}

async function readStore(
  storePath: string,
): Promise<SelfImprovementOperationalHealthSnapshotStoreFile> {
  try {
    return normalizeStore(JSON.parse(await fs.readFile(storePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: STORE_VERSION, snapshots: [] };
    }
    throw error;
  }
}

async function writeStore(
  storePath: string,
  file: SelfImprovementOperationalHealthSnapshotStoreFile,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, storePath);
}

export function resolveSelfImprovementOperationalHealthStorePath(
  stateDir = resolveStateDir(),
): string {
  return path.join(stateDir, STORE_DIR, STORE_FILENAME);
}

export async function listSelfImprovementOperationalHealthSnapshots(params?: {
  stateDir?: string;
  storePath?: string;
  days?: number;
  limit?: number;
}): Promise<SelfImprovementOperationalHealthSnapshot[]> {
  const storePath =
    params?.storePath ?? resolveSelfImprovementOperationalHealthStorePath(params?.stateDir);
  const file = await readStore(storePath);
  const limit = params?.limit && params.limit > 0 ? params.limit : 30;
  const minDate =
    params?.days && params.days > 0
      ? dateKeyForTimestamp(Date.now() - (params.days - 1) * DAY_MS)
      : null;
  return file.snapshots
    .filter((entry) => !minDate || dateKeyForTimestamp(entry.createdAt) >= minDate)
    .toSorted((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .slice(0, limit)
    .map(cloneSnapshot);
}

function auditString(
  event: SelfImprovementAuditEvent | undefined,
  key: string,
): string | undefined {
  const value = event?.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function auditBoolean(
  event: SelfImprovementAuditEvent | undefined,
  key: string,
): boolean | undefined {
  const value = event?.metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function isModelReviewAttempted(events: readonly SelfImprovementAuditEvent[]): boolean {
  return events.some((event) => {
    if (event.kind === "model_preflight" || event.kind === "reviewer_eval_run") {
      return true;
    }
    if (event.kind !== "analysis_run") {
      return false;
    }
    return (
      auditBoolean(event, "localFirst") === true ||
      auditBoolean(event, "llmRequested") === true ||
      auditString(event, "reviewPolicy") === "local_first" ||
      auditString(event, "reviewPolicy") === "hosted"
    );
  });
}

function latestEvent(
  events: readonly SelfImprovementAuditEvent[],
  kinds: readonly SelfImprovementAuditEvent["kind"][],
): SelfImprovementAuditEvent | undefined {
  const kindSet = new Set(kinds);
  return events
    .filter((event) => kindSet.has(event.kind))
    .toSorted((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .at(0);
}

function metricNumber(
  dimension: SelfImprovementOperationalHealthDimension | undefined,
  key: string,
): number | undefined {
  const value = dimension?.metrics.find((entry) => entry.key === key)?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function previousRecommendationPressure(
  previous: SelfImprovementOperationalHealthSnapshot | undefined,
): number | undefined {
  const dimension = previous?.health.dimensions.find((entry) => entry.id === "recommendations");
  const critical = metricNumber(dimension, "criticalOpen");
  const high = metricNumber(dimension, "highOpen");
  if (critical === undefined || high === undefined) {
    return undefined;
  }
  return critical + high;
}

function deriveTrend(params: {
  currentPressure: number;
  previous: SelfImprovementOperationalHealthSnapshot | undefined;
}): SelfImprovementOperationalHealthTrend {
  const previousPressure = previousRecommendationPressure(params.previous);
  if (previousPressure === undefined) {
    return "unknown";
  }
  if (params.currentPressure < previousPressure) {
    return "improving";
  }
  if (params.currentPressure > previousPressure) {
    return "worsening";
  }
  return "stable";
}

function hasOperationalBlocker(entry: SelfImprovementIntelligenceOpportunity | undefined): boolean {
  return Boolean(
    entry?.blockers.some(
      (blocker) =>
        blocker.includes("No owner assigned") ||
        blocker.includes("SLA is overdue") ||
        blocker.includes("No route"),
    ),
  );
}

function buildRecommendationsDimension(params: {
  recommendations: readonly SelfImprovementRecommendation[];
  scorecard: SelfImprovementScorecard;
  actionQueue?: SelfImprovementActionQueueSummary;
  previous: SelfImprovementOperationalHealthSnapshot | undefined;
}): SelfImprovementOperationalHealthDimension {
  const activeCritical = params.recommendations.filter(
    (entry) =>
      entry.status !== "resolved" && entry.status !== "dismissed" && entry.priority === "critical",
  );
  const unroutedCritical = activeCritical.filter(
    (entry) => !entry.route?.role || !entry.route.targetAgentId,
  ).length;
  const noProofCritical = activeCritical.filter(
    (entry) => entry.safety.requiresTests && entry.requiredEvidence.length === 0,
  ).length;
  const currentPressure = params.scorecard.criticalOpen + params.scorecard.highOpen;
  const highCriticalActionItems =
    params.actionQueue?.items.filter(
      (item) => item.priority === "critical" || item.priority === "high",
    ) ?? [];
  const highCriticalUnassigned = highCriticalActionItems.filter(
    (item) => item.actionability.ownerState === "unassigned",
  ).length;
  const highCriticalOverdue = highCriticalActionItems.filter(
    (item) => item.actionability.slaState === "overdue",
  ).length;
  const previousPressure = previousRecommendationPressure(params.previous);
  const worsened =
    previousPressure !== undefined && currentPressure > previousPressure ? currentPressure : 0;
  const blockers = [
    unroutedCritical > 0 ? `${unroutedCritical} critical recommendation(s) have no route.` : "",
    noProofCritical > 0
      ? `${noProofCritical} critical test-required recommendation(s) have no proof path.`
      : "",
    params.scorecard.criticalOpen > 0
      ? `${params.scorecard.criticalOpen} critical recommendation(s) are active.`
      : "",
    highCriticalUnassigned > 0
      ? `${highCriticalUnassigned} high/critical action item(s) are unassigned.`
      : "",
    highCriticalOverdue > 0
      ? `${highCriticalOverdue} high/critical action item(s) are overdue.`
      : "",
    worsened > 0 ? "High/critical recommendation pressure increased since the last snapshot." : "",
  ].filter(Boolean);
  const status: SelfImprovementOperationalHealthStatus =
    unroutedCritical > 0 || noProofCritical > 0 || highCriticalOverdue > 0
      ? "blocked"
      : params.scorecard.criticalOpen > 0 || highCriticalUnassigned > 0 || worsened > 0
        ? "degraded"
        : "ready";
  const score = boundedScore(
    100 -
      params.scorecard.criticalOpen * 25 -
      Math.min(30, params.scorecard.highOpen) -
      highCriticalUnassigned * 8 -
      highCriticalOverdue * 12 -
      (worsened > 0 ? 10 : 0),
  );
  return {
    id: "recommendations",
    label: "Recommendations",
    status,
    score,
    summary:
      status === "ready"
        ? "Recommendation pressure is stable."
        : "Active recommendations need operator attention.",
    metrics: [
      metric("activeRecommendations", "Active", params.scorecard.activeRecommendations),
      metric("criticalOpen", "Critical", params.scorecard.criticalOpen),
      metric("highOpen", "High", params.scorecard.highOpen),
      metric("groupedRecommendations", "Groups", params.scorecard.groupedRecommendations),
      metric("unassignedActionItems", "Unassigned", params.actionQueue?.unassigned ?? 0),
      metric("overdueActionItems", "Overdue", params.actionQueue?.overdue ?? 0),
    ],
    blockers,
    nextActions:
      status === "ready"
        ? ["Keep reviewing new Governor recommendations during normal operations."]
        : ["Review the Action Queue and assign overdue or unowned recommendations."],
  };
}

function buildReviewerDimension(params: {
  latestReviewerEval: SelfImprovementAuditEvent | undefined;
  modelReviewAttempted: boolean;
  now: number;
}): SelfImprovementOperationalHealthDimension {
  const event = params.latestReviewerEval;
  const readiness = auditString(event, "readiness");
  const ready = auditBoolean(event, "ready");
  const stale = event ? params.now - event.createdAt > REVIEWER_STALE_MS : false;
  const status: SelfImprovementOperationalHealthStatus = event
    ? readiness === "blocked"
      ? "blocked"
      : readiness === "degraded" || ready === false || stale
        ? "degraded"
        : "ready"
    : params.modelReviewAttempted
      ? "degraded"
      : "ready";
  const blockers = [
    !event && params.modelReviewAttempted
      ? "Model review has been attempted, but no reviewer eval run is recorded."
      : "",
    event && stale ? "Latest reviewer eval is stale." : "",
    event && readiness === "blocked" ? "Latest reviewer eval is blocked." : "",
    event && readiness === "degraded" ? "Latest reviewer eval is degraded." : "",
  ].filter(Boolean);
  return {
    id: "reviewer",
    label: "Reviewer evals",
    status,
    score: status === "ready" ? 100 : status === "degraded" ? 70 : 30,
    summary:
      status === "ready"
        ? "Reviewer quality gate is current enough for operations."
        : "Reviewer quality gate needs attention.",
    metrics: [
      metric("hasReviewerEval", "Eval recorded", Boolean(event)),
      metric("ageMs", "Age ms", event ? Math.max(0, params.now - event.createdAt) : -1),
      metric("ready", "Ready", ready ?? !params.modelReviewAttempted),
    ],
    blockers,
    nextActions:
      status === "ready"
        ? ["Keep reviewer evals on the regular operations cadence."]
        : ["Run openclaw self-improvement evals run --fixture-set smoke --local-first --json."],
  };
}

function buildModelsDimension(params: {
  latestModelPreflight: SelfImprovementAuditEvent | undefined;
  modelReviewAttempted: boolean;
  now: number;
}): SelfImprovementOperationalHealthDimension {
  const event = params.latestModelPreflight;
  const readiness = auditString(event, "readiness");
  const ready = auditBoolean(event, "ready");
  const stale =
    event && params.modelReviewAttempted
      ? params.now - event.createdAt > MODEL_PREFLIGHT_STALE_MS
      : false;
  const status: SelfImprovementOperationalHealthStatus = event
    ? readiness === "blocked" && params.modelReviewAttempted
      ? "blocked"
      : readiness === "degraded" || ready === false || stale
        ? "degraded"
        : "ready"
    : params.modelReviewAttempted
      ? "degraded"
      : "ready";
  const blockers = [
    !event && params.modelReviewAttempted
      ? "Model review has been attempted, but no model preflight is recorded."
      : "",
    event && stale ? "Latest model preflight is stale." : "",
    event && readiness === "blocked" ? "Latest model preflight is blocked." : "",
    event && readiness === "degraded" ? "Latest model preflight is degraded." : "",
  ].filter(Boolean);
  return {
    id: "models",
    label: "Model readiness",
    status,
    score: status === "ready" ? 100 : status === "degraded" ? 70 : 30,
    summary:
      status === "ready"
        ? "Model readiness is sufficient for the configured review policy."
        : "Model readiness needs operator attention.",
    metrics: [
      metric("hasPreflight", "Preflight recorded", Boolean(event)),
      metric("ageMs", "Age ms", event ? Math.max(0, params.now - event.createdAt) : -1),
      metric("ready", "Ready", ready ?? !params.modelReviewAttempted),
    ],
    blockers,
    nextActions:
      status === "ready"
        ? ["Keep local model preflight checks current before model-reviewed analysis."]
        : ["Run openclaw self-improvement preflight --json and fix blocked local model paths."],
  };
}

function buildBackgroundDimension(params: {
  latestBackground: SelfImprovementAuditEvent | undefined;
  intervalMs: number;
  staleAfterMs: number;
  now: number;
}): SelfImprovementOperationalHealthDimension {
  const event = params.latestBackground;
  const success =
    event?.kind === "background_cycle" ? auditBoolean(event, "success") !== false : Boolean(event);
  const ageMs = event ? Math.max(0, params.now - event.createdAt) : Number.POSITIVE_INFINITY;
  const stale = ageMs > params.staleAfterMs;
  const status: SelfImprovementOperationalHealthStatus =
    !event || !success || stale ? "blocked" : "ready";
  const blockers = [
    !event ? "No scan or analysis event exists for the Governor yet." : "",
    event && !success ? "Latest background cycle failed." : "",
    event && stale ? "Latest Governor cycle is older than the allowed cadence grace window." : "",
  ].filter(Boolean);
  return {
    id: "background",
    label: "Background cadence",
    status,
    score: status === "ready" ? 100 : 25,
    summary:
      status === "ready"
        ? "Governor background cadence is fresh."
        : "Governor background cadence is stale or failing.",
    metrics: [
      metric("intervalMs", "Interval ms", params.intervalMs),
      metric("staleAfterMs", "Stale after ms", params.staleAfterMs),
      metric("ageMs", "Age ms", Number.isFinite(ageMs) ? Math.floor(ageMs) : -1),
      metric("success", "Success", success),
    ],
    blockers,
    nextActions:
      status === "ready"
        ? ["Keep background Governor scans enabled."]
        : ["Verify Gateway maintenance is running, then run openclaw self-improvement analyze."],
  };
}

function buildProposalsDimension(params: {
  proposals: readonly SelfImprovementProposal[];
  now: number;
}): SelfImprovementOperationalHealthDimension {
  const active = params.proposals.filter(
    (proposal) => proposal.status === "pending" || proposal.status === "acknowledged",
  );
  const stale = active.filter((proposal) => params.now - proposal.updatedAt > PROPOSAL_STALE_MS);
  const memorySkill = params.proposals.filter((proposal) => proposal.kind === "memory_skill");
  const curatorPending = memorySkill.filter(
    (proposal) =>
      !proposal.curatorStatus ||
      proposal.curatorStatus === "pending_review" ||
      proposal.curatorStatus === "needs_more_evidence",
  );
  const staleCuratorPending = curatorPending.filter(
    (proposal) =>
      params.now - (proposal.curatorUpdatedAt ?? proposal.updatedAt) > PROPOSAL_STALE_MS,
  );
  const curatorAcceptedUnlinked = memorySkill.filter(
    (proposal) =>
      proposal.curatorStatus === "accepted_for_workshop" && !proposal.workshopProposalId?.trim(),
  );
  const curatorQuarantined = memorySkill.filter(
    (proposal) => proposal.workshopProposalStatus === "quarantined",
  );
  const curatorPromotedMissingProof = memorySkill.filter(
    (proposal) => proposal.curatorStatus === "promoted" && !proposal.promotionProof?.trim(),
  );
  const status: SelfImprovementOperationalHealthStatus =
    curatorQuarantined.length > 0 || curatorPromotedMissingProof.length > 0
      ? "blocked"
      : stale.length > 0 || staleCuratorPending.length > 0 || curatorAcceptedUnlinked.length > 0
        ? "degraded"
        : "ready";
  const blockers = [
    stale.length > 0 ? `${stale.length} proposal(s) have been pending for over 7 days.` : "",
    staleCuratorPending.length > 0
      ? `${staleCuratorPending.length} memory/skill curator proposal(s) are stale.`
      : "",
    curatorAcceptedUnlinked.length > 0
      ? `${curatorAcceptedUnlinked.length} accepted memory/skill proposal(s) need Skill Workshop links.`
      : "",
    curatorQuarantined.length > 0
      ? `${curatorQuarantined.length} memory/skill proposal(s) are linked to quarantined Skill Workshop proposals.`
      : "",
    curatorPromotedMissingProof.length > 0
      ? `${curatorPromotedMissingProof.length} promoted memory/skill proposal(s) lack promotion proof.`
      : "",
  ].filter(Boolean);
  return {
    id: "proposals",
    label: "Proposals",
    status,
    score: boundedScore(
      100 -
        stale.length * 12 -
        active.length * 2 -
        staleCuratorPending.length * 10 -
        curatorAcceptedUnlinked.length * 12 -
        curatorQuarantined.length * 25 -
        curatorPromotedMissingProof.length * 30,
    ),
    summary:
      status === "ready"
        ? "Proposal and curator queues are within the review window."
        : "Proposal or memory/skill curation work needs operator attention.",
    metrics: [
      metric("activeProposals", "Active", active.length),
      metric("staleProposals", "Stale", stale.length),
      metric("curatorPending", "Curator pending", curatorPending.length),
      metric("curatorStale", "Curator stale", staleCuratorPending.length),
      metric("curatorAcceptedUnlinked", "Accepted unlinked", curatorAcceptedUnlinked.length),
      metric("curatorQuarantined", "Quarantined", curatorQuarantined.length),
      metric(
        "curatorPromotedMissingProof",
        "Promoted missing proof",
        curatorPromotedMissingProof.length,
      ),
    ],
    blockers,
    nextActions:
      status === "ready"
        ? ["Continue routing pending proposals through their assigned owners."]
        : [
            "Review memory/skill curator proposals, link accepted work to Skill Workshop, and attach proof before promotion.",
          ],
  };
}

function buildVerificationDimension(params: {
  recommendations: readonly SelfImprovementRecommendation[];
  scorecard: SelfImprovementScorecard;
  actionQueue?: SelfImprovementActionQueueSummary;
  now: number;
}): SelfImprovementOperationalHealthDimension {
  const activeTestRequired = params.recommendations.filter(
    (entry) =>
      entry.status !== "resolved" &&
      entry.status !== "dismissed" &&
      entry.safety.requiresTests &&
      !entry.resolutionProof?.trim(),
  );
  const stale = activeTestRequired.filter(
    (entry) => params.now - Math.max(entry.updatedAt, entry.lastSeenAt) > VERIFICATION_STALE_MS,
  );
  const criticalStale = stale.filter((entry) => entry.priority === "critical");
  const proofMissing = params.actionQueue?.proofMissing ?? activeTestRequired.length;
  const readyToResolve = params.actionQueue?.readyToResolve ?? 0;
  const status: SelfImprovementOperationalHealthStatus =
    criticalStale.length > 0 ? "blocked" : stale.length > 0 ? "degraded" : "ready";
  const blockers = [
    criticalStale.length > 0
      ? `${criticalStale.length} critical verification blocker(s) are stale.`
      : "",
    stale.length > 0 ? `${stale.length} test-required recommendation(s) are stale.` : "",
  ].filter(Boolean);
  return {
    id: "verification",
    label: "Verification",
    status,
    score: boundedScore(
      100 -
        criticalStale.length * 35 -
        stale.length * 12 -
        Math.min(25, proofMissing * 4) +
        readyToResolve * 2,
    ),
    summary:
      status === "ready"
        ? "Verification proof is tracked before recommendations close safely."
        : "Verification proof is needed before recommendations can close safely.",
    metrics: [
      metric("testRequired", "Test required", params.scorecard.testRequired),
      metric("proofMissing", "Proof missing", proofMissing),
      metric("readyToResolve", "Ready to resolve", readyToResolve),
      metric("staleVerification", "Stale", stale.length),
      metric("criticalStaleVerification", "Critical stale", criticalStale.length),
    ],
    blockers,
    nextActions:
      status === "ready"
        ? ["Keep attaching test or smoke proof before resolving code/config recommendations."]
        : ["Attach proof for proof-missing items, then resolve ready Action Queue items."],
  };
}

function buildIntelligenceDimension(params: {
  scorecard: SelfImprovementScorecard;
}): SelfImprovementOperationalHealthDimension {
  const intelligence = params.scorecard.intelligence;
  const total = intelligence?.total ?? 0;
  const highCritical = intelligence?.highCritical ?? 0;
  const criticalMajorChange =
    intelligence?.majorChangeCandidates.filter((entry) => entry.priority === "critical").length ??
    0;
  const outcomeMetricGaps = intelligence?.outcomeMetricGaps.length ?? 0;
  const blockedHighCritical =
    intelligence?.topOpportunities.filter(
      (entry) =>
        (entry.priority === "critical" || entry.priority === "high") &&
        hasOperationalBlocker(entry),
    ).length ?? 0;
  const blockedOutcomeMetricGaps =
    intelligence?.outcomeMetricGaps.filter(hasOperationalBlocker).length ?? 0;
  const stalePatterns = intelligence?.stalePatterns.length ?? 0;
  const status: SelfImprovementOperationalHealthStatus =
    criticalMajorChange > 0 && blockedHighCritical > 0
      ? "blocked"
      : blockedHighCritical > 0 || blockedOutcomeMetricGaps > 0 || stalePatterns > 0
        ? "degraded"
        : "ready";
  const blockers = [
    criticalMajorChange > 0 && blockedHighCritical > 0
      ? `${criticalMajorChange} critical major-change candidate(s) need explicit operator review.`
      : "",
    blockedHighCritical > 0
      ? `${blockedHighCritical} high/critical intelligence opportunity group(s) need owner or SLA action.`
      : "",
    blockedOutcomeMetricGaps > 0
      ? `${blockedOutcomeMetricGaps} outcome measurement gap(s) need owner or SLA action.`
      : "",
    stalePatterns > 0 ? `${stalePatterns} unresolved improvement pattern(s) are stale.` : "",
  ].filter(Boolean);
  return {
    id: "intelligence",
    label: "Improvement intelligence",
    status,
    score: boundedScore(
      100 -
        criticalMajorChange * 35 -
        blockedHighCritical * 10 -
        blockedOutcomeMetricGaps * 8 -
        stalePatterns * 6 -
        Math.min(20, Math.max(0, total - 5) * 2),
    ),
    summary:
      status === "ready"
        ? "Continuous-improvement opportunity pressure is low."
        : "Continuous-improvement opportunities need triage or measurement.",
    metrics: [
      metric("intelligenceTotal", "Total", total),
      metric("intelligenceHighCritical", "High/critical", highCritical),
      metric(
        "instructionThemes",
        "Instruction themes",
        intelligence?.instructionThemes.length ?? 0,
      ),
      metric(
        "simplificationCandidates",
        "Simplification",
        intelligence?.simplificationCandidates.length ?? 0,
      ),
      metric(
        "majorChangeCandidates",
        "Major changes",
        intelligence?.majorChangeCandidates.length ?? 0,
      ),
      metric("outcomeMetricGaps", "Metric gaps", outcomeMetricGaps),
    ],
    blockers,
    nextActions:
      status === "ready"
        ? ["Keep using Improvement Intelligence during normal recommendation review."]
        : [
            "Review Improvement Intelligence, assign the highest impact opportunity, and attach outcome metrics before closure.",
          ],
  };
}

export function buildSelfImprovementOperationalHealth(params: {
  recommendations: readonly SelfImprovementRecommendation[];
  scorecard: SelfImprovementScorecard;
  proposals: readonly SelfImprovementProposal[];
  auditEvents: readonly SelfImprovementAuditEvent[];
  previousSnapshot?: SelfImprovementOperationalHealthSnapshot;
  now?: number;
  env?: NodeJS.ProcessEnv;
}): SelfImprovementOperationalHealthResult {
  const now = params.now ?? Date.now();
  const intervalMs = resolveIntervalMs(params.env ?? process.env);
  const staleAfterMs = intervalMs * 2;
  const latestReviewerEval = latestEvent(params.auditEvents, ["reviewer_eval_run"]);
  const latestModelPreflight = latestEvent(params.auditEvents, ["model_preflight"]);
  const latestAnalysis = latestEvent(params.auditEvents, ["analysis_run"]);
  const latestBackground =
    latestEvent(params.auditEvents, ["background_cycle"]) ??
    latestEvent(params.auditEvents, ["analysis_run", "scorecard_snapshot_written"]);
  const modelReviewAttempted = isModelReviewAttempted(params.auditEvents);
  const recommendations = buildRecommendationsDimension({
    recommendations: params.recommendations,
    scorecard: params.scorecard,
    actionQueue: params.scorecard.actionQueue,
    previous: params.previousSnapshot,
  });
  const dimensions: SelfImprovementOperationalHealthDimension[] = [
    recommendations,
    buildReviewerDimension({
      latestReviewerEval,
      modelReviewAttempted,
      now,
    }),
    buildModelsDimension({
      latestModelPreflight,
      modelReviewAttempted,
      now,
    }),
    buildBackgroundDimension({
      latestBackground,
      intervalMs,
      staleAfterMs,
      now,
    }),
    buildProposalsDimension({ proposals: params.proposals, now }),
    buildVerificationDimension({
      recommendations: params.recommendations,
      scorecard: params.scorecard,
      actionQueue: params.scorecard.actionQueue,
      now,
    }),
    buildIntelligenceDimension({ scorecard: params.scorecard }),
  ];
  const status = worstStatus(dimensions.map((dimension) => dimension.status));
  const rawScore =
    dimensions.reduce((sum, dimension) => sum + dimension.score, 0) /
    Math.max(1, dimensions.length);
  const score = boundedScore(
    status === "blocked"
      ? Math.min(rawScore, 49)
      : status === "degraded"
        ? Math.min(rawScore, 79)
        : rawScore,
  );
  const blockers = sanitizeRecommendationTexts(
    dimensions.flatMap((dimension) => dimension.blockers).slice(0, 8),
    240,
  );
  const nextActions = sanitizeRecommendationTexts(
    dimensions
      .filter((dimension) => dimension.status !== "ready")
      .flatMap((dimension) => dimension.nextActions)
      .slice(0, 8),
    240,
  );
  const currentPressure = params.scorecard.criticalOpen + params.scorecard.highOpen;
  return {
    current: {
      generatedAt: now,
      status,
      score,
      trend: deriveTrend({ currentPressure, previous: params.previousSnapshot }),
      intervalMs,
      staleAfterMs,
      dimensions,
      blockers,
      nextActions:
        nextActions.length > 0
          ? nextActions
          : ["No immediate Self-Improvement Governor operator action is required."],
      ...(params.previousSnapshot ? { previousSnapshotId: params.previousSnapshot.id } : {}),
      ...(latestReviewerEval ? { latestReviewerEvalAt: latestReviewerEval.createdAt } : {}),
      ...(latestModelPreflight ? { latestModelPreflightAt: latestModelPreflight.createdAt } : {}),
      ...(latestAnalysis ? { latestAnalysisAt: latestAnalysis.createdAt } : {}),
      ...(latestBackground ? { latestBackgroundAt: latestBackground.createdAt } : {}),
    },
    snapshots: [],
    ...(latestReviewerEval ? { latestReviewerEval } : {}),
    ...(latestModelPreflight ? { latestModelPreflight } : {}),
    ...(latestAnalysis ? { latestAnalysis } : {}),
    ...(latestBackground ? { latestBackground } : {}),
  };
}

export async function loadSelfImprovementOperationalHealth(params?: {
  stateDir?: string;
  now?: number;
  days?: number;
  limit?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<SelfImprovementOperationalHealthResult> {
  const stateDir = params?.stateDir;
  const now = params?.now ?? Date.now();
  const recommendations = await listSelfImprovementRecommendations({ stateDir });
  const summary = summarizeSelfImprovementRecommendations({ recommendations, now, limit: 50 });
  const proposals = await listSelfImprovementProposals({ stateDir, limit: 500 });
  const auditEvents = await listSelfImprovementAuditEvents({ stateDir, limit: 500 });
  const snapshots = await listSelfImprovementOperationalHealthSnapshots({
    stateDir,
    days: params?.days,
    limit: params?.limit,
  });
  const result = buildSelfImprovementOperationalHealth({
    recommendations,
    scorecard: summary.scorecard,
    proposals,
    auditEvents,
    previousSnapshot: snapshots[0],
    now,
    env: params?.env,
  });
  return {
    ...result,
    snapshots,
  };
}

export async function writeSelfImprovementOperationalHealthSnapshot(params?: {
  stateDir?: string;
  storePath?: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
  actor?: SelfImprovementAuditEvent["actor"];
}): Promise<SelfImprovementOperationalHealthSnapshot> {
  const now = params?.now ?? Date.now();
  const stateDir = params?.stateDir;
  const storePath = params?.storePath ?? resolveSelfImprovementOperationalHealthStorePath(stateDir);
  const existing = await listSelfImprovementOperationalHealthSnapshots({
    stateDir,
    storePath,
    limit: 1,
  });
  const result = await loadSelfImprovementOperationalHealth({
    stateDir,
    now,
    limit: 1,
    env: params?.env,
  });
  const health: SelfImprovementOperationalHealth = {
    ...result.current,
    ...(existing[0] ? { previousSnapshotId: existing[0].id } : {}),
  };
  const snapshot: SelfImprovementOperationalHealthSnapshot = {
    id: snapshotId(`${now}:${health.status}:${health.score}:${health.trend}`),
    createdAt: now,
    health,
  };
  const file = await readStore(storePath);
  const snapshots = [snapshot, ...file.snapshots]
    .toSorted((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .slice(0, MAX_SNAPSHOTS);
  await writeStore(storePath, { version: STORE_VERSION, snapshots });
  await appendSelfImprovementAuditEvent({
    stateDir,
    event: {
      createdAt: now,
      actor: params?.actor ?? "governor",
      kind: "operational_health_snapshot",
      targetId: "self-improvement-health",
      summary: `Wrote Self-Improvement operational health snapshot: ${health.status}.`,
      metadata: {
        status: health.status,
        score: health.score,
        trend: health.trend,
        blockerCount: health.blockers.length,
        dimensions: health.dimensions.map(
          (dimension) => `${dimension.id}:${dimension.status}:${dimension.score}`,
        ),
        blockers: health.blockers.slice(0, 6),
      },
    },
  });
  return cloneSnapshot(snapshot);
}
