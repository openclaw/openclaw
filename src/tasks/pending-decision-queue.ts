import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ActionClassification } from "./decision-policy.js";

export const PENDING_DECISIONS_FILE = "pending-decisions.json";

export type PendingDecisionRecord = {
  id: string;
  title: string;
  action: string;
  reason: string;
  risk: "hard-boundary" | "high" | "medium" | "low";
  source: string;
  task_id: string;
  workspace: string;
  approval_target: string;
  rollback: string;
  safe_alternative: string;
  created_at: string;
  updated_at: string;
};

export type AllowedActionRecord = {
  id: string;
  title: string;
  action: string;
  reason: string;
  risk: "low" | "medium";
  source: string;
  workspace: string;
  rollback: string;
  created_at: string;
  updated_at: string;
};

export type PendingDecisionQueue = {
  updated_at: string;
  source: "node-pending-decision-queue";
  schema_version: 1;
  decisions: PendingDecisionRecord[];
  allowed_actions: AllowedActionRecord[];
};

export type PendingDecisionQueueLoadResult = {
  queue: PendingDecisionQueue;
  loadErrors: string[];
};

type UnknownRecord = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

function resolveWorkbenchHome(): string {
  return process.env.OPENCLAW_WORKBENCH_HOME || join(homedir(), ".openclaw-workbench");
}

function resolvePendingDecisionQueuePath(): string {
  return join(resolveWorkbenchHome(), "status", PENDING_DECISIONS_FILE);
}

function emptyQueue(updatedAt = nowIso()): PendingDecisionQueue {
  return {
    updated_at: updatedAt,
    source: "node-pending-decision-queue",
    schema_version: 1,
    decisions: [],
    allowed_actions: [],
  };
}

function readString(record: UnknownRecord, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function normalizeRisk(value: string): PendingDecisionRecord["risk"] {
  return value === "high" || value === "medium" || value === "low" ? value : "hard-boundary";
}

function normalizeDecisionRecord(
  record: UnknownRecord,
  fallbackUpdatedAt: string,
): PendingDecisionRecord | null {
  const id = readString(record, "id").trim();
  if (!id) {
    return null;
  }
  const action = readString(record, "action").trim() || "unknown";
  const reason = readString(record, "reason").trim() || "decision requires explicit approval";
  return {
    id,
    title: readString(record, "title").trim() || id,
    action,
    reason,
    risk: normalizeRisk(readString(record, "risk")),
    source: readString(record, "source").trim() || "node-pending-decision-queue",
    task_id: readString(record, "task_id").trim(),
    workspace: readString(record, "workspace").trim(),
    approval_target: readString(record, "approval_target").trim() || "operator",
    rollback:
      readString(record, "rollback").trim() ||
      "no side effect has been performed; keep the action queued until approved",
    safe_alternative:
      readString(record, "safe_alternative").trim() ||
      "produce a local review packet and wait for explicit approval",
    created_at: readString(record, "created_at").trim() || fallbackUpdatedAt,
    updated_at: readString(record, "updated_at").trim() || fallbackUpdatedAt,
  };
}

function normalizeAllowedActionRecord(
  record: UnknownRecord,
  fallbackUpdatedAt: string,
): AllowedActionRecord | null {
  const id = readString(record, "id").trim();
  if (!id) {
    return null;
  }
  const risk = readString(record, "risk");
  return {
    id,
    title: readString(record, "title").trim() || id,
    action: readString(record, "action").trim(),
    reason: readString(record, "reason").trim(),
    risk: risk === "medium" ? "medium" : "low",
    source: readString(record, "source").trim() || "node-pending-decision-queue",
    workspace: readString(record, "workspace").trim(),
    rollback: readString(record, "rollback").trim(),
    created_at: readString(record, "created_at").trim() || fallbackUpdatedAt,
    updated_at: readString(record, "updated_at").trim() || fallbackUpdatedAt,
  };
}

function parsePendingDecisionQueue(payload: unknown): PendingDecisionQueue {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return emptyQueue();
  }
  const record = payload as UnknownRecord;
  const updatedAt = readString(record, "updated_at").trim() || nowIso();
  const decisionsValue = record.decisions;
  const decisions = Array.isArray(decisionsValue)
    ? decisionsValue
        .filter(
          (decision): decision is UnknownRecord =>
            typeof decision === "object" && decision !== null && !Array.isArray(decision),
        )
        .map((decision) => normalizeDecisionRecord(decision, updatedAt))
        .filter((decision): decision is PendingDecisionRecord => decision !== null)
    : [];
  const allowedActionsValue = record.allowed_actions;
  const allowedActions = Array.isArray(allowedActionsValue)
    ? allowedActionsValue
        .filter(
          (allowed): allowed is UnknownRecord =>
            typeof allowed === "object" && allowed !== null && !Array.isArray(allowed),
        )
        .map((allowed) => normalizeAllowedActionRecord(allowed, updatedAt))
        .filter((allowed): allowed is AllowedActionRecord => allowed !== null)
    : [];
  return {
    updated_at: updatedAt,
    source: "node-pending-decision-queue",
    schema_version: 1,
    decisions,
    allowed_actions: allowedActions,
  };
}

export function projectPendingDecisionRecord(record: PendingDecisionRecord): PendingDecisionRecord {
  return {
    id: record.id,
    title: record.title,
    action: record.action,
    reason: record.reason,
    risk: record.risk,
    source: record.source,
    task_id: record.task_id,
    workspace: record.workspace,
    approval_target: record.approval_target,
    rollback: record.rollback,
    safe_alternative: record.safe_alternative,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

export function projectAllowedActionRecord(record: AllowedActionRecord): AllowedActionRecord {
  return {
    id: record.id,
    title: record.title,
    action: record.action,
    reason: record.reason,
    risk: record.risk,
    source: record.source,
    workspace: record.workspace,
    rollback: record.rollback,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

export function loadPendingDecisionQueue(): PendingDecisionQueueLoadResult {
  const path = resolvePendingDecisionQueuePath();
  if (!existsSync(path)) {
    return { queue: emptyQueue(), loadErrors: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return { queue: parsePendingDecisionQueue(parsed), loadErrors: [] };
  } catch (error) {
    return {
      queue: emptyQueue(),
      loadErrors: [
        `${PENDING_DECISIONS_FILE}: ${error instanceof Error ? error.message : "read failed"}`,
      ],
    };
  }
}

export function writePendingDecisionQueue(queue: PendingDecisionQueue): PendingDecisionQueue {
  const updated: PendingDecisionQueue = {
    updated_at: nowIso(),
    source: "node-pending-decision-queue",
    schema_version: 1,
    decisions: queue.decisions.map(projectPendingDecisionRecord),
    allowed_actions: queue.allowed_actions.map(projectAllowedActionRecord),
  };
  mkdirSync(join(resolveWorkbenchHome(), "status"), { recursive: true });
  writeFileSync(resolvePendingDecisionQueuePath(), `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
}

function assertPendingDecisionQueueWritable(loaded: PendingDecisionQueueLoadResult): void {
  if (loaded.loadErrors.length === 0) {
    return;
  }
  throw new Error(
    `Cannot write ${PENDING_DECISIONS_FILE} while the existing file has load errors: ${loaded.loadErrors.join("; ")}`,
  );
}

export function registerAllowedActionAudit(params: {
  classification: ActionClassification;
  title?: string;
  workspace?: string;
}): PendingDecisionQueue {
  const loaded = loadPendingDecisionQueue();
  assertPendingDecisionQueueWritable(loaded);
  const timestamp = nowIso();
  const record: AllowedActionRecord = {
    id: `allowed_${randomUUID()}`,
    title: params.title?.trim() || params.classification.action,
    action: params.classification.action,
    reason: params.classification.reason,
    risk: params.classification.risk === "medium" ? "medium" : "low",
    source: "node-pending-decision-queue",
    workspace: params.workspace?.trim() || process.cwd(),
    rollback: params.classification.rollback,
    created_at: timestamp,
    updated_at: timestamp,
  };
  return writePendingDecisionQueue({
    ...loaded.queue,
    allowed_actions: [...loaded.queue.allowed_actions, record],
  });
}

export function registerPendingDecision(params: {
  classification: ActionClassification;
  title?: string;
  taskId?: string;
  workspace?: string;
}): PendingDecisionQueue {
  const loaded = loadPendingDecisionQueue();
  assertPendingDecisionQueueWritable(loaded);
  const timestamp = nowIso();
  const record: PendingDecisionRecord = {
    id: `decision_${randomUUID()}`,
    title: params.title?.trim() || params.classification.action,
    action: params.classification.action,
    reason: params.classification.reason,
    risk: params.classification.risk,
    source: "node-pending-decision-queue",
    task_id: params.taskId?.trim() || "",
    workspace: params.workspace?.trim() || process.cwd(),
    approval_target: params.classification.approvalTarget,
    rollback: params.classification.rollback,
    safe_alternative: params.classification.safeAlternative,
    created_at: timestamp,
    updated_at: timestamp,
  };
  return writePendingDecisionQueue({
    ...loaded.queue,
    decisions: [...loaded.queue.decisions, record],
  });
}
