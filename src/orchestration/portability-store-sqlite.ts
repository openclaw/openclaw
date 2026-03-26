import { randomUUID } from "node:crypto";
import { getStateDb } from "../infra/state-db/index.js";
import type { PortabilityExport, PortabilityImport, PortabilityInclude } from "./types.js";

// ── Row types ─────────────────────────────────────────────────────────────────

type PortabilityExportRow = {
  id: string;
  workspace_id: string;
  exported_by: string | null;
  include_json: string; // JSON text: PortabilityInclude
  status: string;
  asset_path: string | null;
  error: string | null;
  created_at: number;
  completed_at: number | null;
};

type PortabilityImportRow = {
  id: string;
  workspace_id: string;
  imported_by: string | null;
  source_ref: string | null;
  collision_strategy: string;
  status: string;
  result_json: string | null; // JSON text: Record<string, unknown>
  error: string | null;
  created_at: number;
  completed_at: number | null;
};

// ── Converters ────────────────────────────────────────────────────────────────

function rowToExport(row: PortabilityExportRow): PortabilityExport {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    exportedBy: row.exported_by,
    include: JSON.parse(row.include_json) as PortabilityInclude,
    status: row.status as PortabilityExport["status"],
    assetPath: row.asset_path,
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function rowToImport(row: PortabilityImportRow): PortabilityImport {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    importedBy: row.imported_by,
    sourceRef: row.source_ref,
    collisionStrategy: row.collision_strategy as PortabilityImport["collisionStrategy"],
    status: row.status as PortabilityImport["status"],
    result: row.result_json ? (JSON.parse(row.result_json) as Record<string, unknown>) : null,
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

// ── Portability Exports ───────────────────────────────────────────────────────

export function createPortabilityExport(params: {
  workspaceId: string;
  include: PortabilityInclude;
  exportedBy?: string;
}): PortabilityExport {
  const db = getStateDb();
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO op1_portability_exports (
      id, workspace_id, exported_by, include_json, status, created_at
    ) VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(id, params.workspaceId, params.exportedBy ?? null, JSON.stringify(params.include), now);

  return getPortabilityExport(id)!;
}

export function getPortabilityExport(id: string): PortabilityExport | null {
  const db = getStateDb();
  const row = db.prepare("SELECT * FROM op1_portability_exports WHERE id = ?").get(id);
  return row ? rowToExport(row as unknown as PortabilityExportRow) : null;
}

export function listPortabilityExports(workspaceId?: string): PortabilityExport[] {
  const db = getStateDb();
  let query = "SELECT * FROM op1_portability_exports";
  const params: Array<string | number | bigint | null> = [];

  if (workspaceId) {
    query += " WHERE workspace_id = ?";
    params.push(workspaceId);
  }

  query += " ORDER BY created_at DESC";

  const rows = db.prepare(query).all(...params);
  return (rows as unknown as PortabilityExportRow[]).map(rowToExport);
}

export function updatePortabilityExport(
  id: string,
  updates: {
    status?: PortabilityExport["status"];
    assetPath?: string | null;
    error?: string | null;
    completedAt?: number | null;
  },
): PortabilityExport {
  const db = getStateDb();
  const existing = getPortabilityExport(id);
  if (!existing) throw new Error(`PortabilityExport not found: ${id}`);

  const sets: string[] = [];
  const params: Array<string | number | bigint | null> = [];

  if (updates.status !== undefined) { sets.push("status = ?"); params.push(updates.status); }
  if (updates.assetPath !== undefined) { sets.push("asset_path = ?"); params.push(updates.assetPath); }
  if (updates.error !== undefined) { sets.push("error = ?"); params.push(updates.error); }
  if (updates.completedAt !== undefined) { sets.push("completed_at = ?"); params.push(updates.completedAt); }

  if (sets.length === 0) return existing;

  params.push(id);
  db.prepare(`UPDATE op1_portability_exports SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getPortabilityExport(id)!;
}

// ── Portability Imports ───────────────────────────────────────────────────────

export function createPortabilityImport(params: {
  workspaceId: string;
  sourceRef?: string;
  collisionStrategy?: PortabilityImport["collisionStrategy"];
  importedBy?: string;
}): PortabilityImport {
  const db = getStateDb();
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO op1_portability_imports (
      id, workspace_id, imported_by, source_ref, collision_strategy, status, created_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    id,
    params.workspaceId,
    params.importedBy ?? null,
    params.sourceRef ?? null,
    params.collisionStrategy ?? "skip",
    now,
  );

  return getPortabilityImport(id)!;
}

export function getPortabilityImport(id: string): PortabilityImport | null {
  const db = getStateDb();
  const row = db.prepare("SELECT * FROM op1_portability_imports WHERE id = ?").get(id);
  return row ? rowToImport(row as unknown as PortabilityImportRow) : null;
}

export function listPortabilityImports(workspaceId?: string): PortabilityImport[] {
  const db = getStateDb();
  let query = "SELECT * FROM op1_portability_imports";
  const params: Array<string | number | bigint | null> = [];

  if (workspaceId) {
    query += " WHERE workspace_id = ?";
    params.push(workspaceId);
  }

  query += " ORDER BY created_at DESC";

  const rows = db.prepare(query).all(...params);
  return (rows as unknown as PortabilityImportRow[]).map(rowToImport);
}

export function updatePortabilityImport(
  id: string,
  updates: {
    status?: PortabilityImport["status"];
    result?: Record<string, unknown> | null;
    error?: string | null;
    completedAt?: number | null;
  },
): PortabilityImport {
  const db = getStateDb();
  const existing = getPortabilityImport(id);
  if (!existing) throw new Error(`PortabilityImport not found: ${id}`);

  const sets: string[] = [];
  const params: Array<string | number | bigint | null> = [];

  if (updates.status !== undefined) { sets.push("status = ?"); params.push(updates.status); }
  if (updates.result !== undefined) {
    sets.push("result_json = ?");
    params.push(updates.result ? JSON.stringify(updates.result) : null);
  }
  if (updates.error !== undefined) { sets.push("error = ?"); params.push(updates.error); }
  if (updates.completedAt !== undefined) { sets.push("completed_at = ?"); params.push(updates.completedAt); }

  if (sets.length === 0) return existing;

  params.push(id);
  db.prepare(`UPDATE op1_portability_imports SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getPortabilityImport(id)!;
}
