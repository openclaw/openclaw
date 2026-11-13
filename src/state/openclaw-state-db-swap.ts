// Shared state database target for the generic copy-and-swap fallback.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { VERSION } from "../version.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { migrateSingletonStateFoldInV12 } from "./openclaw-state-db-schema-v12-foldin.js";
import { migrateJsonCanonicalWideRowsV13 } from "./openclaw-state-db-schema-v13-widerow.js";
import { CONTENT_VERSION_KEY } from "./openclaw-state-db-schema-version.js";
import { getOpenClawStateFeatureSchemaSql } from "./openclaw-state-feature-schema.js";
import { getOpenClawStateRuntimeSchema } from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import {
  buildSqliteByCopy,
  type SqliteSwapReport,
  type SqliteSwapTarget,
} from "./sqlite-copy-swap.js";
import { copySqliteFile, normalizeSqliteText } from "./state-upgrade-tree.js";

const CANONICAL_TABLES = new Set(
  [...OPENCLAW_STATE_SCHEMA_SQL.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(
    (match) => match[1]!,
  ),
);

/**
 * Shipped steps that move rows between tables. The fallback runs them on a
 * private scratch copy before the name-matched copy; each one that throws is
 * reported and its rows are set aside instead.
 */
const STATE_FOLD_IN_STEPS = [
  { id: "v12-singleton-fold-in", run: migrateSingletonStateFoldInV12 },
  { id: "v13-json-canonical-rows", run: migrateJsonCanonicalWideRowsV13 },
] as const satisfies ReadonlyArray<{
  id: string;
  run: (db: DatabaseSync, fromVersion: number) => boolean;
}>;

function createStateSchema(db: DatabaseSync, sourceTables: ReadonlySet<string>): void {
  db.exec(
    getOpenClawStateRuntimeSchema({
      includeVersionLazyAdditiveTables: true,
      includeAgentDeletionJournal: true,
    }),
  );
  for (const table of sourceTables) {
    // First-use feature tables exist only where the feature already wrote.
    if (CANONICAL_TABLES.has(table)) {
      db.exec(getOpenClawStateFeatureSchemaSql(table));
    }
  }
}

function stampStateSchema(db: DatabaseSync): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
     VALUES ('primary', 'global', ?, NULL, ?, ?, ?)
     ON CONFLICT(meta_key) DO UPDATE SET role = 'global', schema_version = excluded.schema_version,
       agent_id = NULL, app_version = excluded.app_version, updated_at = excluded.updated_at`,
  ).run(OPENCLAW_STATE_SCHEMA_VERSION, VERSION, now, now);
  db.prepare(
    `INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)
     ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms`,
  ).run(CONTENT_VERSION_KEY, String(OPENCLAW_STATE_SCHEMA_VERSION), now);
}

export function createStateSwapTarget(): SqliteSwapTarget {
  return {
    label: "state",
    version: OPENCLAW_STATE_SCHEMA_VERSION,
    createSchema: createStateSchema,
    stamp: stampStateSchema,
    // Leases belong to processes that are gone once the old file is replaced.
    map: { ephemeral: new Set(["state_leases", "agent_database_leases"]) },
  };
}

/**
 * Generic rebuild of the shared state database. Row moves between tables run on a
 * private scratch copy first, so the source file is never written.
 */
export function buildStateDatabaseByCopy(
  sourcePath: string,
  outPath: string,
  scratchDir: string,
): { report: SqliteSwapReport; foldInFailures: string[] } {
  const { DatabaseSync } = requireNodeSqlite();
  const scratch = path.join(scratchDir, "state-fold-in.sqlite");
  copySqliteFile(sourcePath, scratch);
  const foldInFailures: string[] = [];
  try {
    const db = new DatabaseSync(scratch);
    try {
      const fromVersion = Number(
        (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      );
      db.exec("PRAGMA foreign_keys = OFF");
      normalizeSqliteText(db);
      for (const step of STATE_FOLD_IN_STEPS) {
        try {
          db.exec("SAVEPOINT fold_in");
          step.run(db, fromVersion);
          db.exec("RELEASE fold_in");
        } catch (error) {
          db.exec("ROLLBACK TO fold_in; RELEASE fold_in");
          foldInFailures.push(`${step.id}: ${(error as Error).message}`);
        }
      }
    } finally {
      db.close();
    }
    return { report: buildSqliteByCopy(createStateSwapTarget(), scratch, outPath), foldInFailures };
  } finally {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      fs.rmSync(`${scratch}${suffix}`, { force: true });
    }
  }
}
