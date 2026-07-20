// Owns deterministic managed-flow review dispatch, outcomes, and recovery state.
import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  completeTaskRunByRunId,
  recordTaskRunProgressByRunId,
  runTaskInFlowForOwner,
} from "./task-executor.js";
import { getTaskFlowByIdForOwner, listTaskFlowsForOwner } from "./task-flow-owner-access.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { getTaskById, listTasksForFlowId } from "./task-registry.js";
import type { JsonValue, TaskRecord } from "./task-registry.types.js";

export const TASK_REVIEW_KIND = "managed-review";
export const DEFAULT_TASK_REVIEW_STALE_MS = 30 * 60_000;

export type TaskReviewState =
  | "review_pending"
  | "changes_requested"
  | "merge_ready"
  | "awaiting_owner"
  | "recovery_pending"
  | "recovering"
  | "reverify_pending";

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

const REVIEW_STATES = new Set<TaskReviewState>([
  "review_pending",
  "changes_requested",
  "merge_ready",
  "awaiting_owner",
  "recovery_pending",
  "recovering",
  "reverify_pending",
]);

const ALLOWED_TRANSITIONS: Record<TaskReviewState, ReadonlySet<TaskReviewState>> = {
  review_pending: new Set([
    "changes_requested",
    "merge_ready",
    "awaiting_owner",
    "recovery_pending",
  ]),
  changes_requested: new Set(["reverify_pending"]),
  merge_ready: new Set(),
  awaiting_owner: new Set(["reverify_pending"]),
  recovery_pending: new Set(["recovering"]),
  recovering: new Set(["reverify_pending"]),
  reverify_pending: new Set(["review_pending"]),
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
  return structuredClone(detail) as unknown as TaskReviewDetail;
}

function findReviewTask(flowId: string, dispatchKey: string): TaskRecord | undefined {
  return listTasksForFlowId(flowId).find(
    (task) => parseTaskReviewDetail(task)?.dispatchKey === dispatchKey,
  );
}

export function dispatchTaskReview(params: {
  flowId: string;
  callerOwnerKey: string;
  request: TaskReviewRequest;
  continuity: TaskReviewContinuity;
  parentTaskId?: string;
  now?: number;
}): DispatchTaskReviewResult {
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
    return detail
      ? { ok: true, created: false, task: existing, detail }
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
    history: [{ state: "review_pending", at: now, summary: "Review dispatched." }],
  };
  const result = runTaskInFlowForOwner({
    flowId: flow.flowId,
    callerOwnerKey: params.callerOwnerKey,
    runtime: "subagent",
    taskKind: TASK_REVIEW_KIND,
    sourceId: `task-review:${dispatchKey}`,
    runId: `task-review:${dispatchKey}`,
    parentTaskId: params.parentTaskId,
    agentId: params.request.reviewerAgentId,
    label: `Review ${params.request.proofBundle.commit.slice(0, 12)}`,
    task: buildReviewPrompt(detail),
    status: "queued",
    notifyPolicy: "state_changes",
    deliveryStatus: "pending",
    progressSummary: `Review pending for ${params.request.proofBundle.commit.slice(0, 12)}.`,
    detail: detailToJson(detail),
  });
  if (!result.created || !result.task) {
    return { ok: false, reason: result.reason ?? "Review task persistence failed." };
  }
  return { ok: true, created: true, task: result.task, detail };
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
  recordTaskRunProgressByRunId({
    runId: params.task.runId,
    runtime: params.task.runtime,
    lastEventAt: params.now,
    progressSummary: params.summary,
    eventSummary: params.summary,
    detail: detailToJson(nextDetail),
  });
  const updated = getTaskById(params.task.taskId);
  if (!updated) {
    throw new Error("Task review transition did not persist.");
  }
  return updated;
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
  completeTaskRunByRunId({
    runId: task.runId,
    runtime: task.runtime,
    endedAt: now,
    lastEventAt: now,
    terminalSummary: summary,
    terminalOutcome: params.decision.outcome === "merge_ready" ? "succeeded" : "blocked",
    detail: detailToJson(nextDetail),
  });
  const updated = getTaskById(task.taskId);
  if (!updated) {
    throw new Error("Task review decision did not persist.");
  }
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
  if (!task) {
    throw new Error("Managed review task not found.");
  }
  return transitionTaskReview({
    task,
    state: "recovering",
    now: params.now ?? Date.now(),
    summary: "Review recovery claimed.",
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
