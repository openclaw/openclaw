/**
 * Workspace management (replaces Paperclip company-level isolation).
 */
import { randomUUID } from "node:crypto";
import { getStateDb } from "../infra/state-db/connection.js";
import type { Workspace, WorkspaceAgent, WorkspaceAgentStatus, WorkspaceStatus } from "./types.js";

// ── Error ────────────────────────────────────────────────────────────────────

export class WorkspaceStoreError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "WorkspaceStoreError";
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type WorkspaceRow = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  task_prefix: string;
  task_counter: number;
  budget_monthly_microcents: number | null;
  spent_monthly_microcents: number;
  brand_color: string | null;
  created_at: number;
  updated_at: number;
};

type WorkspaceAgentRow = {
  workspace_id: string;
  agent_id: string;
  role: string | null;
  status: string;
  capabilities_json: string | null;
  joined_at: number;
};

function rowToWorkspace(r: WorkspaceRow): Workspace {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    status: r.status as WorkspaceStatus,
    taskPrefix: r.task_prefix,
    taskCounter: r.task_counter,
    budgetMonthlyMicrocents: r.budget_monthly_microcents,
    spentMonthlyMicrocents: r.spent_monthly_microcents,
    brandColor: r.brand_color ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToWorkspaceAgent(r: WorkspaceAgentRow): WorkspaceAgent {
  let capabilities: string[] = [];
  if (r.capabilities_json) {
    try {
      const parsed = JSON.parse(r.capabilities_json);
      if (Array.isArray(parsed)) {
        capabilities = parsed;
      }
    } catch {
      // ignore malformed
    }
  }
  return {
    workspaceId: r.workspace_id,
    agentId: r.agent_id,
    role: r.role ?? null,
    status: (r.status ?? "active") as WorkspaceAgentStatus,
    capabilities,
    joinedAt: r.joined_at,
  };
}

const WS_COLS =
  "id, name, description, status, task_prefix, task_counter, budget_monthly_microcents, spent_monthly_microcents, brand_color, created_at, updated_at";
const WS_AGENT_COLS = "workspace_id, agent_id, role, status, capabilities_json, joined_at";

// ── Workspaces CRUD ──────────────────────────────────────────────────────────

export function listWorkspaces(): Workspace[] {
  const db = getStateDb();
  const rows = db
    .prepare(`SELECT ${WS_COLS} FROM op1_workspaces ORDER BY created_at DESC`)
    .all() as WorkspaceRow[];
  return rows.map(rowToWorkspace);
}

export function getWorkspace(id: string): Workspace | undefined {
  const db = getStateDb();
  const row = db.prepare(`SELECT ${WS_COLS} FROM op1_workspaces WHERE id = ?`).get(id) as
    | WorkspaceRow
    | undefined;
  if (!row) {
    return undefined;
  }
  return rowToWorkspace(row);
}

export function createWorkspace(params: {
  name: string;
  description?: string;
  taskPrefix?: string;
  brandColor?: string;
}): Workspace {
  const db = getStateDb();
  const id = randomUUID();
  const taskPrefix = params.taskPrefix ?? "OP1";

  db.prepare(
    `INSERT INTO op1_workspaces (id, name, description, task_prefix, brand_color, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())`,
  ).run(id, params.name, params.description ?? null, taskPrefix, params.brandColor ?? null);

  return getWorkspace(id)!;
}

export function updateWorkspace(
  id: string,
  patch: { name?: string; description?: string; brandColor?: string; status?: WorkspaceStatus },
): Workspace {
  const db = getStateDb();
  const sets: string[] = [];
  const params: (string | null)[] = [];

  if (patch.name !== undefined) {
    sets.push("name = ?");
    params.push(patch.name);
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    params.push(patch.description);
  }
  if (patch.brandColor !== undefined) {
    sets.push("brand_color = ?");
    params.push(patch.brandColor);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }

  if (sets.length === 0) {
    return getWorkspace(id)!;
  }

  sets.push("updated_at = unixepoch()");
  params.push(id);
  db.prepare(`UPDATE op1_workspaces SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  return getWorkspace(id)!;
}

export function archiveWorkspace(id: string): Workspace {
  return updateWorkspace(id, { status: "archived" });
}

// ── Workspace Agents CRUD ────────────────────────────────────────────────────

export function listWorkspaceAgents(workspaceId: string): WorkspaceAgent[] {
  const db = getStateDb();
  const rows = db
    .prepare(
      `SELECT ${WS_AGENT_COLS} FROM op1_workspace_agents WHERE workspace_id = ? ORDER BY joined_at DESC`,
    )
    .all(workspaceId) as WorkspaceAgentRow[];
  return rows.map(rowToWorkspaceAgent);
}

export function assignAgentToWorkspace(workspaceId: string, agentId: string, role?: string): void {
  const db = getStateDb();

  // Implicit upsert so we don't crash on duplicate assignments
  db.prepare(
    `INSERT INTO op1_workspace_agents (workspace_id, agent_id, role, joined_at)
     VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(workspace_id, agent_id) DO UPDATE SET role = excluded.role`,
  ).run(workspaceId, agentId, role ?? null);
}

export function removeAgentFromWorkspace(workspaceId: string, agentId: string): void {
  const db = getStateDb();
  db.prepare(`DELETE FROM op1_workspace_agents WHERE workspace_id = ? AND agent_id = ?`).run(
    workspaceId,
    agentId,
  );
}

export function updateWorkspaceAgentStatus(
  workspaceId: string,
  agentId: string,
  status: WorkspaceAgentStatus,
  capabilities?: string[],
): void {
  const db = getStateDb();
  const sets: string[] = ["status = ?"];
  const params: (string | null)[] = [status];
  if (capabilities !== undefined) {
    sets.push("capabilities_json = ?");
    params.push(JSON.stringify(capabilities));
  }
  params.push(workspaceId, agentId);
  db.prepare(
    `UPDATE op1_workspace_agents SET ${sets.join(", ")} WHERE workspace_id = ? AND agent_id = ?`,
  ).run(...params);
}

/**
 * Resolves the appropriate workspace for an agent.
 * Useful for cost attribution and governance.
 */
export function resolveAgentWorkspace(agentId: string): Workspace | undefined {
  const db = getStateDb();
  // Find the workspace this agent is explicitly assigned to (oldest assignment first if multiple)
  const agentRow = db
    .prepare(
      `SELECT workspace_id FROM op1_workspace_agents WHERE agent_id = ? ORDER BY joined_at ASC LIMIT 1`,
    )
    .get(agentId) as { workspace_id: string } | undefined;

  if (agentRow) {
    return getWorkspace(agentRow.workspace_id);
  }

  // Fallback: return the first/default workspace
  const defaultRow = db
    .prepare(`SELECT * FROM op1_workspaces ORDER BY created_at ASC LIMIT 1`)
    .get() as WorkspaceRow | undefined;

  return defaultRow ? rowToWorkspace(defaultRow) : undefined;
}
