/**
 * SQLite adapter for the clawhub tables.
 *
 * Replaces:
 *   {workspace}/.openclaw/clawhub/catalog.json  → op1_clawhub_catalog rows
 *   {workspace}/.openclaw/clawhub/previews/*.json → preview_json column
 *   {workspace}/.openclaw/clawhub/clawhub.lock.json → op1_clawhub_locks rows
 *
 * Sync metadata (syncedAt, totalSkills) is stored in
 *   core_settings(scope='clawhub', key=<workspaceId>).
 *
 * Schema:
 *   op1_clawhub_catalog(workspace_id, skill_slug, version, metadata_json,
 *                        preview_json, installed_at, updated_at)
 *   op1_clawhub_locks(workspace_id, skill_slug, lock_version,
 *                      lock_data_json, locked_at)
 */
import crypto from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getStateDb } from "./connection.js";

// ── DB provider (overridable for tests) ─────────────────────────────────────

let _dbOverride: DatabaseSync | null = null;

export function setClawhubDbForTest(db: DatabaseSync): void {
  _dbOverride = db;
}

export function resetClawhubDbForTest(): void {
  _dbOverride = null;
}

function resolveDb(): DatabaseSync {
  return _dbOverride ?? getStateDb();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function deriveWorkspaceId(workspacePath: string): string {
  const normalized = path.resolve(workspacePath);
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

// ── Sync metadata ───────────────────────────────────────────────────────────

export interface ClawhubSyncMeta {
  syncedAt: string;
  totalSkills: number;
}

export function getClawhubSyncMeta(workspacePath: string): ClawhubSyncMeta | null {
  const db = resolveDb();
  const wsId = deriveWorkspaceId(workspacePath);
  try {
    const row = db
      .prepare("SELECT value_json FROM core_settings WHERE scope = 'clawhub' AND key = ?")
      .get(wsId) as { value_json: string | null } | undefined;
    if (!row || row.value_json == null) {
      return null;
    }
    return JSON.parse(row.value_json) as ClawhubSyncMeta;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return null;
    }
    throw err;
  }
}

export function setClawhubSyncMeta(workspacePath: string, meta: ClawhubSyncMeta): void {
  const db = resolveDb();
  const wsId = deriveWorkspaceId(workspacePath);
  const json = JSON.stringify(meta);
  const now = Math.floor(Date.now() / 1000);
  try {
    db.prepare(
      `INSERT INTO core_settings (scope, key, value_json, updated_at)
       VALUES ('clawhub', ?, ?, ?)
       ON CONFLICT (scope, key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    ).run(wsId, json, now);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}

// ── Catalog ─────────────────────────────────────────────────────────────────

/**
 * Replace the entire catalog for a workspace in a single transaction.
 * Deletes existing rows and inserts new ones.
 */
export function replaceCatalogInDb(
  workspacePath: string,
  skills: Array<Record<string, unknown>>,
): void {
  const db = resolveDb();
  const wsId = deriveWorkspaceId(workspacePath);
  const now = Math.floor(Date.now() / 1000);

  try {
    db.exec("BEGIN");
    try {
      // Delete all existing catalog entries (but preserve preview_json — see below)
      // First, collect existing previews so we can reattach them
      const existingPreviews = new Map<string, string>();
      const rows = db
        .prepare(
          "SELECT skill_slug, preview_json FROM op1_clawhub_catalog WHERE workspace_id = ? AND preview_json IS NOT NULL",
        )
        .all(wsId) as Array<{ skill_slug: string; preview_json: string }>;
      for (const row of rows) {
        existingPreviews.set(row.skill_slug, row.preview_json);
      }

      db.prepare("DELETE FROM op1_clawhub_catalog WHERE workspace_id = ?").run(wsId);

      const insert = db.prepare(
        `INSERT INTO op1_clawhub_catalog
           (workspace_id, skill_slug, version, metadata_json, preview_json, installed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const skill of skills) {
        const slug = typeof skill.slug === "string" ? skill.slug : "";
        if (!slug) {
          continue;
        }
        const version = (skill.latestVersion as { version?: string } | undefined)?.version ?? null;
        const metadata = JSON.stringify(skill);
        const preview = existingPreviews.get(slug) ?? null;
        insert.run(wsId, slug, version, metadata, preview, null, now);
      }

      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}

/** Get all catalog skills for a workspace. */
export function getCatalogSkillsFromDb(workspacePath: string): Array<Record<string, unknown>> {
  const db = resolveDb();
  const wsId = deriveWorkspaceId(workspacePath);
  try {
    const rows = db
      .prepare(
        "SELECT metadata_json FROM op1_clawhub_catalog WHERE workspace_id = ? ORDER BY skill_slug",
      )
      .all(wsId) as Array<{ metadata_json: string }>;
    return rows
      .map((row) => {
        try {
          return JSON.parse(row.metadata_json) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((s): s is Record<string, unknown> => s != null);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return [];
    }
    throw err;
  }
}

/** Get a single catalog skill by slug. */
export function getCatalogSkillFromDb(
  workspacePath: string,
  slug: string,
): Record<string, unknown> | null {
  const db = resolveDb();
  const wsId = deriveWorkspaceId(workspacePath);
  try {
    const row = db
      .prepare(
        "SELECT metadata_json FROM op1_clawhub_catalog WHERE workspace_id = ? AND skill_slug = ?",
      )
      .get(wsId, slug) as { metadata_json: string } | undefined;
    if (!row) {
      return null;
    }
    return JSON.parse(row.metadata_json) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return null;
    }
    throw err;
  }
}

/** Get the version of a catalog skill (for preview cache invalidation). */
export function getCatalogSkillVersionFromDb(workspacePath: string, slug: string): string | null {
  const db = resolveDb();
  const wsId = deriveWorkspaceId(workspacePath);
  try {
    const row = db
      .prepare("SELECT version FROM op1_clawhub_catalog WHERE workspace_id = ? AND skill_slug = ?")
      .get(wsId, slug) as { version: string | null } | undefined;
    return row?.version ?? null;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return null;
    }
    throw err;
  }
}

// ── Preview cache ───────────────────────────────────────────────────────────

export interface ClawhubPreview {
  slug: string;
  version: string;
  fetchedAt: string;
  content: string;
}

/** Get cached preview for a skill. */
export function getSkillPreviewFromDb(workspacePath: string, slug: string): ClawhubPreview | null {
  const db = resolveDb();
  const wsId = deriveWorkspaceId(workspacePath);
  try {
    const row = db
      .prepare(
        "SELECT preview_json FROM op1_clawhub_catalog WHERE workspace_id = ? AND skill_slug = ?",
      )
      .get(wsId, slug) as { preview_json: string | null } | undefined;
    if (!row || row.preview_json == null) {
      return null;
    }
    return JSON.parse(row.preview_json) as ClawhubPreview;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return null;
    }
    throw err;
  }
}

/** Set or update the preview cache for a skill. */
export function setSkillPreviewInDb(workspacePath: string, preview: ClawhubPreview): void {
  const db = resolveDb();
  const wsId = deriveWorkspaceId(workspacePath);
  const json = JSON.stringify(preview);
  const now = Math.floor(Date.now() / 1000);
  try {
    // If the skill exists in the catalog, update its preview_json
    const result = db
      .prepare(
        "UPDATE op1_clawhub_catalog SET preview_json = ?, updated_at = ? WHERE workspace_id = ? AND skill_slug = ?",
      )
      .run(json, now, wsId, preview.slug);
    // If skill not in catalog yet (inspected before sync), insert a row
    if (Number(result.changes) === 0) {
      db.prepare(
        `INSERT INTO op1_clawhub_catalog
           (workspace_id, skill_slug, version, metadata_json, preview_json, installed_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, NULL, ?)`,
      ).run(wsId, preview.slug, preview.version, json, now);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}

/** Delete the preview cache for a skill (invalidation). */
export function deleteSkillPreviewFromDb(workspacePath: string, slug: string): boolean {
  const db = resolveDb();
  const wsId = deriveWorkspaceId(workspacePath);
  try {
    const result = db
      .prepare(
        "UPDATE op1_clawhub_catalog SET preview_json = NULL WHERE workspace_id = ? AND skill_slug = ?",
      )
      .run(wsId, slug);
    return Number(result.changes) > 0;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return false;
    }
    throw err;
  }
}

// ── Lock entries ────────────────────────────────────────────────────────────

/** Get all lock entries for a workspace. Returns a map of slug → {version}. */
export function getAllLockEntriesFromDb(
  workspacePath: string,
): Record<string, { version?: string }> {
  const db = resolveDb();
  const wsId = deriveWorkspaceId(workspacePath);
  try {
    const rows = db
      .prepare("SELECT skill_slug, lock_version FROM op1_clawhub_locks WHERE workspace_id = ?")
      .all(wsId) as Array<{ skill_slug: string; lock_version: string | null }>;
    const result: Record<string, { version?: string }> = {};
    for (const row of rows) {
      result[row.skill_slug] = { version: row.lock_version ?? undefined };
    }
    return result;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return {};
    }
    throw err;
  }
}

/** Upsert a lock entry. */
export function upsertLockEntryInDb(
  workspacePath: string,
  slug: string,
  version: string | null,
  lockDataJson: string,
  lockedAt: number,
): void {
  const db = resolveDb();
  const wsId = deriveWorkspaceId(workspacePath);
  try {
    db.prepare(
      `INSERT INTO op1_clawhub_locks
         (workspace_id, skill_slug, lock_version, lock_data_json, locked_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, skill_slug) DO UPDATE SET
         lock_version = excluded.lock_version,
         lock_data_json = excluded.lock_data_json`,
    ).run(wsId, slug, version, lockDataJson, lockedAt);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}

/** Delete a lock entry. */
export function deleteLockEntryFromDb(workspacePath: string, slug: string): boolean {
  const db = resolveDb();
  const wsId = deriveWorkspaceId(workspacePath);
  try {
    const result = db
      .prepare("DELETE FROM op1_clawhub_locks WHERE workspace_id = ? AND skill_slug = ?")
      .run(wsId, slug);
    return Number(result.changes) > 0;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return false;
    }
    throw err;
  }
}
