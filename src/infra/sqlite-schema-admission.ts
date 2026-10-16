import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeWithCachedStatement } from "./kysely-sync-cache-state.js";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "./sqlite-database-admission.js";
import { runSqliteSchemaReadSnapshotSync } from "./sqlite-pinned-read-snapshot.js";

export type SqliteSchemaFacts = {
  readonly admissionId: string;
  readonly revision: number;
  readonly userVersion: number;
  readonly textEncoding: string;
  readonly schemaVersion: number;
  readonly tables: ReadonlySet<string>;
  readonly views: ReadonlySet<string>;
  readonly tableSql: ReadonlyMap<string, string | null>;
  readonly indexes: ReadonlySet<string>;
  readonly indexDefinitions: ReadonlyMap<string, { table: string; sql: string | null }>;
  readonly triggers: ReadonlyMap<string, { table: string; sql: string | null }>;
};

export const schemaAdmission: SqliteDatabaseAdmissionKey<SqliteSchemaFacts> = {
  name: "sqlite-schema",
  schemaDependent: true,
  read: (value) => {
    // SAFETY: Only the typed SQLite catalog owner publishes this private fact key.
    return isRecord(value) ? (value as SqliteSchemaFacts) : undefined;
  },
};

const textEncodingAdmission: SqliteDatabaseAdmissionKey<string> = {
  name: "sqlite-text-encoding",
  read: (value) => (typeof value === "string" ? value : undefined),
};

/** Native metadata read shared by admission and pre-admission migrations. */
export function readSqliteTextEncoding(database: DatabaseSync): string {
  const retained = getSqliteDatabaseAdmission(database, textEncodingAdmission);
  if (retained !== undefined) {
    return retained;
  }
  const encoding = executeWithCachedStatement(database, "PRAGMA encoding", [], (s) => s.get());
  if (typeof encoding?.encoding !== "string") {
    throw new Error("SQLite did not report its text encoding");
  }
  return encoding.encoding;
}

/** Capture the physical catalog for admission or pre-admission schema maintenance. */
export function captureSqliteSchemaFacts(
  database: DatabaseSync,
  revision = 0,
  validateUserVersion?: (userVersion: number) => void,
): SqliteSchemaFacts {
  const retainedTextEncoding = getSqliteDatabaseAdmission(database, textEncodingAdmission);
  const captured = runSqliteSchemaReadSnapshotSync(database, (schemaVersion) => {
    const version = executeWithCachedStatement(database, "PRAGMA user_version", [], (s) => s.get());
    const userVersion = Number(version?.user_version ?? 0);
    // Validate the captured header before catalog errors can mask its refusal.
    validateUserVersion?.(userVersion);
    const textEncoding = retainedTextEncoding ?? readSqliteTextEncoding(database);
    const objects = executeWithCachedStatement(
      database,
      "SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE type IN ('table', 'view', 'index', 'trigger')",
      [],
      (s) => s.all(),
    );
    const facts = {
      admissionId: randomUUID(),
      revision,
      userVersion,
      textEncoding,
      schemaVersion,
      tables: new Set<string>(),
      views: new Set<string>(),
      tableSql: new Map<string, string | null>(),
      indexes: new Set<string>(),
      indexDefinitions: new Map<string, { table: string; sql: string | null }>(),
      triggers: new Map<string, { table: string; sql: string | null }>(),
    };
    for (const row of objects) {
      if (typeof row.name !== "string") {
        continue;
      }
      const sql = typeof row.sql === "string" ? row.sql : null;
      switch (row.type) {
        case "table":
          facts.tables.add(row.name);
          facts.tableSql.set(row.name, sql);
          break;
        case "view":
          facts.views.add(row.name);
          break;
        case "index":
          facts.indexes.add(row.name);
          if (typeof row.tbl_name === "string") {
            facts.indexDefinitions.set(row.name, { table: row.tbl_name, sql });
          }
          break;
        case "trigger":
          if (typeof row.tbl_name === "string") {
            facts.triggers.set(row.name, { table: row.tbl_name, sql });
          }
          break;
        default:
          break;
      }
    }
    return facts;
  });
  // SQLite may still change an empty database's encoding before its first schema object.
  if (retainedTextEncoding === undefined && (captured.tables.size > 0 || captured.views.size > 0)) {
    publishSqliteDatabaseAdmission(database, textEncodingAdmission, captured.textEncoding);
  }
  return captured;
}

export function captureTrackedSqliteSchemaFacts(
  database: DatabaseSync,
  owner: { revision: number; capturing: boolean },
  validateUserVersion?: (userVersion: number) => void,
): SqliteSchemaFacts {
  owner.capturing = true;
  try {
    return captureSqliteSchemaFacts(database, owner.revision, validateUserVersion);
  } finally {
    owner.capturing = false;
  }
}

export function invalidateTrackedSqliteSchemaFacts(owner: {
  revision: number;
  facts?: SqliteSchemaFacts;
}): void {
  owner.revision += 1;
  owner.facts = undefined;
}
