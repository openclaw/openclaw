import { getStateDb } from "../infra/state-db/index.js";
import type { ActivityLogEntry, RequesterType } from "./types.js";

type ActivityLogRow = {
  id: number;
  workspace_id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details_json: string | null;
  created_at: number;
};

function rowToActivityLogEntry(row: ActivityLogRow): ActivityLogEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    actorType: row.actor_type as RequesterType,
    actorId: row.actor_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    detailsJson: row.details_json,
    createdAt: row.created_at,
  };
}

export function logActivity(params: {
  workspaceId: string;
  actorType?: RequesterType;
  actorId?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
}): ActivityLogEntry {
  const db = getStateDb();
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    INSERT INTO op1_activity_log (
      workspace_id, actor_type, actor_id, action,
      entity_type, entity_id, details_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `);

  const row = stmt.get(
    params.workspaceId,
    params.actorType || "system",
    params.actorId || null,
    params.action,
    params.entityType || null,
    params.entityId || null,
    params.details ? JSON.stringify(params.details) : null,
    now,
  );

  return rowToActivityLogEntry(row as unknown as ActivityLogRow);
}

export function listActivityLogs(filters: {
  workspaceId: string;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  limit?: number;
  offset?: number;
}): ActivityLogEntry[] {
  const db = getStateDb();
  let query = "SELECT * FROM op1_activity_log WHERE workspace_id = ?";
  const params: Array<string | number | bigint | null> = [filters.workspaceId];

  if (filters.entityType) {
    query += " AND entity_type = ?";
    params.push(filters.entityType);
  }
  if (filters.entityId) {
    query += " AND entity_id = ?";
    params.push(filters.entityId);
  }
  if (filters.actorId) {
    query += " AND actor_id = ?";
    params.push(filters.actorId);
  }

  query += " ORDER BY created_at DESC";

  if (filters.limit) {
    query += " LIMIT ?";
    params.push(filters.limit);
    if (filters.offset) {
      query += " OFFSET ?";
      params.push(filters.offset);
    }
  }

  const stmt = db.prepare(query);
  const rows = stmt.all(...params);
  return (rows as unknown as ActivityLogRow[]).map(rowToActivityLogEntry);
}
