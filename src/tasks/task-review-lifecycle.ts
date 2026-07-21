// Owns deterministic managed-flow review dispatch, outcomes, and recovery state.
/* oxlint-disable max-lines -- Review dispatch and recovery remain one state-machine authority. */
import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { reloadTaskRuntimeStateFromStore } from "./runtime-internal.js";
import { recordTaskRunProgressByRunId } from "./task-executor.js";
import { getTaskFlowByIdForOwner, listTaskFlowsForOwner } from "./task-flow-owner-access.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  getTaskById,
  listTasksForFlowId,
  maybeDeliverTaskTerminalUpdate,
} from "./task-registry.js";
import type { JsonValue, TaskDeliveryState, TaskRecord } from "./task-registry.types.js";
import {
  bindReviewLaunchAtomically,
  commitReviewTaskAndFlowAtomically,
  createReviewDispatchAtomically,
} from "./task-review-store.js";

export const TASK_REVIEW_KIND = "managed-review";
export const DEFAULT_TASK_REVIEW_STALE_MS = 30 * 60_000;
export const DEFAULT_TASK_REVIEW_MAX_RECOVERY_ATTEMPTS = 2;

export type TaskReviewState =
  | "review_pending"
  | "changes_requested"
  | "merge_ready"
  | "awaiting_owner"
  | "recovery_pending"
  | "recovering"
  | "reverify_pending"
  | "recovery_failed";

export type TaskReviewProofBundle = {
  commit: string;
  baseCommit: string;
  diff: {
    sha256: string;
    summary: string;
    files: string[];
  };
  tests: Array<{
    name: string;
    command: string;
    status: "passed" | "failed";
    evidence: string;
  }>;
  screenshots: Array<{
    name: string;
    path: string;
    sha256: string;
  }>;
  criteria: Array<{
    id: string;
    description: string;
  }>;
};

export type TaskReviewRequest = {
  reviewerAgentId: string;
  proofBundle: TaskReviewProofBundle;
  staleAfterMs: number;
  maxRecoveryAttempts: number;
};

export type TaskReviewContinuity = {
  ownerKey: string;
  sessionKey: string;
  sessionId?: string;
  compactionCount?: number;
  sourceTaskId?: string;
};

type TaskReviewHistoryEntry = {
  state: TaskReviewState;
  at: number;
  summary: string;
};

export type TaskReviewDetail = {
  kind: typeof TASK_REVIEW_KIND;
  version: 1;
  state: TaskReviewState;
  dispatchKey: string;
  reviewerAgentId: string;
  proofBundle: TaskReviewProofBundle;
  continuity: TaskReviewContinuity;
  staleAfterMs: number;
  stateChangedAt: number;
  recoveryAttempt: number;
  maxRecoveryAttempts: number;
  launch: {
    phase: "claimed" | "bound";
    attempt: number;
    claimedAt: number;
    reviewerRunId?: string;
    childSessionKey?: string;
  };
  reviewerRunId?: string;
  childSessionKey?: string;
  history: TaskReviewHistoryEntry[];
  decision?: TaskReviewDecision;
};

type ReviewCriterionDecision = {
  id: string;
  status: "passed" | "failed";
  evidence: string;
};

export type TaskReviewDecision =
  | {
      outcome: "changes_requested";
      reviewedCommit: string;
      criteria: ReviewCriterionDecision[];
      findings: string[];
    }
  | {
      outcome: "merge_ready";
      reviewedCommit: string;
      criteria: ReviewCriterionDecision[];
      findings: [];
    }
  | {
      outcome: "awaiting_owner";
      reviewedCommit: string;
      criteria: ReviewCriterionDecision[];
      ownerQuestion: string;
      whyAutomationCannotDecide: string;
    };

export type DispatchTaskReviewResult =
  | { ok: true; created: boolean; task: TaskRecord; detail: TaskReviewDetail }
  | { ok: false; reason: string };

export type TaskReviewerLaunchResult =
  | { ok: true; reviewerRunId: string; childSessionKey: string }
  | { ok: false; reason: string };

export type TaskReviewerInspection =
  | { state: "live" }
  | { state: "missing" }
  | { state: "failed"; reason: string }
  | { state: "completed"; decision: unknown };

export type TaskReviewerRuntime = {
  launch(params: {
    task: TaskRecord;
    detail: TaskReviewDetail;
    recoveryAttempt: number;
  }): Promise<TaskReviewerLaunchResult>;
  inspect(params: {
    reviewerRunId: string;
    childSessionKey: string;
  }): Promise<TaskReviewerInspection>;
  settleNonOwningLaunch?(params: { reviewerRunId: string; childSessionKey: string }): Promise<void>;
};

type TaskReviewLaunchClaimSnapshot = {
  rawExpectedDetail: JsonValue;
  attempt: number;
  claimedAt: number;
};

const REVIEW_STATES = new Set<TaskReviewState>([
  "review_pending",
  "changes_requested",
  "merge_ready",
  "awaiting_owner",
  "recovery_pending",
  "recovering",
  "reverify_pending",
  "recovery_failed",
]);

const ALLOWED_TRANSITIONS: Record<TaskReviewState, ReadonlySet<TaskReviewState>> = {
  review_pending: new Set([
    "changes_requested",
    "merge_ready",
    "awaiting_owner",
    "recovery_pending",
  ]),
  changes_requested: new Set(),
  merge_ready: new Set(),
  awaiting_owner: new Set(),
  recovery_pending: new Set(["recovering", "recovery_failed"]),
  recovering: new Set(["reverify_pending", "recovery_failed"]),
  reverify_pending: new Set(["review_pending", "recovery_pending", "recovery_failed"]),
  recovery_failed: new Set(),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireString(value: unknown, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function requireHex(value: unknown, length: number, label: string): string {
  const normalized = requireString(value, label).toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${length}}$`, "u").test(normalized)) {
    throw new Error(`${label} must be a ${length}-character hexadecimal value.`);
  }
  return normalized;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function parseProofBundle(value: unknown): TaskReviewProofBundle {
  const proof = requireObject(value, "reviewRequest.proofBundle");
  const diff = requireObject(proof.diff, "reviewRequest.proofBundle.diff");
  const files = requireArray(diff.files, "reviewRequest.proofBundle.diff.files")
    .map((entry, index) => requireString(entry, `reviewRequest.proofBundle.diff.files[${index}]`))
    .toSorted();
  const tests = requireArray(proof.tests, "reviewRequest.proofBundle.tests").map((entry, index) => {
    const test = requireObject(entry, `reviewRequest.proofBundle.tests[${index}]`);
    if (test.status !== "passed" && test.status !== "failed") {
      throw new Error(`reviewRequest.proofBundle.tests[${index}].status is invalid.`);
    }
    const status: "passed" | "failed" = test.status;
    return {
      name: requireString(test.name, `reviewRequest.proofBundle.tests[${index}].name`),
      command: requireString(test.command, `reviewRequest.proofBundle.tests[${index}].command`),
      status,
      evidence: requireString(test.evidence, `reviewRequest.proofBundle.tests[${index}].evidence`),
    };
  });
  const screenshots = requireArray(proof.screenshots, "reviewRequest.proofBundle.screenshots").map(
    (entry, index) => {
      const screenshot = requireObject(entry, `reviewRequest.proofBundle.screenshots[${index}]`);
      return {
        name: requireString(
          screenshot.name,
          `reviewRequest.proofBundle.screenshots[${index}].name`,
        ),
        path: requireString(
          screenshot.path,
          `reviewRequest.proofBundle.screenshots[${index}].path`,
        ),
        sha256: requireHex(
          screenshot.sha256,
          64,
          `reviewRequest.proofBundle.screenshots[${index}].sha256`,
        ),
      };
    },
  );
  const criteria = requireArray(proof.criteria, "reviewRequest.proofBundle.criteria").map(
    (entry, index) => {
      const criterion = requireObject(entry, `reviewRequest.proofBundle.criteria[${index}]`);
      return {
        id: requireString(criterion.id, `reviewRequest.proofBundle.criteria[${index}].id`),
        description: requireString(
          criterion.description,
          `reviewRequest.proofBundle.criteria[${index}].description`,
        ),
      };
    },
  );
  if (criteria.length === 0) {
    throw new Error("reviewRequest.proofBundle.criteria must not be empty.");
  }
  if (new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length) {
    throw new Error("reviewRequest.proofBundle.criteria ids must be unique.");
  }
  return {
    commit: requireHex(proof.commit, 40, "reviewRequest.proofBundle.commit"),
    baseCommit: requireHex(proof.baseCommit, 40, "reviewRequest.proofBundle.baseCommit"),
    diff: {
      sha256: requireHex(diff.sha256, 64, "reviewRequest.proofBundle.diff.sha256"),
      summary: requireString(diff.summary, "reviewRequest.proofBundle.diff.summary"),
      files,
    },
    tests,
    screenshots,
    criteria,
  };
}

export function parseTaskReviewRequest(flow: TaskFlowRecord): TaskReviewRequest {
  const state = requireObject(flow.stateJson, "TaskFlow state");
  const request = requireObject(state.reviewRequest, "TaskFlow state.reviewRequest");
  const staleAfterMsRaw = request.staleAfterMs;
  const maxRecoveryAttemptsRaw = request.maxRecoveryAttempts;
  const staleAfterMs =
    typeof staleAfterMsRaw === "number" &&
    Number.isFinite(staleAfterMsRaw) &&
    staleAfterMsRaw >= 1_000
      ? Math.floor(staleAfterMsRaw)
      : DEFAULT_TASK_REVIEW_STALE_MS;
  return {
    reviewerAgentId: requireString(
      request.reviewerAgentId,
      "TaskFlow state.reviewRequest.reviewerAgentId",
    ),
    proofBundle: parseProofBundle(request.proofBundle),
    staleAfterMs,
    maxRecoveryAttempts:
      typeof maxRecoveryAttemptsRaw === "number" &&
      Number.isSafeInteger(maxRecoveryAttemptsRaw) &&
      maxRecoveryAttemptsRaw >= 1 &&
      maxRecoveryAttemptsRaw <= 5
        ? maxRecoveryAttemptsRaw
        : DEFAULT_TASK_REVIEW_MAX_RECOVERY_ATTEMPTS,
  };
}

function buildDispatchKey(params: {
  flowId: string;
  reviewerAgentId: string;
  proofBundle: TaskReviewProofBundle;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        flowId: params.flowId,
        reviewerAgentId: params.reviewerAgentId,
        proofBundle: params.proofBundle,
      }),
    )
    .digest("hex");
}

function buildReviewPrompt(detail: TaskReviewDetail): string {
  return [
    `Review exact commit ${detail.proofBundle.commit} over base ${detail.proofBundle.baseCommit}.`,
    "Verify the supplied diff, tests, screenshots, and every acceptance criterion.",
    "Return exactly one outcome: changes_requested, merge_ready, or awaiting_owner.",
    "Use awaiting_owner only for a genuine decision that cannot be resolved from code or proof.",
    "Return only JSON with reviewedCommit, outcome, criteria, and the outcome-specific fields.",
    "Each criteria item must contain id, status (passed or failed), and evidence.",
    "changes_requested also requires non-empty findings; merge_ready requires findings: []; awaiting_owner requires ownerQuestion and whyAutomationCannotDecide.",
    `Proof bundle: ${JSON.stringify(detail.proofBundle)}`,
  ].join("\n");
}

function detailToJson(detail: TaskReviewDetail): JsonValue {
  return structuredClone(detail) as unknown as JsonValue;
}

export function parseTaskReviewDetail(
  task: Pick<TaskRecord, "taskKind" | "detail">,
): TaskReviewDetail | undefined {
  if (task.taskKind !== TASK_REVIEW_KIND || !isRecord(task.detail)) {
    return undefined;
  }
  const detail = task.detail;
  if (
    detail.kind !== TASK_REVIEW_KIND ||
    detail.version !== 1 ||
    typeof detail.state !== "string" ||
    !REVIEW_STATES.has(detail.state as TaskReviewState)
  ) {
    return undefined;
  }
  const parsed = structuredClone(detail) as unknown as TaskReviewDetail;
  if (!isRecord(parsed.launch)) {
    parsed.launch =
      parsed.reviewerRunId && parsed.childSessionKey
        ? {
            phase: "bound",
            attempt: parsed.recoveryAttempt,
            claimedAt: parsed.stateChangedAt,
            reviewerRunId: parsed.reviewerRunId,
            childSessionKey: parsed.childSessionKey,
          }
        : {
            phase: "claimed",
            attempt: parsed.recoveryAttempt,
            claimedAt: parsed.stateChangedAt,
          };
  }
  return parsed;
}

function findReviewTask(flowId: string, dispatchKey: string): TaskRecord | undefined {
  return listTasksForFlowId(flowId).find(
    (task) => parseTaskReviewDetail(task)?.dispatchKey === dispatchKey,
  );
}

export async function dispatchTaskReview(params: {
  flowId: string;
  callerOwnerKey: string;
  request: TaskReviewRequest;
  continuity: TaskReviewContinuity;
  parentTaskId?: string;
  now?: number;
  runtime: TaskReviewerRuntime;
}): Promise<DispatchTaskReviewResult> {
  const flow = getTaskFlowByIdForOwner({
    flowId: params.flowId,
    callerOwnerKey: params.callerOwnerKey,
  });
  if (!flow || flow.syncMode !== "managed") {
    return { ok: false, reason: "Managed TaskFlow not found." };
  }
  const now = params.now ?? Date.now();
  const dispatchKey = buildDispatchKey({
    flowId: flow.flowId,
    reviewerAgentId: params.request.reviewerAgentId,
    proofBundle: params.request.proofBundle,
  });
  const existing = findReviewTask(flow.flowId, dispatchKey);
  if (existing) {
    const detail = parseTaskReviewDetail(existing);
    const refreshed = detail
      ? refreshTaskReviewContinuity({ taskId: existing.taskId, continuity: params.continuity, now })
      : undefined;
    const refreshedDetail = refreshed ? parseTaskReviewDetail(refreshed) : undefined;
    return refreshed && refreshedDetail
      ? { ok: true, created: false, task: refreshed, detail: refreshedDetail }
      : { ok: false, reason: "Existing review task detail is invalid." };
  }
  const detail: TaskReviewDetail = {
    kind: TASK_REVIEW_KIND,
    version: 1,
    state: "review_pending",
    dispatchKey,
    reviewerAgentId: params.request.reviewerAgentId,
    proofBundle: params.request.proofBundle,
    continuity: params.continuity,
    staleAfterMs: params.request.staleAfterMs,
    stateChangedAt: now,
    recoveryAttempt: 0,
    maxRecoveryAttempts: params.request.maxRecoveryAttempts,
    launch: { phase: "claimed", attempt: 0, claimedAt: now },
    history: [{ state: "review_pending", at: now, summary: "Review dispatched." }],
  };
  const runId = `task-review:${dispatchKey}`;
  const task: TaskRecord = {
    taskId: `review-${dispatchKey}`,
    runtime: "subagent",
    taskKind: TASK_REVIEW_KIND,
    sourceId: runId,
    requesterSessionKey: flow.ownerKey,
    ownerKey: flow.ownerKey,
    scopeKind: "session",
    parentFlowId: flow.flowId,
    ...(params.parentTaskId ? { parentTaskId: params.parentTaskId } : {}),
    agentId: params.request.reviewerAgentId,
    label: `Review ${params.request.proofBundle.commit.slice(0, 12)}`,
    task: buildReviewPrompt(detail),
    runId,
    status: "queued" as const,
    notifyPolicy: "state_changes",
    deliveryStatus: "pending",
    createdAt: now,
    lastEventAt: now,
    progressSummary: `Review pending for ${params.request.proofBundle.commit.slice(0, 12)}.`,
    detail: detailToJson(detail),
  };
  const flowState = isRecord(flow.stateJson) ? flow.stateJson : {};
  const atomic = createReviewDispatchAtomically({
    flow,
    expectedRevision: flow.revision,
    nextStateJson: {
      ...flowState,
      review: {
        state: "review_pending",
        taskId: task.taskId,
        dispatchKey,
        commit: detail.proofBundle.commit,
        reviewerAgentId: detail.reviewerAgentId,
      },
    },
    task,
    ...(flow.requesterOrigin
      ? {
          deliveryState: {
            taskId: task.taskId,
            requesterOrigin: flow.requesterOrigin,
          } satisfies TaskDeliveryState,
        }
      : {}),
  });
  reloadTaskRuntimeStateFromStore();
  const stored = getTaskById(task.taskId);
  const storedDetail = stored ? parseTaskReviewDetail(stored) : undefined;
  if (atomic.status === "flow_conflict" || !stored || !storedDetail) {
    return { ok: false, reason: "Review dispatch lost its TaskFlow revision race." };
  }
  if (atomic.status === "existing") {
    return { ok: true, created: false, task: stored, detail: storedDetail };
  }

  const launchClaim = captureLaunchClaim(stored, storedDetail);
  const launched = await params.runtime.launch({
    task: stored,
    detail: storedDetail,
    recoveryAttempt: 0,
  });
  if (!launched.ok) {
    const pending = markClaimFailureIfCurrent({
      taskId: stored.taskId,
      expected: storedDetail.launch,
      reason: `reviewer launch failed: ${launched.reason}`,
      now: Date.now(),
    });
    const pendingDetail = parseTaskReviewDetail(pending);
    if (pendingDetail?.launch.phase === "bound") {
      return { ok: true, created: true, task: pending, detail: pendingDetail };
    }
    return {
      ok: false,
      reason: `Reviewer launch failed; durable recovery is pending: ${launched.reason}`,
    };
  }
  const binding = await settleTaskReviewLaunch({
    taskId: stored.taskId,
    launched,
    claim: launchClaim,
    runtime: params.runtime,
    now: Date.now(),
  });
  const bound = binding.task;
  return {
    ok: true,
    created: true,
    task: bound,
    detail: parseTaskReviewDetail(bound) ?? storedDetail,
  };
}

function captureLaunchClaim(
  task: TaskRecord,
  detail: TaskReviewDetail,
): TaskReviewLaunchClaimSnapshot {
  if (detail.launch.phase !== "claimed") {
    throw new Error("Managed review launch does not own a claimed phase.");
  }
  return {
    rawExpectedDetail: structuredClone(task.detail ?? detailToJson(detail)),
    attempt: detail.launch.attempt,
    claimedAt: detail.launch.claimedAt,
  };
}

function markClaimFailureIfCurrent(params: {
  taskId: string;
  expected: TaskReviewDetail["launch"];
  reason: string;
  now: number;
}): TaskRecord {
  const current = getTaskById(params.taskId);
  const detail = current ? parseTaskReviewDetail(current) : undefined;
  if (!current || !detail) {
    throw new Error("Managed review task not found while settling launch claim.");
  }
  if (
    detail.launch.phase !== "claimed" ||
    detail.launch.attempt !== params.expected.attempt ||
    detail.launch.claimedAt !== params.expected.claimedAt
  ) {
    return current;
  }
  return markTaskReviewRecoveryPending({
    taskId: current.taskId,
    reason: params.reason,
    now: params.now,
  });
}

function bindTaskReviewLaunch(params: {
  taskId: string;
  launched: Extract<TaskReviewerLaunchResult, { ok: true }>;
  claim: TaskReviewLaunchClaimSnapshot;
  now: number;
}): { task: TaskRecord; owned: boolean } {
  const task = getTaskById(params.taskId);
  const detail = task ? parseTaskReviewDetail(task) : undefined;
  if (!task || !detail || !task.runId) {
    throw new Error("Managed review task disappeared while binding its reviewer child.");
  }
  if (
    detail.launch.phase === "bound" &&
    detail.launch.reviewerRunId === params.launched.reviewerRunId &&
    detail.launch.childSessionKey === params.launched.childSessionKey
  ) {
    return { task, owned: true };
  }
  if (
    detail.launch.phase !== "claimed" ||
    detail.launch.attempt !== params.claim.attempt ||
    detail.launch.claimedAt !== params.claim.claimedAt
  ) {
    return { task, owned: false };
  }
  const nextDetail: TaskReviewDetail = {
    ...detail,
    reviewerRunId: params.launched.reviewerRunId,
    childSessionKey: params.launched.childSessionKey,
    launch: {
      ...detail.launch,
      phase: "bound",
      reviewerRunId: params.launched.reviewerRunId,
      childSessionKey: params.launched.childSessionKey,
    },
    stateChangedAt: params.now,
    history: [
      ...detail.history,
      { state: detail.state, at: params.now, summary: "Reviewer child bound." },
    ],
  };
  const bound = bindReviewLaunchAtomically({
    task,
    expectedDetail: params.claim.rawExpectedDetail,
    expectedAttempt: params.claim.attempt,
    expectedClaimedAt: params.claim.claimedAt,
    nextDetail: detailToJson(nextDetail),
    childSessionKey: params.launched.childSessionKey,
    now: params.now,
  });
  reloadTaskRuntimeStateFromStore();
  const updated = getTaskById(task.taskId);
  if (!updated) {
    throw new Error("Reviewer child binding did not persist.");
  }
  if (bound.status === "task_conflict") {
    return { task: updated, owned: false };
  }
  return { task: updated, owned: true };
}

async function settleTaskReviewLaunch(params: {
  taskId: string;
  launched: Extract<TaskReviewerLaunchResult, { ok: true }>;
  claim: TaskReviewLaunchClaimSnapshot;
  runtime: TaskReviewerRuntime;
  now: number;
}): Promise<{ task: TaskRecord; owned: boolean }> {
  const bound = bindTaskReviewLaunch(params);
  if (!bound.owned) {
    await params.runtime.settleNonOwningLaunch?.({
      reviewerRunId: params.launched.reviewerRunId,
      childSessionKey: params.launched.childSessionKey,
    });
  }
  return bound;
}

export function refreshTaskReviewContinuity(params: {
  taskId: string;
  continuity: TaskReviewContinuity;
  now?: number;
}): TaskRecord {
  const task = getTaskById(params.taskId);
  const detail = task ? parseTaskReviewDetail(task) : undefined;
  if (!task || !detail || !task.runId) {
    throw new Error("Managed review task not found.");
  }
  if (JSON.stringify(detail.continuity) === JSON.stringify(params.continuity)) {
    return task;
  }
  const now = params.now ?? Date.now();
  const nextDetail: TaskReviewDetail = {
    ...detail,
    continuity: structuredClone(params.continuity),
    history: [
      ...detail.history,
      { state: detail.state, at: now, summary: "Continuity refreshed." },
    ],
  };
  recordTaskRunProgressByRunId({
    runId: task.runId,
    runtime: task.runtime,
    lastEventAt: now,
    eventSummary: "Review continuity refreshed.",
    detail: detailToJson(nextDetail),
  });
  const updated = getTaskById(task.taskId);
  if (!updated) {
    throw new Error("Review continuity refresh did not persist.");
  }
  return updated;
}

function validateCriterionDecisions(
  proofBundle: TaskReviewProofBundle,
  decisions: ReviewCriterionDecision[],
): void {
  const expectedIds = proofBundle.criteria.map((criterion) => criterion.id).toSorted();
  const actualIds = decisions.map((criterion) => criterion.id).toSorted();
  if (
    new Set(actualIds).size !== actualIds.length ||
    expectedIds.join("\n") !== actualIds.join("\n")
  ) {
    throw new Error("Reviewer decision must cover every acceptance criterion exactly once.");
  }
  for (const [index, decision] of decisions.entries()) {
    requireString(decision.evidence, `decision.criteria[${index}].evidence`);
    if (decision.status !== "passed" && decision.status !== "failed") {
      throw new Error(`decision.criteria[${index}].status is invalid.`);
    }
  }
}

function validateDecision(detail: TaskReviewDetail, decision: TaskReviewDecision): void {
  if (decision.reviewedCommit !== detail.proofBundle.commit) {
    throw new Error("Reviewer decision commit does not match the dispatched proof bundle.");
  }
  validateCriterionDecisions(detail.proofBundle, decision.criteria);
  if (decision.outcome === "changes_requested" && decision.findings.length === 0) {
    throw new Error("changes_requested requires at least one actionable finding.");
  }
  if (decision.outcome === "merge_ready") {
    if (decision.findings.length !== 0) {
      throw new Error("merge_ready cannot include findings.");
    }
    if (detail.proofBundle.tests.some((test) => test.status !== "passed")) {
      throw new Error("merge_ready requires every supplied test to pass.");
    }
    if (decision.criteria.some((criterion) => criterion.status !== "passed")) {
      throw new Error("merge_ready requires every acceptance criterion to pass.");
    }
  }
  if (decision.outcome === "awaiting_owner") {
    requireString(decision.ownerQuestion, "awaiting_owner.ownerQuestion");
    requireString(decision.whyAutomationCannotDecide, "awaiting_owner.whyAutomationCannotDecide");
  }
}

export function parseTaskReviewDecision(value: unknown): TaskReviewDecision {
  const decision = requireObject(value, "Reviewer decision");
  const outcome = decision.outcome;
  if (
    outcome !== "changes_requested" &&
    outcome !== "merge_ready" &&
    outcome !== "awaiting_owner"
  ) {
    throw new Error("Reviewer decision outcome is invalid.");
  }
  const criteria = requireArray(decision.criteria, "decision.criteria").map((entry, index) => {
    const criterion = requireObject(entry, `decision.criteria[${index}]`);
    if (criterion.status !== "passed" && criterion.status !== "failed") {
      throw new Error(`decision.criteria[${index}].status is invalid.`);
    }
    const status: "passed" | "failed" = criterion.status;
    return {
      id: requireString(criterion.id, `decision.criteria[${index}].id`),
      status,
      evidence: requireString(criterion.evidence, `decision.criteria[${index}].evidence`),
    };
  });
  const reviewedCommit = requireString(decision.reviewedCommit, "decision.reviewedCommit");
  if (outcome === "awaiting_owner") {
    return {
      outcome,
      reviewedCommit,
      criteria,
      ownerQuestion: requireString(decision.ownerQuestion, "decision.ownerQuestion"),
      whyAutomationCannotDecide: requireString(
        decision.whyAutomationCannotDecide,
        "decision.whyAutomationCannotDecide",
      ),
    };
  }
  const findings = requireArray(decision.findings, "decision.findings").map((entry, index) =>
    requireString(entry, `decision.findings[${index}]`),
  );
  if (outcome === "merge_ready" && findings.length > 0) {
    throw new Error("merge_ready cannot include findings.");
  }
  return outcome === "merge_ready"
    ? { outcome, reviewedCommit, criteria, findings: [] }
    : { outcome, reviewedCommit, criteria, findings };
}

function appendState(
  detail: TaskReviewDetail,
  state: TaskReviewState,
  at: number,
  summary: string,
): TaskReviewDetail {
  if (!ALLOWED_TRANSITIONS[detail.state].has(state)) {
    throw new Error(`Invalid task review transition: ${detail.state} -> ${state}.`);
  }
  return {
    ...detail,
    state,
    stateChangedAt: at,
    recoveryAttempt: state === "recovering" ? detail.recoveryAttempt + 1 : detail.recoveryAttempt,
    history: [...detail.history, { state, at, summary }],
  };
}

function buildReviewProjection(task: TaskRecord, detail: TaskReviewDetail): JsonValue {
  return {
    state: detail.state,
    taskId: task.taskId,
    dispatchKey: detail.dispatchKey,
    commit: detail.proofBundle.commit,
    reviewerAgentId: detail.reviewerAgentId,
    recoveryAttempt: detail.recoveryAttempt,
    launchPhase: detail.launch.phase,
    launchAttempt: detail.launch.attempt,
    ...(detail.decision ? { decision: detail.decision } : {}),
  } as JsonValue;
}

class TaskReviewMutationConflict extends Error {
  constructor(
    readonly task: TaskRecord,
    status: string,
  ) {
    super(`Managed review atomic projection failed: ${status}.`);
  }
}

function persistTaskReviewMutation(params: {
  task: TaskRecord;
  expectedDetail: TaskReviewDetail;
  nextDetail: TaskReviewDetail;
  nextTask: TaskRecord;
  now: number;
}): TaskRecord {
  const blocked =
    params.nextDetail.state === "changes_requested" || params.nextDetail.state === "awaiting_owner";
  const failed = params.nextDetail.state === "recovery_failed";
  const result = commitReviewTaskAndFlowAtomically({
    task: params.task,
    expectedDetail: params.task.detail ?? detailToJson(params.expectedDetail),
    nextTask: params.nextTask,
    reviewProjection: buildReviewProjection(params.task, params.nextDetail),
    flowStatus: failed ? "failed" : blocked ? "blocked" : "waiting",
    currentStep: params.nextDetail.state,
    ...(blocked
      ? {
          blockedSummary:
            params.nextTask.terminalSummary ??
            params.nextTask.progressSummary ??
            `Review ${params.nextDetail.state}.`,
        }
      : {}),
    ...(failed ? { flowEndedAt: params.now } : {}),
    now: params.now,
  });
  reloadTaskRuntimeStateFromStore();
  const updated = getTaskById(params.task.taskId);
  if (!updated) {
    throw new Error("Managed review task disappeared during atomic projection.");
  }
  if (result.status !== "applied") {
    throw new TaskReviewMutationConflict(updated, result.status);
  }
  return updated;
}

function transitionTaskReview(params: {
  task: TaskRecord;
  state: TaskReviewState;
  now: number;
  summary: string;
}): TaskRecord {
  const detail = parseTaskReviewDetail(params.task);
  if (!detail || !params.task.runId) {
    throw new Error("Task is not a managed review task with a stable run id.");
  }
  const nextDetail = appendState(detail, params.state, params.now, params.summary);
  return persistTaskReviewMutation({
    task: params.task,
    expectedDetail: detail,
    nextDetail,
    nextTask: {
      ...params.task,
      lastEventAt: params.now,
      progressSummary: params.summary,
      detail: detailToJson(nextDetail),
    },
    now: params.now,
  });
}

export function applyTaskReviewDecision(params: {
  taskId: string;
  decision: TaskReviewDecision;
  now?: number;
}): TaskRecord {
  const task = getTaskById(params.taskId);
  const detail = task ? parseTaskReviewDetail(task) : undefined;
  if (!task || !detail || !task.runId) {
    throw new Error("Managed review task not found.");
  }
  if (detail.state !== "review_pending") {
    throw new Error(`Review decision is not allowed from ${detail.state}.`);
  }
  validateDecision(detail, params.decision);
  const now = params.now ?? Date.now();
  const summary =
    params.decision.outcome === "changes_requested"
      ? `Changes requested for ${detail.proofBundle.commit.slice(0, 12)}.`
      : params.decision.outcome === "merge_ready"
        ? `Merge ready for ${detail.proofBundle.commit.slice(0, 12)}.`
        : `Owner decision required for ${detail.proofBundle.commit.slice(0, 12)}.`;
  const nextDetail = {
    ...appendState(detail, params.decision.outcome, now, summary),
    decision: params.decision,
  };
  const updated = persistTaskReviewMutation({
    task,
    expectedDetail: detail,
    nextDetail,
    nextTask: {
      ...task,
      status: "succeeded",
      endedAt: now,
      lastEventAt: now,
      progressSummary: summary,
      terminalSummary: summary,
      terminalOutcome: params.decision.outcome === "merge_ready" ? "succeeded" : "blocked",
      detail: detailToJson(nextDetail),
    },
    now,
  });
  void maybeDeliverTaskTerminalUpdate(updated.taskId);
  return updated;
}

export function markTaskReviewRecoveryPending(params: {
  taskId: string;
  reason: string;
  now?: number;
}): TaskRecord {
  const task = getTaskById(params.taskId);
  if (!task) {
    throw new Error("Managed review task not found.");
  }
  const reason = requireString(params.reason, "Recovery reason");
  return transitionTaskReview({
    task,
    state: "recovery_pending",
    now: params.now ?? Date.now(),
    summary: `Review recovery pending: ${reason}`,
  });
}

export function beginTaskReviewRecovery(params: { taskId: string; now?: number }): TaskRecord {
  const task = getTaskById(params.taskId);
  const detail = task ? parseTaskReviewDetail(task) : undefined;
  if (!task || !detail) {
    throw new Error("Managed review task not found.");
  }
  const now = params.now ?? Date.now();
  const summary = "Review recovery claimed.";
  const nextDetail: TaskReviewDetail = {
    ...appendState(detail, "recovering", now, summary),
    reviewerRunId: undefined,
    childSessionKey: undefined,
    launch: {
      phase: "claimed",
      attempt: detail.recoveryAttempt + 1,
      claimedAt: now,
    },
  };
  return persistTaskReviewMutation({
    task,
    expectedDetail: detail,
    nextDetail,
    nextTask: {
      ...task,
      childSessionKey: undefined,
      lastEventAt: now,
      progressSummary: summary,
      detail: detailToJson(nextDetail),
    },
    now,
  });
}

export function markTaskReviewReverifyPending(params: {
  taskId: string;
  now?: number;
}): TaskRecord {
  const task = getTaskById(params.taskId);
  if (!task) {
    throw new Error("Managed review task not found.");
  }
  return transitionTaskReview({
    task,
    state: "reverify_pending",
    now: params.now ?? Date.now(),
    summary: "Review proof must be reverified before merge readiness.",
  });
}

export function resumeTaskReviewVerification(params: { taskId: string; now?: number }): TaskRecord {
  const task = getTaskById(params.taskId);
  if (!task) {
    throw new Error("Managed review task not found.");
  }
  const detail = parseTaskReviewDetail(task);
  return transitionTaskReview({
    task,
    state: "review_pending",
    now: params.now ?? Date.now(),
    summary: `Review resumed for ${detail?.proofBundle.commit.slice(0, 12) ?? "exact proof"}.`,
  });
}

function failTaskReviewRecovery(params: {
  task: TaskRecord;
  detail: TaskReviewDetail;
  reason: string;
  now: number;
}): TaskRecord {
  if (!params.task.runId) {
    throw new Error("Managed review task has no stable run id.");
  }
  const nextDetail = appendState(
    params.detail,
    "recovery_failed",
    params.now,
    `Review recovery exhausted: ${params.reason}`,
  );
  const summary = `Review recovery exhausted: ${params.reason}`;
  const updated = persistTaskReviewMutation({
    task: params.task,
    expectedDetail: params.detail,
    nextDetail,
    nextTask: {
      ...params.task,
      status: "failed",
      endedAt: params.now,
      lastEventAt: params.now,
      error: params.reason,
      progressSummary: summary,
      terminalSummary: summary,
      terminalOutcome: undefined,
      detail: detailToJson(nextDetail),
    },
    now: params.now,
  });
  void maybeDeliverTaskTerminalUpdate(updated.taskId);
  return updated;
}

export async function reconcileTaskReviewRuntime(params: {
  taskId: string;
  runtime: TaskReviewerRuntime;
  now?: number;
}): Promise<{ state: "adopted" | "completed" | "recovered" | "failed"; task: TaskRecord }> {
  const now = params.now ?? Date.now();
  let task = getTaskById(params.taskId);
  let detail = task ? parseTaskReviewDetail(task) : undefined;
  if (!task || !detail) {
    throw new Error("Managed review task not found.");
  }

  if (detail.state === "review_pending" && detail.launch.phase === "claimed") {
    if (now - detail.launch.claimedAt < detail.staleAfterMs) {
      return { state: "adopted", task };
    }
    const expectedLaunch = detail.launch;
    const launchClaim = captureLaunchClaim(task, detail);
    const launched = await params.runtime.launch({
      task,
      detail,
      recoveryAttempt: detail.launch.attempt,
    });
    if (launched.ok) {
      const rebound = await settleTaskReviewLaunch({
        taskId: task.taskId,
        launched,
        claim: launchClaim,
        runtime: params.runtime,
        now,
      });
      return { state: rebound.owned ? "recovered" : "adopted", task: rebound.task };
    }
    task = markClaimFailureIfCurrent({
      taskId: task.taskId,
      expected: expectedLaunch,
      reason: `claimed reviewer launch failed: ${launched.reason}`,
      now,
    });
    detail = parseTaskReviewDetail(task);
  } else if (
    detail.state === "review_pending" &&
    detail.launch.phase === "bound" &&
    detail.launch.reviewerRunId &&
    detail.launch.childSessionKey
  ) {
    const inspected = await params.runtime.inspect({
      reviewerRunId: detail.launch.reviewerRunId,
      childSessionKey: detail.launch.childSessionKey,
    });
    if (inspected.state === "live") {
      return { state: "adopted", task };
    }
    if (inspected.state === "completed") {
      try {
        const completed = applyTaskReviewDecision({
          taskId: task.taskId,
          decision: parseTaskReviewDecision(inspected.decision),
          now,
        });
        return { state: "completed", task: completed };
      } catch (error) {
        if (error instanceof TaskReviewMutationConflict) {
          return { state: "adopted", task: error.task };
        }
        task = markTaskReviewRecoveryPending({
          taskId: task.taskId,
          reason: `invalid reviewer decision: ${error instanceof Error ? error.message : String(error)}`,
          now,
        });
      }
    } else {
      task = markTaskReviewRecoveryPending({
        taskId: task.taskId,
        reason: inspected.state === "failed" ? inspected.reason : "reviewer child is missing",
        now,
      });
    }
    detail = parseTaskReviewDetail(task);
  } else if (detail.state === "review_pending") {
    task = markTaskReviewRecoveryPending({
      taskId: task.taskId,
      reason: "reviewer child binding is missing",
      now,
    });
    detail = parseTaskReviewDetail(task);
  }

  if (!detail) {
    throw new Error("Managed review detail disappeared during recovery.");
  }
  let ownsClaim = false;
  if (detail.state === "recovery_pending") {
    if (detail.recoveryAttempt >= detail.maxRecoveryAttempts) {
      return {
        state: "failed",
        task: failTaskReviewRecovery({ task, detail, reason: "retry limit reached", now }),
      };
    }
    task = beginTaskReviewRecovery({ taskId: task.taskId, now });
    detail = parseTaskReviewDetail(task)!;
    ownsClaim = true;
  }
  if (detail.state === "recovering") {
    task = markTaskReviewReverifyPending({ taskId: task.taskId, now });
    detail = parseTaskReviewDetail(task)!;
    ownsClaim = true;
  }
  if (detail.state !== "reverify_pending") {
    return { state: "adopted", task };
  }
  if (
    detail.launch.phase !== "claimed" ||
    (!ownsClaim && now - detail.launch.claimedAt < detail.staleAfterMs)
  ) {
    return { state: "adopted", task };
  }

  const expectedLaunch = detail.launch;
  const launchClaim = captureLaunchClaim(task, detail);
  const launched = await params.runtime.launch({
    task,
    detail,
    recoveryAttempt: detail.launch.attempt,
  });
  if (!launched.ok) {
    task = markClaimFailureIfCurrent({
      taskId: task.taskId,
      expected: expectedLaunch,
      reason: `replacement launch failed: ${launched.reason}`,
      now,
    });
    const failedDetail = parseTaskReviewDetail(task)!;
    if (failedDetail.launch.phase === "bound") {
      task = resumeTaskReviewVerification({ taskId: task.taskId, now });
      return { state: "recovered", task };
    }
    if (failedDetail.state !== "recovery_pending") {
      return { state: "adopted", task };
    }
    if (failedDetail.recoveryAttempt >= failedDetail.maxRecoveryAttempts) {
      return {
        state: "failed",
        task: failTaskReviewRecovery({ task, detail: failedDetail, reason: launched.reason, now }),
      };
    }
    return { state: "failed", task };
  }
  const binding = await settleTaskReviewLaunch({
    taskId: task.taskId,
    launched,
    claim: launchClaim,
    runtime: params.runtime,
    now,
  });
  task = binding.task;
  if (!binding.owned) {
    return { state: "adopted", task };
  }
  task = resumeTaskReviewVerification({ taskId: task.taskId, now });
  return { state: "recovered", task };
}

export function reconcileStaleTaskReviews(params?: { tasks?: TaskRecord[]; now?: number }): {
  escalated: number;
  taskIds: string[];
} {
  const now = params?.now ?? Date.now();
  const tasks = params?.tasks ?? [];
  const candidates = listStaleTaskReviewIds({ tasks, now });
  const taskIds: string[] = [];
  for (const taskId of candidates) {
    const current = getTaskById(taskId);
    if (!current) {
      continue;
    }
    const reason =
      current.status === "queued" && !current.childSessionKey
        ? "reviewer child remained unclaimed"
        : "reviewer child stopped reporting progress";
    markTaskReviewRecoveryPending({ taskId, reason, now });
    taskIds.push(taskId);
  }
  return { escalated: taskIds.length, taskIds };
}

export function listStaleTaskReviewIds(params: { tasks: TaskRecord[]; now: number }): string[] {
  const taskIds: string[] = [];
  for (const snapshot of params.tasks) {
    const current = getTaskById(snapshot.taskId) ?? snapshot;
    const detail = parseTaskReviewDetail(current);
    if (
      !detail ||
      detail.state !== "review_pending" ||
      detail.launch.phase === "claimed" ||
      (current.status !== "queued" && current.status !== "running")
    ) {
      continue;
    }
    const referenceAt = current.lastEventAt ?? current.startedAt ?? current.createdAt;
    if (params.now - referenceAt < detail.staleAfterMs) {
      continue;
    }
    taskIds.push(current.taskId);
  }
  return taskIds;
}

export function resolveWrapReviewFlow(params: {
  ownerKey: string;
  flowId?: string;
}): TaskFlowRecord | undefined {
  if (params.flowId) {
    return getTaskFlowByIdForOwner({
      flowId: params.flowId,
      callerOwnerKey: params.ownerKey,
    });
  }
  const ownerKey = params.ownerKey;
  // Avoid selecting a terminal or mirrored flow merely because it was updated most recently.
  return listTaskFlowsForOwner({ callerOwnerKey: ownerKey })
    .filter(
      (flow) =>
        flow.syncMode === "managed" &&
        (flow.status === "queued" ||
          flow.status === "running" ||
          flow.status === "waiting" ||
          flow.status === "blocked"),
    )
    .toSorted((left, right) => right.updatedAt - left.updatedAt)[0];
}

export function findReviewSourceTask(flowId: string): TaskRecord | undefined {
  return listTasksForFlowId(flowId)
    .filter((task) => task.taskKind !== TASK_REVIEW_KIND)
    .toSorted((left, right) => right.createdAt - left.createdAt)[0];
}
