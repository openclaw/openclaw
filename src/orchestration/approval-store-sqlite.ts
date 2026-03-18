import { randomUUID } from "node:crypto";
import { getStateDb } from "../infra/state-db/index.js";
import type { Approval, ApprovalStatus, ApprovalType, RequesterType } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

type ApprovalRow = {
  id: string;
  workspace_id: string;
  type: string;
  status: string;
  requester_id: string;
  requester_type: string;
  payload_json: string | null;
  decision_note: string | null;
  decided_by: string | null;
  decided_at: number | null;
  created_at: number;
  updated_at: number;
};

function rowToApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type as ApprovalType,
    status: row.status as ApprovalStatus,
    requesterId: row.requester_id,
    requesterType: row.requester_type as RequesterType,
    payloadJson: row.payload_json,
    decisionNote: row.decision_note,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Approvals CRUD ───────────────────────────────────────────────────────────

export function requestApproval(params: {
  workspaceId: string;
  type: ApprovalType;
  requesterId: string;
  requesterType?: RequesterType;
  payload?: unknown;
}): Approval {
  const db = getStateDb();
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    INSERT INTO op1_approvals (
      id, workspace_id, type, status, requester_id, requester_type,
      payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    params.workspaceId,
    params.type,
    "pending",
    params.requesterId,
    params.requesterType || "agent",
    params.payload ? JSON.stringify(params.payload) : null,
    now,
    now,
  );

  return getApproval(id)!;
}

export function getApproval(id: string): Approval | null {
  const db = getStateDb();
  const stmt = db.prepare("SELECT * FROM op1_approvals WHERE id = ?");
  const row = stmt.get(id);
  return row ? rowToApproval(row as unknown as ApprovalRow) : null;
}

export function listApprovals(filters: {
  workspaceId?: string;
  status?: ApprovalStatus;
  type?: ApprovalType;
}): Approval[] {
  const db = getStateDb();
  let query = "SELECT * FROM op1_approvals WHERE 1=1";
  const params: Array<string | number | bigint | null> = [];

  if (filters.workspaceId) {
    query += " AND workspace_id = ?";
    params.push(filters.workspaceId);
  }
  if (filters.status) {
    query += " AND status = ?";
    params.push(filters.status);
  }
  if (filters.type) {
    query += " AND type = ?";
    params.push(filters.type);
  }

  query += " ORDER BY created_at DESC";

  const stmt = db.prepare(query);
  const rows = stmt.all(...params);
  return (rows as unknown as ApprovalRow[]).map(rowToApproval);
}

export function decideApproval(
  id: string,
  decision: "approved" | "rejected" | "revision_requested",
  decidedBy: string,
  decisionNote?: string,
): Approval {
  const db = getStateDb();
  const existing = getApproval(id);
  if (!existing) {
    throw new Error(`Approval not found: ${id}`);
  }

  if (existing.status !== "pending" && existing.status !== "revision_requested") {
    throw new Error(`Cannot decide on approval in state ${existing.status}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    UPDATE op1_approvals
    SET status = ?, decided_by = ?, decision_note = ?, decided_at = ?, updated_at = ?
    WHERE id = ?
  `);

  stmt.run(decision, decidedBy, decisionNote || null, now, now, id);

  return getApproval(id)!;
}

export function updateApprovalPayload(id: string, payload: unknown): Approval {
  const db = getStateDb();
  const existing = getApproval(id);
  if (!existing) {
    throw new Error(`Approval not found: ${id}`);
  }

  if (existing.status !== "pending" && existing.status !== "revision_requested") {
    throw new Error(`Cannot update payload for approval in state ${existing.status}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    UPDATE op1_approvals
    SET payload_json = ?, updated_at = ?
    WHERE id = ?
  `);

  stmt.run(JSON.stringify(payload), now, id);

  return getApproval(id)!;
}
