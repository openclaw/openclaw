import { randomUUID } from "node:crypto";
import { getStateDb } from "../infra/state-db/connection.js";
import type { WakeupRequest, WakeupRequestStatus } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

type WakeupRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  task_id: string | null;
  reason: string;
  status: string;
  payload_json: string | null;
  created_at: number;
  processed_at: number | null;
};

function rowToWakeup(row: WakeupRow): WakeupRequest {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    taskId: row.task_id,
    reason: row.reason,
    status: row.status as WakeupRequestStatus,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
    processedAt: row.processed_at,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function createWakeupRequest(params: {
  agentId: string;
  workspaceId?: string;
  taskId?: string;
  reason?: string;
  payloadJson?: string;
}): WakeupRequest {
  const db = getStateDb();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO op1_agent_wakeup_requests
      (id, workspace_id, agent_id, task_id, reason, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.workspaceId ?? "default",
    params.agentId,
    params.taskId ?? null,
    params.reason ?? "task_assigned",
    params.payloadJson ?? null,
  );

  return rowToWakeup(
    db
      .prepare("SELECT * FROM op1_agent_wakeup_requests WHERE id = ?")
      .get(id) as unknown as WakeupRow,
  );
}

export function listPendingWakeupRequests(agentId?: string): WakeupRequest[] {
  const db = getStateDb();
  let query = "SELECT * FROM op1_agent_wakeup_requests WHERE status = 'pending'";
  const params: Array<string> = [];
  if (agentId) {
    query += " AND agent_id = ?";
    params.push(agentId);
  }
  query += " ORDER BY created_at ASC";
  const rows = db.prepare(query).all(...params) as unknown as WakeupRow[];
  return rows.map(rowToWakeup);
}

export function markWakeupProcessing(id: string): void {
  const db = getStateDb();
  db.prepare("UPDATE op1_agent_wakeup_requests SET status = 'processing' WHERE id = ?").run(id);
}

export function markWakeupCompleted(id: string): void {
  const db = getStateDb();
  db.prepare(
    "UPDATE op1_agent_wakeup_requests SET status = 'completed', processed_at = unixepoch() WHERE id = ?",
  ).run(id);
}

export function markWakeupFailed(id: string): void {
  const db = getStateDb();
  db.prepare(
    "UPDATE op1_agent_wakeup_requests SET status = 'failed', processed_at = unixepoch() WHERE id = ?",
  ).run(id);
}
