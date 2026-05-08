import {
  loadPendingDecisionQueue,
  projectPendingDecisionRecord,
} from "../../tasks/pending-decision-queue.js";
import {
  loadSafeTaskIndex,
  projectSafeTaskRecord,
  type SafeTaskRecord,
} from "../../tasks/safe-task-index.js";
import {
  validateAssistantContinueCandidatesParams,
  validateAssistantDecisionsListParams,
  validateAssistantStatusParams,
  type AssistantContinueCandidate,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const SAFE_SOURCES = [
  "explicit safe task index",
  "pending decision metadata",
  "run harness state metadata",
];

const EXCLUDED_SOURCES = [
  "Codex App sqlite",
  "Codex App logs",
  "auth material",
  "caches",
  "raw transcripts",
];

const ACTIVE_TASK_STATUSES = new Set(["running", "paused", "blocked", "needs_decision"]);
const CONTINUABLE_TASK_STATUSES = new Set(["running", "paused", "blocked"]);

type SafeJsonObject = Record<string, unknown>;

function generatedAt(): string {
  return new Date().toISOString();
}

function readHandoffState(record: SafeTaskRecord): string {
  return record.handoff.state;
}

function isContinueCandidate(record: SafeTaskRecord): boolean {
  if (!CONTINUABLE_TASK_STATUSES.has(record.status)) {
    return false;
  }
  const risk = record.risk;
  if (risk === "high" || risk === "hard-boundary") {
    return false;
  }
  const allowedActions = record.allowed_actions;
  return (
    allowedActions.includes("continue_registered_local_task") ||
    allowedActions.includes("continue_task") ||
    readHandoffState(record) === "approved"
  );
}

function toAssistantTask(record: SafeTaskRecord): SafeJsonObject {
  return projectSafeTaskRecord(record);
}

function toDecisionFromTask(record: SafeTaskRecord): SafeJsonObject {
  return {
    id: `safe-task:${record.task_id}`,
    title: record.title,
    action: "continue_registered_local_task",
    reason: record.blocked_reason || "Task requires an explicit decision before continuation",
    risk: record.risk,
    source: record.source,
    task_id: record.task_id,
    workspace: record.workspace,
    approval_target: "operator",
    safe_alternative: "produce a local review packet and wait for explicit approval",
    rollback: "no action has been taken; keep task blocked until approved",
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function toContinueCandidate(record: SafeTaskRecord): AssistantContinueCandidate {
  return {
    taskId: record.task_id,
    title: record.title,
    workspace: record.workspace,
    source: record.source,
    status: record.status,
    risk: record.risk,
    owner: record.owner,
    allowedActions: record.allowed_actions,
    handoffState: readHandoffState(record),
    updatedAt: record.updated_at,
    reason: "local reversible continuation is explicitly allowed by safe task metadata",
    record: toAssistantTask(record),
  };
}

function readAssistantArtifacts() {
  const taskIndex = loadSafeTaskIndex();
  const decisionsPayload = loadPendingDecisionQueue();
  const tasks = taskIndex.index.tasks;
  const metadataDecisions = tasks
    .filter((task) => task.status === "needs_decision" || task.risk === "hard-boundary")
    .map(toDecisionFromTask);
  const decisions = [
    ...decisionsPayload.queue.decisions.map(projectPendingDecisionRecord),
    ...metadataDecisions,
  ];
  const continueCandidates = tasks.filter(isContinueCandidate).map(toContinueCandidate);
  return {
    generatedAt: generatedAt(),
    taskIndexUpdatedAt: taskIndex.index.updated_at,
    tasks,
    decisions,
    continueCandidates,
    loadErrors: [...taskIndex.loadErrors, ...decisionsPayload.loadErrors],
  };
}

export const assistantHandlers: GatewayRequestHandlers = {
  "assistant.status": async ({ params, respond }) => {
    if (!assertValidParams(params, validateAssistantStatusParams, "assistant.status", respond)) {
      return;
    }
    const artifacts = readAssistantArtifacts();
    respond(
      true,
      {
        generatedAt: artifacts.generatedAt,
        ...(artifacts.taskIndexUpdatedAt
          ? { taskIndexUpdatedAt: artifacts.taskIndexUpdatedAt }
          : {}),
        taskCount: artifacts.tasks.length,
        activeTaskCount: artifacts.tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status))
          .length,
        pendingDecisionCount: artifacts.decisions.length,
        continueCandidateCount: artifacts.continueCandidates.length,
        tasks: artifacts.tasks.map(toAssistantTask),
        decisions: artifacts.decisions,
        continueCandidates: artifacts.continueCandidates,
        safeSources: SAFE_SOURCES,
        excludedSources: EXCLUDED_SOURCES,
        loadErrors: artifacts.loadErrors,
      },
      undefined,
    );
  },
  "assistant.decisions.list": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateAssistantDecisionsListParams,
        "assistant.decisions.list",
        respond,
      )
    ) {
      return;
    }
    const artifacts = readAssistantArtifacts();
    respond(
      true,
      {
        generatedAt: artifacts.generatedAt,
        count: artifacts.decisions.length,
        decisions: artifacts.decisions,
        safeSources: SAFE_SOURCES,
        excludedSources: EXCLUDED_SOURCES,
        loadErrors: artifacts.loadErrors,
      },
      undefined,
    );
  },
  "assistant.continueCandidates": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateAssistantContinueCandidatesParams,
        "assistant.continueCandidates",
        respond,
      )
    ) {
      return;
    }
    const artifacts = readAssistantArtifacts();
    respond(
      true,
      {
        generatedAt: artifacts.generatedAt,
        count: artifacts.continueCandidates.length,
        candidates: artifacts.continueCandidates,
        policy: {
          allowed: "local, reversible, auditable, explicit-scope continuation",
          hardBoundary: "needs_decision",
        },
        safeSources: SAFE_SOURCES,
        excludedSources: EXCLUDED_SOURCES,
        loadErrors: artifacts.loadErrors,
      },
      undefined,
    );
  },
};
