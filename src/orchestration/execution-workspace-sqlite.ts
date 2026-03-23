/**
 * Execution workspace store — isolated work environments for agent task runs.
 * Schema: op1_execution_workspaces + op1_workspace_operations (migration v27).
 */
import { randomUUID } from "node:crypto";
import { getStateDb } from "../infra/state-db/connection.js";
import type {
  ExecutionWorkspace,
  ExecutionWorkspaceStatus,
  WorkspaceOperation,
  WorkspaceOperationStatus,
} from "./types.js";

// ── Row types ────────────────────────────────────────────────────────────────

type ExecWsRow = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  name: string;
  mode: string;
  status: string;
  workspace_path: string | null;
  base_ref: string | null;
  branch_name: string | null;
  opened_at: number;
  closed_at: number | null;
  metadata_json: string | null;
};

type WsOpRow = {
  id: string;
  execution_workspace_id: string;
  operation_type: string;
  status: string;
  details_json: string | null;
  started_at: number;
  completed_at: number | null;
};

// ── Converters ───────────────────────────────────────────────────────────────

function rowToExecWs(r: ExecWsRow): ExecutionWorkspace {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id ?? null,
    taskId: r.task_id ?? null,
    agentId: r.agent_id ?? null,
    name: r.name,
    mode: r.mode,
    status: r.status as ExecutionWorkspaceStatus,
    workspacePath: r.workspace_path ?? null,
    baseRef: r.base_ref ?? null,
    branchName: r.branch_name ?? null,
    openedAt: r.opened_at,
    closedAt: r.closed_at ?? null,
    metadataJson: r.metadata_json ?? null,
  };
}

function rowToWsOp(r: WsOpRow): WorkspaceOperation {
  return {
    id: r.id,
    executionWorkspaceId: r.execution_workspace_id,
    operationType: r.operation_type,
    status: r.status as WorkspaceOperationStatus,
    detailsJson: r.details_json ?? null,
    startedAt: r.started_at,
    completedAt: r.completed_at ?? null,
  };
}

const EXEC_WS_COLS =
  "id, workspace_id, project_id, task_id, agent_id, name, mode, status, workspace_path, base_ref, branch_name, opened_at, closed_at, metadata_json";

const WS_OP_COLS =
  "id, execution_workspace_id, operation_type, status, details_json, started_at, completed_at";

// ── Execution Workspaces CRUD ────────────────────────────────────────────────

export function createExecutionWorkspace(params: {
  workspaceId?: string;
  projectId?: string;
  taskId?: string;
  agentId?: string;
  name: string;
  mode?: string;
  workspacePath?: string;
  baseRef?: string;
  branchName?: string;
  metadataJson?: string;
}): ExecutionWorkspace {
  const db = getStateDb();
  const id = randomUUID();
  const workspaceId = params.workspaceId ?? "default";
  const mode = params.mode ?? "local_fs";

  db.prepare(
    `INSERT INTO op1_execution_workspaces
       (id, workspace_id, project_id, task_id, agent_id, name, mode, workspace_path, base_ref, branch_name, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    params.projectId ?? null,
    params.taskId ?? null,
    params.agentId ?? null,
    params.name,
    mode,
    params.workspacePath ?? null,
    params.baseRef ?? null,
    params.branchName ?? null,
    params.metadataJson ?? null,
  );

  return getExecutionWorkspace(id)!;
}

export function getExecutionWorkspace(id: string): ExecutionWorkspace | undefined {
  const db = getStateDb();
  const row = db
    .prepare(`SELECT ${EXEC_WS_COLS} FROM op1_execution_workspaces WHERE id = ?`)
    .get(id) as ExecWsRow | undefined;
  return row ? rowToExecWs(row) : undefined;
}

export function listExecutionWorkspaces(filters?: {
  workspaceId?: string;
  projectId?: string;
  taskId?: string;
  agentId?: string;
  status?: ExecutionWorkspaceStatus;
}): ExecutionWorkspace[] {
  const db = getStateDb();
  const conditions: string[] = [];
  const args: (string | null)[] = [];

  if (filters?.workspaceId) {
    conditions.push("workspace_id = ?");
    args.push(filters.workspaceId);
  }
  if (filters?.projectId) {
    conditions.push("project_id = ?");
    args.push(filters.projectId);
  }
  if (filters?.taskId) {
    conditions.push("task_id = ?");
    args.push(filters.taskId);
  }
  if (filters?.agentId) {
    conditions.push("agent_id = ?");
    args.push(filters.agentId);
  }
  if (filters?.status) {
    conditions.push("status = ?");
    args.push(filters.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT ${EXEC_WS_COLS} FROM op1_execution_workspaces ${where} ORDER BY opened_at DESC`,
    )
    .all(...args) as ExecWsRow[];
  return rows.map(rowToExecWs);
}

export function updateExecutionWorkspace(
  id: string,
  patch: {
    name?: string;
    status?: ExecutionWorkspaceStatus;
    workspacePath?: string;
    baseRef?: string;
    branchName?: string;
    closedAt?: number | null;
    metadataJson?: string | null;
  },
): ExecutionWorkspace {
  const db = getStateDb();
  const sets: string[] = [];
  const args: (string | number | null)[] = [];

  if (patch.name !== undefined) {
    sets.push("name = ?");
    args.push(patch.name);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
  }
  if (patch.workspacePath !== undefined) {
    sets.push("workspace_path = ?");
    args.push(patch.workspacePath);
  }
  if (patch.baseRef !== undefined) {
    sets.push("base_ref = ?");
    args.push(patch.baseRef);
  }
  if (patch.branchName !== undefined) {
    sets.push("branch_name = ?");
    args.push(patch.branchName);
  }
  if (patch.closedAt !== undefined) {
    sets.push("closed_at = ?");
    args.push(patch.closedAt);
  }
  if (patch.metadataJson !== undefined) {
    sets.push("metadata_json = ?");
    args.push(patch.metadataJson);
  }

  if (sets.length > 0) {
    args.push(id);
    db.prepare(`UPDATE op1_execution_workspaces SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  }

  return getExecutionWorkspace(id)!;
}

export function archiveExecutionWorkspace(id: string): ExecutionWorkspace {
  return updateExecutionWorkspace(id, {
    status: "archived",
    closedAt: Math.floor(Date.now() / 1000),
  });
}

// ── Workspace Operations ─────────────────────────────────────────────────────

export function recordWorkspaceOperation(params: {
  executionWorkspaceId: string;
  operationType: string;
  status?: WorkspaceOperationStatus;
  detailsJson?: string;
}): WorkspaceOperation {
  const db = getStateDb();
  const id = randomUUID();
  const status = params.status ?? "pending";

  db.prepare(
    `INSERT INTO op1_workspace_operations
       (id, execution_workspace_id, operation_type, status, details_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, params.executionWorkspaceId, params.operationType, status, params.detailsJson ?? null);

  return listWorkspaceOperations(params.executionWorkspaceId).find((op) => op.id === id)!;
}

export function listWorkspaceOperations(executionWorkspaceId: string): WorkspaceOperation[] {
  const db = getStateDb();
  const rows = db
    .prepare(
      `SELECT ${WS_OP_COLS} FROM op1_workspace_operations WHERE execution_workspace_id = ? ORDER BY started_at ASC`,
    )
    .all(executionWorkspaceId) as WsOpRow[];
  return rows.map(rowToWsOp);
}
