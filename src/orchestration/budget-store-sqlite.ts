import { randomUUID } from "node:crypto";
import { getStateDb } from "../infra/state-db/index.js";
import type {
  BudgetPolicy,
  BudgetIncident,
  BudgetScopeType,
  BudgetWindowKind,
  BudgetIncidentType,
} from "./types.js";

type BudgetPolicyRow = {
  id: string;
  workspace_id: string;
  scope_type: string;
  scope_id: string;
  amount_microcents: number;
  window_kind: string;
  warn_percent: number;
  hard_stop: number;
  created_at: number;
  updated_at: number;
};

type BudgetIncidentRow = {
  id: string;
  workspace_id: string;
  policy_id: string;
  type: string;
  agent_id: string | null;
  spent_microcents: number;
  limit_microcents: number;
  message: string | null;
  resolved_at: number | null;
  created_at: number;
};

function rowToBudgetPolicy(row: BudgetPolicyRow): BudgetPolicy {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    scopeType: row.scope_type as BudgetScopeType,
    scopeId: row.scope_id,
    amountMicrocents: row.amount_microcents,
    windowKind: row.window_kind as BudgetWindowKind,
    warnPercent: row.warn_percent,
    hardStop: row.hard_stop,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToBudgetIncident(row: BudgetIncidentRow): BudgetIncident {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    policyId: row.policy_id,
    type: row.type as BudgetIncidentType,
    agentId: row.agent_id,
    spentMicrocents: row.spent_microcents,
    limitMicrocents: row.limit_microcents,
    message: row.message,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

export function createBudgetPolicy(params: {
  workspaceId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  amountMicrocents: number;
  windowKind?: BudgetWindowKind;
  warnPercent?: number;
  hardStop?: number;
}): BudgetPolicy {
  const db = getStateDb();
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    INSERT INTO op1_budget_policies (
      id, workspace_id, scope_type, scope_id, amount_microcents,
      window_kind, warn_percent, hard_stop, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    params.workspaceId,
    params.scopeType,
    params.scopeId,
    params.amountMicrocents,
    params.windowKind || "calendar_month_utc",
    params.warnPercent ?? 80,
    params.hardStop ?? 0,
    now,
    now,
  );

  return getBudgetPolicy(id)!;
}

export function getBudgetPolicy(id: string): BudgetPolicy | null {
  const db = getStateDb();
  const stmt = db.prepare("SELECT * FROM op1_budget_policies WHERE id = ?");
  const row = stmt.get(id);
  return row ? rowToBudgetPolicy(row as unknown as BudgetPolicyRow) : null;
}

export function listBudgetPolicies(filters?: {
  workspaceId?: string;
  scopeType?: BudgetScopeType;
  scopeId?: string;
}): BudgetPolicy[] {
  const db = getStateDb();
  let query = "SELECT * FROM op1_budget_policies WHERE 1=1";
  const params: Array<string | number | bigint | null> = [];

  if (filters?.workspaceId) {
    query += " AND workspace_id = ?";
    params.push(filters.workspaceId);
  }
  if (filters?.scopeType) {
    query += " AND scope_type = ?";
    params.push(filters.scopeType);
  }
  if (filters?.scopeId) {
    query += " AND scope_id = ?";
    params.push(filters.scopeId);
  }

  const stmt = db.prepare(query);
  const rows = stmt.all(...params);
  return (rows as unknown as BudgetPolicyRow[]).map(rowToBudgetPolicy);
}

export function updateBudgetPolicy(
  id: string,
  updates: {
    amountMicrocents?: number;
    warnPercent?: number;
    hardStop?: number;
  },
): BudgetPolicy {
  const db = getStateDb();
  const existing = getBudgetPolicy(id);
  if (!existing) {
    throw new Error(`Budget policy not found: ${id}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const sets: string[] = ["updated_at = ?"];
  const params: Array<string | number | bigint | null> = [now];

  if (updates.amountMicrocents !== undefined) {
    sets.push("amount_microcents = ?");
    params.push(updates.amountMicrocents);
  }
  if (updates.warnPercent !== undefined) {
    sets.push("warn_percent = ?");
    params.push(updates.warnPercent);
  }
  if (updates.hardStop !== undefined) {
    sets.push("hard_stop = ?");
    params.push(updates.hardStop);
  }

  params.push(id);

  const stmt = db.prepare(`UPDATE op1_budget_policies SET ${sets.join(", ")} WHERE id = ?`);
  stmt.run(...params);

  return getBudgetPolicy(id)!;
}

export function deleteBudgetPolicy(id: string): void {
  const db = getStateDb();
  const stmt = db.prepare("DELETE FROM op1_budget_policies WHERE id = ?");
  stmt.run(id);
}

export function createBudgetIncident(params: {
  workspaceId: string;
  policyId: string;
  type: BudgetIncidentType;
  agentId?: string | null;
  spentMicrocents: number;
  limitMicrocents: number;
  message?: string | null;
}): BudgetIncident {
  const db = getStateDb();
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    INSERT INTO op1_budget_incidents (
      id, workspace_id, policy_id, type, agent_id, spent_microcents,
      limit_microcents, message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    params.workspaceId,
    params.policyId,
    params.type,
    params.agentId || null,
    params.spentMicrocents,
    params.limitMicrocents,
    params.message || null,
    now,
  );

  return getBudgetIncident(id)!;
}

export function getBudgetIncident(id: string): BudgetIncident | null {
  const db = getStateDb();
  const stmt = db.prepare("SELECT * FROM op1_budget_incidents WHERE id = ?");
  const row = stmt.get(id);
  return row ? rowToBudgetIncident(row as unknown as BudgetIncidentRow) : null;
}

export function resolveBudgetIncident(id: string): BudgetIncident {
  const db = getStateDb();
  const existing = getBudgetIncident(id);
  if (!existing) {
    throw new Error(`Budget incident not found: ${id}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    UPDATE op1_budget_incidents
    SET type = 'resolved', resolved_at = ?
    WHERE id = ? AND type != 'resolved'
  `);
  stmt.run(now, id);

  return getBudgetIncident(id)!;
}

export function listBudgetIncidents(filters?: {
  workspaceId?: string;
  policyId?: string;
  agentId?: string;
  type?: BudgetIncidentType;
}): BudgetIncident[] {
  const db = getStateDb();
  let query = "SELECT * FROM op1_budget_incidents WHERE 1=1";
  const params: Array<string | number | bigint | null> = [];

  if (filters?.workspaceId) {
    query += " AND workspace_id = ?";
    params.push(filters.workspaceId);
  }
  if (filters?.policyId) {
    query += " AND policy_id = ?";
    params.push(filters.policyId);
  }
  if (filters?.agentId) {
    query += " AND agent_id = ?";
    params.push(filters.agentId);
  }
  if (filters?.type) {
    query += " AND type = ?";
    params.push(filters.type);
  }

  query += " ORDER BY created_at DESC";

  const stmt = db.prepare(query);
  const rows = stmt.all(...params);
  return (rows as unknown as BudgetIncidentRow[]).map(rowToBudgetIncident);
}
