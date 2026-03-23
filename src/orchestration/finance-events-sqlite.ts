import { randomUUID } from "node:crypto";
import { getStateDb } from "../infra/state-db/index.js";
import type { FinanceEvent, FinanceEventKind, FinanceEventDirection } from "./types.js";

type FinanceEventRow = {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  task_id: string | null;
  project_id: string | null;
  goal_id: string | null;
  cost_event_id: string | null;
  billing_code: string | null;
  description: string | null;
  event_kind: string;
  direction: string;
  provider: string | null;
  model: string | null;
  amount_microcents: number;
  created_at: number;
};

function rowToFinanceEvent(row: FinanceEventRow): FinanceEvent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    taskId: row.task_id,
    projectId: row.project_id,
    goalId: row.goal_id,
    costEventId: row.cost_event_id,
    billingCode: row.billing_code,
    description: row.description,
    eventKind: row.event_kind as FinanceEventKind,
    direction: row.direction as FinanceEventDirection,
    provider: row.provider,
    model: row.model,
    amountMicrocents: row.amount_microcents,
    createdAt: row.created_at,
  };
}

export function recordFinanceEvent(params: {
  workspaceId: string;
  agentId?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  costEventId?: string | null;
  billingCode?: string | null;
  description?: string | null;
  eventKind: FinanceEventKind;
  direction?: FinanceEventDirection;
  provider?: string | null;
  model?: string | null;
  amountMicrocents: number;
}): FinanceEvent {
  const db = getStateDb();
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const direction = params.direction ?? "debit";

  const stmt = db.prepare(`
    INSERT INTO op1_finance_events (
      id, workspace_id, agent_id, task_id, project_id, goal_id,
      cost_event_id, billing_code, description, event_kind, direction,
      provider, model, amount_microcents, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    params.workspaceId,
    params.agentId ?? null,
    params.taskId ?? null,
    params.projectId ?? null,
    params.goalId ?? null,
    params.costEventId ?? null,
    params.billingCode ?? null,
    params.description ?? null,
    params.eventKind,
    direction,
    params.provider ?? null,
    params.model ?? null,
    params.amountMicrocents,
    now,
  );

  return {
    id,
    workspaceId: params.workspaceId,
    agentId: params.agentId ?? null,
    taskId: params.taskId ?? null,
    projectId: params.projectId ?? null,
    goalId: params.goalId ?? null,
    costEventId: params.costEventId ?? null,
    billingCode: params.billingCode ?? null,
    description: params.description ?? null,
    eventKind: params.eventKind,
    direction,
    provider: params.provider ?? null,
    model: params.model ?? null,
    amountMicrocents: params.amountMicrocents,
    createdAt: now,
  };
}

export function listFinanceEvents(filters?: {
  workspaceId?: string;
  agentId?: string;
  taskId?: string;
  projectId?: string;
  goalId?: string;
  eventKind?: FinanceEventKind;
  direction?: FinanceEventDirection;
  sinceUtc?: number;
  untilUtc?: number;
}): FinanceEvent[] {
  const db = getStateDb();
  let query = "SELECT * FROM op1_finance_events WHERE 1=1";
  const params: Array<string | number | bigint | null> = [];

  if (filters?.workspaceId) {
    query += " AND workspace_id = ?";
    params.push(filters.workspaceId);
  }
  if (filters?.agentId) {
    query += " AND agent_id = ?";
    params.push(filters.agentId);
  }
  if (filters?.taskId) {
    query += " AND task_id = ?";
    params.push(filters.taskId);
  }
  if (filters?.projectId) {
    query += " AND project_id = ?";
    params.push(filters.projectId);
  }
  if (filters?.goalId) {
    query += " AND goal_id = ?";
    params.push(filters.goalId);
  }
  if (filters?.eventKind) {
    query += " AND event_kind = ?";
    params.push(filters.eventKind);
  }
  if (filters?.direction) {
    query += " AND direction = ?";
    params.push(filters.direction);
  }
  if (filters?.sinceUtc) {
    query += " AND created_at >= ?";
    params.push(filters.sinceUtc);
  }
  if (filters?.untilUtc) {
    query += " AND created_at <= ?";
    params.push(filters.untilUtc);
  }

  query += " ORDER BY created_at DESC";

  const stmt = db.prepare(query);
  const rows = stmt.all(...params);
  return (rows as unknown as FinanceEventRow[]).map(rowToFinanceEvent);
}
