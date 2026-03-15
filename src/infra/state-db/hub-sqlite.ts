/**
 * SQLite adapter for Operator1Hub tables.
 *
 * Tables:
 *   op1_hub_catalog    — cached registry items from registry.json
 *   op1_hub_installed  — locally installed hub items
 *   op1_hub_collections — cached collection definitions
 *
 * Sync metadata (syncedAt, totalItems) is stored in
 *   core_settings(scope='hub', key='sync_meta').
 */
import type { DatabaseSync } from "node:sqlite";
import { getStateDb } from "./connection.js";

// ── DB provider (overridable for tests) ─────────────────────────────────────

let _dbOverride: DatabaseSync | null = null;

export function setHubDbForTest(db: DatabaseSync): void {
  _dbOverride = db;
}

export function resetHubDbForTest(): void {
  _dbOverride = null;
}

function resolveDb(): DatabaseSync {
  return _dbOverride ?? getStateDb();
}

// ── Types ────────────────────────────────────────────────────────────────────

export type HubItemType = "skill" | "agent" | "command";

export interface HubCatalogItem {
  slug: string;
  name: string;
  type: HubItemType;
  category: string;
  description: string | null;
  path: string;
  readme: string | null;
  version: string;
  tags: string[];
  emoji: string | null;
  sha256: string | null;
  bundled: boolean;
}

export interface HubInstalledItem {
  slug: string;
  type: HubItemType;
  version: string;
  installPath: string;
  agentId: string | null;
  installedAt: number;
}

export interface HubCollection {
  slug: string;
  name: string;
  description: string | null;
  emoji: string | null;
  items: string[];
}

export interface HubSyncMeta {
  syncedAt: string;
  totalItems: number;
}

// ── Sync metadata ────────────────────────────────────────────────────────────

export function getHubSyncMeta(): HubSyncMeta | null {
  const db = resolveDb();
  try {
    const row = db
      .prepare("SELECT value_json FROM core_settings WHERE scope = 'hub' AND key = 'sync_meta'")
      .get() as { value_json: string | null } | undefined;
    if (!row || row.value_json == null) {
      return null;
    }
    return JSON.parse(row.value_json) as HubSyncMeta;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return null;
    }
    throw err;
  }
}

export function setHubSyncMeta(meta: HubSyncMeta): void {
  const db = resolveDb();
  const now = Math.floor(Date.now() / 1000);
  try {
    db.prepare(
      `INSERT INTO core_settings (scope, key, value_json, updated_at)
       VALUES ('hub', 'sync_meta', ?, ?)
       ON CONFLICT (scope, key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    ).run(JSON.stringify(meta), now);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}

// ── Catalog ──────────────────────────────────────────────────────────────────

/**
 * Replace the entire hub catalog in a single transaction.
 * Preserves bundled flags for items that were previously marked bundled.
 */
export function replaceHubCatalogInDb(items: HubCatalogItem[]): void {
  const db = resolveDb();
  const now = Math.floor(Date.now() / 1000);

  try {
    db.exec("BEGIN");
    try {
      // Preserve existing bundled flags before replacing
      const existingBundled = new Set<string>();
      const rows = db.prepare("SELECT slug FROM op1_hub_catalog WHERE bundled = 1").all() as Array<{
        slug: string;
      }>;
      for (const row of rows) {
        existingBundled.add(row.slug);
      }

      db.prepare("DELETE FROM op1_hub_catalog").run();

      const insert = db.prepare(`
        INSERT INTO op1_hub_catalog
          (slug, name, type, category, description, path, readme, version,
           tags_json, emoji, sha256, bundled, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of items) {
        insert.run(
          item.slug,
          item.name,
          item.type,
          item.category,
          item.description ?? null,
          item.path,
          item.readme ?? null,
          item.version,
          JSON.stringify(item.tags),
          item.emoji ?? null,
          item.sha256 ?? null,
          item.bundled || existingBundled.has(item.slug) ? 1 : 0,
          now,
        );
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

/** Mark specific slugs as bundled (persona already ships locally). */
export function markHubItemsBundledInDb(bundledSlugs: Set<string>): void {
  const db = resolveDb();
  if (bundledSlugs.size === 0) {
    return;
  }
  try {
    db.exec("BEGIN");
    try {
      // Reset all agent bundled flags, then set the matching ones
      db.prepare("UPDATE op1_hub_catalog SET bundled = 0 WHERE type = 'agent'").run();
      const stmt = db.prepare(
        "UPDATE op1_hub_catalog SET bundled = 1 WHERE slug = ? AND type = 'agent'",
      );
      for (const slug of bundledSlugs) {
        stmt.run(slug);
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

function rowToCatalogItem(row: {
  slug: string;
  name: string;
  type: string;
  category: string;
  description: string | null;
  path: string;
  readme: string | null;
  version: string;
  tags_json: string;
  emoji: string | null;
  sha256: string | null;
  bundled: number;
}): HubCatalogItem {
  return {
    slug: row.slug,
    name: row.name,
    type: row.type as HubItemType,
    category: row.category,
    description: row.description,
    path: row.path,
    readme: row.readme,
    version: row.version,
    tags: (() => {
      try {
        return JSON.parse(row.tags_json) as string[];
      } catch {
        return [];
      }
    })(),
    emoji: row.emoji,
    sha256: row.sha256,
    bundled: row.bundled === 1,
  };
}

/** Get all catalog items, optionally filtered by type and/or category. */
export function getHubCatalogItemsFromDb(filter?: {
  type?: HubItemType;
  category?: string;
}): HubCatalogItem[] {
  const db = resolveDb();
  try {
    let query = "SELECT * FROM op1_hub_catalog";
    const conditions: string[] = [];
    const args: string[] = [];

    if (filter?.type) {
      conditions.push("type = ?");
      args.push(filter.type);
    }
    if (filter?.category) {
      conditions.push("category = ?");
      args.push(filter.category);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }
    query += " ORDER BY name";

    return (
      db.prepare(query).all(...args) as Array<{
        slug: string;
        name: string;
        type: string;
        category: string;
        description: string | null;
        path: string;
        readme: string | null;
        version: string;
        tags_json: string;
        emoji: string | null;
        sha256: string | null;
        bundled: number;
      }>
    ).map(rowToCatalogItem);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return [];
    }
    throw err;
  }
}

/** Get a single catalog item by slug. */
export function getHubCatalogItemFromDb(slug: string): HubCatalogItem | null {
  const db = resolveDb();
  try {
    const row = db.prepare("SELECT * FROM op1_hub_catalog WHERE slug = ?").get(slug) as
      | {
          slug: string;
          name: string;
          type: string;
          category: string;
          description: string | null;
          path: string;
          readme: string | null;
          version: string;
          tags_json: string;
          emoji: string | null;
          sha256: string | null;
          bundled: number;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return rowToCatalogItem(row);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return null;
    }
    throw err;
  }
}

// ── Installed tracking ───────────────────────────────────────────────────────

export function insertHubInstalledInDb(item: Omit<HubInstalledItem, "installedAt">): void {
  const db = resolveDb();
  const now = Math.floor(Date.now() / 1000);
  try {
    db.prepare(`
      INSERT INTO op1_hub_installed (slug, type, version, install_path, agent_id, installed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (slug) DO UPDATE SET
        version = excluded.version,
        install_path = excluded.install_path,
        agent_id = excluded.agent_id,
        installed_at = excluded.installed_at
    `).run(item.slug, item.type, item.version, item.installPath, item.agentId ?? null, now);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}

export function deleteHubInstalledFromDb(slug: string): boolean {
  const db = resolveDb();
  try {
    const result = db.prepare("DELETE FROM op1_hub_installed WHERE slug = ?").run(slug);
    return Number(result.changes) > 0;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return false;
    }
    throw err;
  }
}

export function getHubInstalledItemFromDb(slug: string): HubInstalledItem | null {
  const db = resolveDb();
  try {
    const row = db.prepare("SELECT * FROM op1_hub_installed WHERE slug = ?").get(slug) as
      | {
          slug: string;
          type: string;
          version: string;
          install_path: string;
          agent_id: string | null;
          installed_at: number;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      slug: row.slug,
      type: row.type as HubItemType,
      version: row.version,
      installPath: row.install_path,
      agentId: row.agent_id,
      installedAt: row.installed_at,
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return null;
    }
    throw err;
  }
}

export function getAllHubInstalledFromDb(): HubInstalledItem[] {
  const db = resolveDb();
  try {
    const rows = db.prepare("SELECT * FROM op1_hub_installed ORDER BY slug").all() as Array<{
      slug: string;
      type: string;
      version: string;
      install_path: string;
      agent_id: string | null;
      installed_at: number;
    }>;
    return rows.map((row) => ({
      slug: row.slug,
      type: row.type as HubItemType,
      version: row.version,
      installPath: row.install_path,
      agentId: row.agent_id,
      installedAt: row.installed_at,
    }));
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return [];
    }
    throw err;
  }
}

// ── Collections ──────────────────────────────────────────────────────────────

export function replaceHubCollectionsInDb(collections: HubCollection[]): void {
  const db = resolveDb();
  try {
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM op1_hub_collections").run();
      const insert = db.prepare(`
        INSERT INTO op1_hub_collections (slug, name, description, emoji, items_json)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const col of collections) {
        insert.run(
          col.slug,
          col.name,
          col.description ?? null,
          col.emoji ?? null,
          JSON.stringify(col.items),
        );
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

export function getHubCollectionsFromDb(): HubCollection[] {
  const db = resolveDb();
  try {
    const rows = db.prepare("SELECT * FROM op1_hub_collections ORDER BY name").all() as Array<{
      slug: string;
      name: string;
      description: string | null;
      emoji: string | null;
      items_json: string;
    }>;
    return rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      description: row.description,
      emoji: row.emoji,
      items: (() => {
        try {
          return JSON.parse(row.items_json) as string[];
        } catch {
          return [];
        }
      })(),
    }));
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return [];
    }
    throw err;
  }
}
