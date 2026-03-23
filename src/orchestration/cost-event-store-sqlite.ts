import { randomUUID } from "node:crypto";
import { getStateDb } from "../infra/state-db/index.js";
import type { CostEvent } from "./types.js";

type CostEventRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  session_id: string | null;
  task_id: string | null;
  project_id: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_microcents: number;
  occurred_at: number;
};

function rowToCostEvent(row: CostEventRow): CostEvent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    projectId: row.project_id,
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costMicrocents: row.cost_microcents,
    occurredAt: row.occurred_at,
  };
}

export function recordCostEvent(params: {
  workspaceId: string;
  agentId: string;
  sessionId?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  provider?: string | null;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicrocents: number;
}): CostEvent {
  const db = getStateDb();
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    INSERT INTO op1_cost_events (
      id, workspace_id, agent_id, session_id, task_id, project_id,
      provider, model, input_tokens, output_tokens, cost_microcents, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    params.workspaceId,
    params.agentId,
    params.sessionId || null,
    params.taskId || null,
    params.projectId || null,
    params.provider || null,
    params.model || null,
    params.inputTokens,
    params.outputTokens,
    params.costMicrocents,
    now,
  );

  return {
    id,
    ...params,
    sessionId: params.sessionId || null,
    taskId: params.taskId || null,
    projectId: params.projectId || null,
    provider: params.provider || null,
    model: params.model || null,
    occurredAt: now,
  };
}

export function listCostEvents(filters?: {
  workspaceId?: string;
  agentId?: string;
  projectId?: string;
  taskId?: string;
  sinceUtc?: number;
  untilUtc?: number;
}): CostEvent[] {
  const db = getStateDb();
  let query = "SELECT * FROM op1_cost_events WHERE 1=1";
  const params: Array<string | number | bigint | null> = [];

  if (filters?.workspaceId) {
    query += " AND workspace_id = ?";
    params.push(filters.workspaceId);
  }
  if (filters?.agentId) {
    query += " AND agent_id = ?";
    params.push(filters.agentId);
  }
  if (filters?.projectId) {
    query += " AND project_id = ?";
    params.push(filters.projectId);
  }
  if (filters?.taskId) {
    query += " AND task_id = ?";
    params.push(filters.taskId);
  }
  if (filters?.sinceUtc) {
    query += " AND occurred_at >= ?";
    params.push(filters.sinceUtc);
  }
  if (filters?.untilUtc) {
    query += " AND occurred_at <= ?";
    params.push(filters.untilUtc);
  }

  query += " ORDER BY occurred_at DESC";

  const stmt = db.prepare(query);
  const rows = stmt.all(...params);
  return (rows as unknown as CostEventRow[]).map(rowToCostEvent);
}

export function getQuotaWindowSpend(params: {
  workspaceId: string;
  windowKind: "calendar_month_utc" | "lifetime";
  scopeType?: "workspace" | "agent" | "project";
  scopeId?: string;
}): { spentMicrocents: number; windowStart: number; windowEnd: number } {
  const db = getStateDb();

  let windowStart: number;
  let windowEnd: number;

  if (params.windowKind === "calendar_month_utc") {
    // Compute start/end of current UTC month as unix timestamps
    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
    const endOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0) - 1,
    );
    windowStart = Math.floor(startOfMonth.getTime() / 1000);
    windowEnd = Math.floor(endOfMonth.getTime() / 1000);
  } else {
    // lifetime: from epoch 0 to far future
    windowStart = 0;
    windowEnd = 2147483647; // max unix timestamp (year 2038)
  }

  let query = `
    SELECT SUM(cost_microcents) as total
    FROM op1_cost_events
    WHERE workspace_id = ?
      AND occurred_at BETWEEN ? AND ?
  `;
  const queryParams: Array<string | number | bigint | null> = [
    params.workspaceId,
    windowStart,
    windowEnd,
  ];

  // Apply scope filter if provided
  if (params.scopeType && params.scopeId) {
    if (params.scopeType === "agent") {
      query += " AND agent_id = ?";
      queryParams.push(params.scopeId);
    } else if (params.scopeType === "project") {
      query += " AND project_id = ?";
      queryParams.push(params.scopeId);
    }
    // scopeType === "workspace" applies no additional filter (workspace_id already filters)
  }

  const stmt = db.prepare(query);
  const row = stmt.get(...queryParams) as unknown as { total: number | null } | undefined;

  return {
    spentMicrocents: row?.total ?? 0,
    windowStart,
    windowEnd,
  };
}

export function getAggregateCost(filters: {
  workspaceId: string;
  agentId?: string;
  projectId?: string;
  taskId?: string;
  sinceUtc?: number;
  untilUtc?: number;
}): { totalMicrocents: number; totalInputTokens: number; totalOutputTokens: number } {
  const db = getStateDb();
  let query = `
    SELECT 
      SUM(cost_microcents) as total_microcents,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens
    FROM op1_cost_events
    WHERE workspace_id = ?
  `;
  const params: Array<string | number | bigint | null> = [filters.workspaceId];

  if (filters.agentId) {
    query += " AND agent_id = ?";
    params.push(filters.agentId);
  }
  if (filters?.projectId) {
    query += " AND project_id = ?";
    params.push(filters.projectId);
  }
  if (filters?.taskId) {
    query += " AND task_id = ?";
    params.push(filters.taskId);
  }
  if (filters?.sinceUtc) {
    query += " AND occurred_at >= ?";
    params.push(filters.sinceUtc);
  }
  if (filters?.untilUtc) {
    query += " AND occurred_at <= ?";
    params.push(filters.untilUtc);
  }

  const stmt = db.prepare(query);
  const row = stmt.get(...params) as unknown as {
    total_microcents: number | null;
    total_input_tokens: number | null;
    total_output_tokens: number | null;
  };
  return {
    totalMicrocents: row?.total_microcents || 0,
    totalInputTokens: row?.total_input_tokens || 0,
    totalOutputTokens: row?.total_output_tokens || 0,
  };
}
