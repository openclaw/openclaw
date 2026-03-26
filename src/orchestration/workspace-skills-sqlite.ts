import { randomUUID } from "node:crypto";
import { getStateDb } from "../infra/state-db/index.js";
import type {
  WorkspaceSkill,
  WorkspaceSkillCompatibility,
  WorkspaceSkillFileInventoryEntry,
  WorkspaceSkillListItem,
  WorkspaceSkillSourceType,
  WorkspaceSkillTrustLevel,
} from "./types.js";

// ── Row type ──────────────────────────────────────────────────────────────────

type WorkspaceSkillRow = {
  id: string;
  workspace_id: string;
  key: string;
  slug: string;
  name: string;
  description: string | null;
  markdown: string;
  source_type: string;
  source_locator: string | null;
  source_ref: string | null;
  trust_level: string;
  compatibility: string;
  file_inventory_json: string; // JSON text: WorkspaceSkillFileInventoryEntry[]
  metadata_json: string | null; // JSON text: Record<string, unknown>
  created_at: number;
  updated_at: number;
};

// ── Converter ─────────────────────────────────────────────────────────────────

function rowToSkill(row: WorkspaceSkillRow): WorkspaceSkill {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    key: row.key,
    slug: row.slug,
    name: row.name,
    description: row.description,
    markdown: row.markdown,
    sourceType: row.source_type as WorkspaceSkillSourceType,
    sourceLocator: row.source_locator,
    sourceRef: row.source_ref,
    trustLevel: row.trust_level as WorkspaceSkillTrustLevel,
    compatibility: row.compatibility as WorkspaceSkillCompatibility,
    fileInventory: JSON.parse(row.file_inventory_json) as WorkspaceSkillFileInventoryEntry[],
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSkillListItem(row: WorkspaceSkillRow & { attached_agent_count: number }): WorkspaceSkillListItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    key: row.key,
    slug: row.slug,
    name: row.name,
    description: row.description,
    sourceType: row.source_type as WorkspaceSkillSourceType,
    sourceLocator: row.source_locator,
    sourceRef: row.source_ref,
    trustLevel: row.trust_level as WorkspaceSkillTrustLevel,
    compatibility: row.compatibility as WorkspaceSkillCompatibility,
    fileInventory: JSON.parse(row.file_inventory_json) as WorkspaceSkillFileInventoryEntry[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachedAgentCount: row.attached_agent_count,
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function createWorkspaceSkill(params: {
  workspaceId: string;
  key: string;
  slug: string;
  name: string;
  markdown: string;
  sourceType: WorkspaceSkillSourceType;
  description?: string;
  sourceLocator?: string;
  sourceRef?: string;
  trustLevel?: WorkspaceSkillTrustLevel;
  compatibility?: WorkspaceSkillCompatibility;
  fileInventory?: WorkspaceSkillFileInventoryEntry[];
  metadata?: Record<string, unknown>;
}): WorkspaceSkill {
  const db = getStateDb();
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO op1_workspace_skills (
      id, workspace_id, key, slug, name, description, markdown,
      source_type, source_locator, source_ref, trust_level, compatibility,
      file_inventory_json, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.workspaceId,
    params.key,
    params.slug,
    params.name,
    params.description ?? null,
    params.markdown,
    params.sourceType,
    params.sourceLocator ?? null,
    params.sourceRef ?? null,
    params.trustLevel ?? "markdown_only",
    params.compatibility ?? "unknown",
    JSON.stringify(params.fileInventory ?? []),
    params.metadata ? JSON.stringify(params.metadata) : null,
    now,
    now,
  );

  return getWorkspaceSkill(id)!;
}

export function getWorkspaceSkill(id: string): WorkspaceSkill | null {
  const db = getStateDb();
  const row = db.prepare("SELECT * FROM op1_workspace_skills WHERE id = ?").get(id);
  return row ? rowToSkill(row as unknown as WorkspaceSkillRow) : null;
}

export function getWorkspaceSkillByKey(workspaceId: string, key: string): WorkspaceSkill | null {
  const db = getStateDb();
  const row = db
    .prepare("SELECT * FROM op1_workspace_skills WHERE workspace_id = ? AND key = ?")
    .get(workspaceId, key);
  return row ? rowToSkill(row as unknown as WorkspaceSkillRow) : null;
}

export function listWorkspaceSkills(workspaceId: string): WorkspaceSkill[] {
  const db = getStateDb();
  const rows = db
    .prepare("SELECT * FROM op1_workspace_skills WHERE workspace_id = ? ORDER BY name ASC")
    .all(workspaceId);
  return (rows as unknown as WorkspaceSkillRow[]).map(rowToSkill);
}

/**
 * List workspace skills with an attached agent count.
 * The count is computed via the op1_workspace_skill_agents join table if it exists;
 * falls back to 0 when the join table is absent (pre-migration environments).
 */
export function listWorkspaceSkillsWithCounts(workspaceId: string): WorkspaceSkillListItem[] {
  const db = getStateDb();
  // Use a LEFT JOIN so we get skills even if they have no attached agents.
  // op1_workspace_skill_agents may not yet exist in all environments — query
  // the sqlite_master to detect it first; if absent, return 0 for all.
  const joinTableExists =
    (db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='op1_workspace_skill_agents'",
      )
      .get() as { name: string } | undefined) !== undefined;

  let query: string;
  if (joinTableExists) {
    query = `
      SELECT s.*, COUNT(a.agent_id) AS attached_agent_count
      FROM op1_workspace_skills s
      LEFT JOIN op1_workspace_skill_agents a ON a.skill_id = s.id
      WHERE s.workspace_id = ?
      GROUP BY s.id
      ORDER BY s.name ASC
    `;
  } else {
    query = `
      SELECT *, 0 AS attached_agent_count
      FROM op1_workspace_skills
      WHERE workspace_id = ?
      ORDER BY name ASC
    `;
  }

  const rows = db.prepare(query).all(workspaceId);
  return (rows as unknown as Array<WorkspaceSkillRow & { attached_agent_count: number }>).map(
    rowToSkillListItem,
  );
}

export function updateWorkspaceSkill(
  id: string,
  updates: {
    name?: string;
    description?: string | null;
    markdown?: string;
    sourceRef?: string | null;
    trustLevel?: WorkspaceSkillTrustLevel;
    compatibility?: WorkspaceSkillCompatibility;
    fileInventory?: WorkspaceSkillFileInventoryEntry[];
    metadata?: Record<string, unknown> | null;
  },
): WorkspaceSkill {
  const db = getStateDb();
  const existing = getWorkspaceSkill(id);
  if (!existing) throw new Error(`WorkspaceSkill not found: ${id}`);

  const now = Math.floor(Date.now() / 1000);
  const sets: string[] = ["updated_at = ?"];
  const params: Array<string | number | bigint | null> = [now];

  if (updates.name !== undefined) { sets.push("name = ?"); params.push(updates.name); }
  if (updates.description !== undefined) { sets.push("description = ?"); params.push(updates.description); }
  if (updates.markdown !== undefined) { sets.push("markdown = ?"); params.push(updates.markdown); }
  if (updates.sourceRef !== undefined) { sets.push("source_ref = ?"); params.push(updates.sourceRef); }
  if (updates.trustLevel !== undefined) { sets.push("trust_level = ?"); params.push(updates.trustLevel); }
  if (updates.compatibility !== undefined) { sets.push("compatibility = ?"); params.push(updates.compatibility); }
  if (updates.fileInventory !== undefined) {
    sets.push("file_inventory_json = ?");
    params.push(JSON.stringify(updates.fileInventory));
  }
  if (updates.metadata !== undefined) {
    sets.push("metadata_json = ?");
    params.push(updates.metadata ? JSON.stringify(updates.metadata) : null);
  }

  params.push(id);
  db.prepare(`UPDATE op1_workspace_skills SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getWorkspaceSkill(id)!;
}

export function deleteWorkspaceSkill(id: string): void {
  const db = getStateDb();
  db.prepare("DELETE FROM op1_workspace_skills WHERE id = ?").run(id);
}
