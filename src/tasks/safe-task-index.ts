import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SAFE_TASK_INDEX_FILE = "codex-task-index.json";

export const SAFE_TASK_STATUSES = [
  "queued",
  "running",
  "paused",
  "blocked",
  "needs_decision",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const SAFE_TASK_RISKS = ["low", "medium", "high", "hard-boundary"] as const;

export type SafeTaskStatus = (typeof SAFE_TASK_STATUSES)[number];
export type SafeTaskRisk = (typeof SAFE_TASK_RISKS)[number];

export type SafeTaskHandoff = {
  state: string;
};

export type SafeTaskRecord = {
  task_id: string;
  title: string;
  workspace: string;
  source: string;
  status: SafeTaskStatus;
  risk: SafeTaskRisk;
  owner: string;
  allowed_actions: string[];
  handoff: SafeTaskHandoff;
  created_at: string;
  updated_at: string;
  started_at?: string;
  ended_at?: string;
  blocked_reason?: string;
  completed_summary?: string;
  notes?: string[];
  metadata?: Record<string, unknown>;
};

export type SafeTaskIndex = {
  updated_at: string;
  source: "node-safe-task-index";
  schema_version: 1;
  tasks: SafeTaskRecord[];
};

export type SafeTaskPublicRecord = Omit<SafeTaskRecord, "notes" | "metadata">;

export type SafeTaskIndexLoadResult = {
  index: SafeTaskIndex;
  loadErrors: string[];
};

export type SafeTaskLifecycleAction = "start" | "block" | "complete";

type UnknownRecord = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

export function resolveWorkbenchHome(): string {
  return process.env.OPENCLAW_WORKBENCH_HOME || join(homedir(), ".openclaw-workbench");
}

export function resolveSafeTaskIndexPath(): string {
  return join(resolveWorkbenchHome(), "status", SAFE_TASK_INDEX_FILE);
}

function emptyIndex(updatedAt = nowIso()): SafeTaskIndex {
  return {
    updated_at: updatedAt,
    source: "node-safe-task-index",
    schema_version: 1,
    tasks: [],
  };
}

function readString(record: UnknownRecord, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readStringArray(record: UnknownRecord, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readUnknownRecord(record: UnknownRecord, key: string): UnknownRecord | undefined {
  const value = record[key];
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as UnknownRecord;
  }
  return undefined;
}

function normalizeStatus(value: string): SafeTaskStatus {
  return SAFE_TASK_STATUSES.includes(value as SafeTaskStatus)
    ? (value as SafeTaskStatus)
    : "queued";
}

function normalizeRisk(value: string): SafeTaskRisk {
  return SAFE_TASK_RISKS.includes(value as SafeTaskRisk) ? (value as SafeTaskRisk) : "low";
}

function normalizeTaskRecord(
  record: UnknownRecord,
  fallbackUpdatedAt: string,
): SafeTaskRecord | null {
  const taskId = readString(record, "task_id").trim();
  if (!taskId) {
    return null;
  }
  const handoff = readUnknownRecord(record, "handoff");
  const normalized: SafeTaskRecord = {
    task_id: taskId,
    title: readString(record, "title").trim() || taskId,
    workspace: readString(record, "workspace").trim(),
    source: readString(record, "source").trim() || "node-safe-task-index",
    status: normalizeStatus(readString(record, "status")),
    risk: normalizeRisk(readString(record, "risk")),
    owner: readString(record, "owner").trim() || "openclaw",
    allowed_actions: readStringArray(record, "allowed_actions"),
    handoff: {
      state: handoff ? readString(handoff, "state").trim() || "not_handed_off" : "not_handed_off",
    },
    created_at: readString(record, "created_at").trim() || fallbackUpdatedAt,
    updated_at: readString(record, "updated_at").trim() || fallbackUpdatedAt,
  };
  const startedAt = readString(record, "started_at").trim();
  const endedAt = readString(record, "ended_at").trim();
  const blockedReason = readString(record, "blocked_reason").trim();
  const completedSummary = readString(record, "completed_summary").trim();
  const notes = readStringArray(record, "notes");
  const metadata = readUnknownRecord(record, "metadata");
  if (startedAt) {
    normalized.started_at = startedAt;
  }
  if (endedAt) {
    normalized.ended_at = endedAt;
  }
  if (blockedReason) {
    normalized.blocked_reason = blockedReason;
  }
  if (completedSummary) {
    normalized.completed_summary = completedSummary;
  }
  if (notes.length > 0) {
    normalized.notes = notes;
  }
  if (metadata) {
    normalized.metadata = { ...metadata };
  }
  return normalized;
}

function parseSafeTaskIndex(payload: unknown): SafeTaskIndex {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return emptyIndex();
  }
  const record = payload as UnknownRecord;
  const updatedAt = readString(record, "updated_at").trim() || nowIso();
  const tasksValue = record.tasks;
  const tasks = Array.isArray(tasksValue)
    ? tasksValue
        .filter(
          (task): task is UnknownRecord =>
            typeof task === "object" && task !== null && !Array.isArray(task),
        )
        .map((task) => normalizeTaskRecord(task, updatedAt))
        .filter((task): task is SafeTaskRecord => task !== null)
    : [];
  return {
    updated_at: updatedAt,
    source: "node-safe-task-index",
    schema_version: 1,
    tasks,
  };
}

export function loadSafeTaskIndex(): SafeTaskIndexLoadResult {
  const path = resolveSafeTaskIndexPath();
  if (!existsSync(path)) {
    return { index: emptyIndex(), loadErrors: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return { index: parseSafeTaskIndex(parsed), loadErrors: [] };
  } catch (error) {
    return {
      index: emptyIndex(),
      loadErrors: [
        `${SAFE_TASK_INDEX_FILE}: ${error instanceof Error ? error.message : "read failed"}`,
      ],
    };
  }
}

export function writeSafeTaskIndex(index: SafeTaskIndex): SafeTaskIndex {
  const updated: SafeTaskIndex = {
    ...index,
    source: "node-safe-task-index",
    schema_version: 1,
    updated_at: nowIso(),
    tasks: index.tasks.map((task) => ({ ...task })),
  };
  const path = resolveSafeTaskIndexPath();
  mkdirSync(join(resolveWorkbenchHome(), "status"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
}

function assertSafeTaskIndexWritable(loaded: SafeTaskIndexLoadResult): void {
  if (loaded.loadErrors.length === 0) {
    return;
  }
  throw new Error(
    `Cannot write ${SAFE_TASK_INDEX_FILE} while the existing file has load errors: ${loaded.loadErrors.join("; ")}`,
  );
}

export function findSafeTask(index: SafeTaskIndex, lookup: string): SafeTaskRecord | undefined {
  const needle = lookup.trim();
  return index.tasks.find((task) => task.task_id === needle);
}

export function projectSafeTaskRecord(record: SafeTaskRecord): SafeTaskPublicRecord {
  const projected: SafeTaskPublicRecord = {
    task_id: record.task_id,
    title: record.title,
    workspace: record.workspace,
    source: record.source,
    status: record.status,
    risk: record.risk,
    owner: record.owner,
    allowed_actions: [...record.allowed_actions],
    handoff: { state: record.handoff.state },
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
  if (record.started_at) {
    projected.started_at = record.started_at;
  }
  if (record.ended_at) {
    projected.ended_at = record.ended_at;
  }
  if (record.blocked_reason) {
    projected.blocked_reason = record.blocked_reason;
  }
  if (record.completed_summary) {
    projected.completed_summary = record.completed_summary;
  }
  return projected;
}

export function projectSafeTaskIndex(index: SafeTaskIndex): Omit<SafeTaskIndex, "tasks"> & {
  tasks: SafeTaskPublicRecord[];
} {
  return {
    updated_at: index.updated_at,
    source: index.source,
    schema_version: index.schema_version,
    tasks: index.tasks.map(projectSafeTaskRecord),
  };
}

export function upsertSafeTask(params: {
  taskId: string;
  title?: string;
  workspace?: string;
  source?: string;
  owner?: string;
  risk?: SafeTaskRisk;
  allowedActions?: string[];
  metadata?: Record<string, unknown>;
}): SafeTaskIndex {
  const loaded = loadSafeTaskIndex();
  assertSafeTaskIndexWritable(loaded);
  const taskId = params.taskId.trim();
  if (!taskId) {
    throw new Error("taskId is required");
  }
  const timestamp = nowIso();
  const existing = findSafeTask(loaded.index, taskId);
  if (existing?.status === "needs_decision" || existing?.risk === "hard-boundary") {
    throw new Error(`Task requires a decision before restart: ${taskId}`);
  }
  const nextTask: SafeTaskRecord = {
    ...(existing ?? {
      task_id: taskId,
      title: params.title?.trim() || taskId,
      workspace: params.workspace?.trim() || process.cwd(),
      source: params.source?.trim() || "node-safe-task-index",
      status: "queued",
      risk: params.risk ?? "low",
      owner: params.owner?.trim() || "openclaw",
      allowed_actions: params.allowedActions ?? ["read_status", "continue_registered_local_task"],
      handoff: { state: "not_handed_off" },
      created_at: timestamp,
      updated_at: timestamp,
    }),
    title: params.title?.trim() || existing?.title || taskId,
    workspace: params.workspace?.trim() || existing?.workspace || process.cwd(),
    source: params.source?.trim() || existing?.source || "node-safe-task-index",
    risk: params.risk ?? existing?.risk ?? "low",
    owner: params.owner?.trim() || existing?.owner || "openclaw",
    allowed_actions:
      params.allowedActions && params.allowedActions.length > 0
        ? params.allowedActions
        : (existing?.allowed_actions ?? ["read_status", "continue_registered_local_task"]),
    status: "running",
    started_at: existing?.started_at ?? timestamp,
    updated_at: timestamp,
  };
  if (params.metadata) {
    nextTask.metadata = { ...(existing?.metadata ?? {}), ...params.metadata };
  }
  delete nextTask.ended_at;
  delete nextTask.blocked_reason;
  delete nextTask.completed_summary;
  const tasks = existing
    ? loaded.index.tasks.map((task) => (task.task_id === taskId ? nextTask : task))
    : [...loaded.index.tasks, nextTask];
  return writeSafeTaskIndex({ ...loaded.index, tasks });
}

export function blockSafeTask(params: {
  taskId: string;
  reason: string;
  needsDecision?: boolean;
  risk?: SafeTaskRisk;
}): SafeTaskIndex {
  const loaded = loadSafeTaskIndex();
  assertSafeTaskIndexWritable(loaded);
  const task = findSafeTask(loaded.index, params.taskId);
  if (!task) {
    throw new Error(`Task not found: ${params.taskId}`);
  }
  const timestamp = nowIso();
  const updated: SafeTaskRecord = {
    ...task,
    status: params.needsDecision ? "needs_decision" : "blocked",
    risk: params.needsDecision ? "hard-boundary" : (params.risk ?? task.risk),
    allowed_actions: params.needsDecision ? ["read_status"] : task.allowed_actions,
    blocked_reason: params.reason.trim(),
    updated_at: timestamp,
  };
  delete updated.ended_at;
  delete updated.completed_summary;
  const tasks = loaded.index.tasks.map((entry) =>
    entry.task_id === updated.task_id ? updated : entry,
  );
  return writeSafeTaskIndex({ ...loaded.index, tasks });
}

export function completeSafeTask(params: { taskId: string; summary?: string }): SafeTaskIndex {
  const loaded = loadSafeTaskIndex();
  assertSafeTaskIndexWritable(loaded);
  const task = findSafeTask(loaded.index, params.taskId);
  if (!task) {
    throw new Error(`Task not found: ${params.taskId}`);
  }
  if (task.status === "needs_decision" || task.risk === "hard-boundary") {
    throw new Error(`Task requires a decision before completion: ${params.taskId}`);
  }
  const timestamp = nowIso();
  const updated: SafeTaskRecord = {
    ...task,
    status: "succeeded",
    ended_at: timestamp,
    updated_at: timestamp,
  };
  const summary = params.summary?.trim();
  if (summary) {
    updated.completed_summary = summary;
  }
  const tasks = loaded.index.tasks.map((entry) =>
    entry.task_id === updated.task_id ? updated : entry,
  );
  return writeSafeTaskIndex({ ...loaded.index, tasks });
}
