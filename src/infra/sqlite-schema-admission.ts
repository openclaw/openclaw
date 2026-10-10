import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeWithCachedStatement } from "./kysely-sync-cache-state.js";
import type { SqliteDatabaseAdmissionKey } from "./sqlite-database-admission.js";
import { runSqliteSchemaReadSnapshotSync } from "./sqlite-pinned-read-snapshot.js";

export type SqliteSchemaFacts = {
  readonly admissionId: string;
  readonly revision: number;
  readonly userVersion: number;
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
    if (
      !value ||
      typeof value !== "object" ||
      !("admissionId" in value) ||
      typeof value.admissionId !== "string" ||
      !("revision" in value) ||
      typeof value.revision !== "number" ||
      !("userVersion" in value) ||
      typeof value.userVersion !== "number" ||
      !("schemaVersion" in value) ||
      typeof value.schemaVersion !== "number" ||
      !("tables" in value) ||
      !(value.tables instanceof Set) ||
      !("views" in value) ||
      !(value.views instanceof Set) ||
      ![...value.views].every((view) => typeof view === "string") ||
      !("tableSql" in value) ||
      !(value.tableSql instanceof Map) ||
      !("indexes" in value) ||
      !(value.indexes instanceof Set) ||
      !("indexDefinitions" in value) ||
      !(value.indexDefinitions instanceof Map) ||
      ![...value.indexDefinitions].every(
        ([name, index]) =>
          typeof name === "string" &&
          isRecord(index) &&
          typeof index.table === "string" &&
          (index.sql === null || typeof index.sql === "string"),
      ) ||
      !("triggers" in value) ||
      !(value.triggers instanceof Map)
    ) {
      return undefined;
    }
    return {
      admissionId: value.admissionId,
      revision: value.revision,
      userVersion: value.userVersion,
      schemaVersion: value.schemaVersion,
      tables: value.tables,
      views: value.views,
      tableSql: value.tableSql,
      indexes: value.indexes,
      indexDefinitions: value.indexDefinitions,
      triggers: value.triggers,
    };
  },
};

/** Capture the physical catalog once; native lifecycle owners publish the resulting facts. */
function captureSqliteSchemaFacts(
  database: DatabaseSync,
  revision: number,
  validateUserVersion?: (userVersion: number) => void,
): SqliteSchemaFacts {
  return runSqliteSchemaReadSnapshotSync(database, (schemaVersion) => {
    const version = executeWithCachedStatement(database, "PRAGMA user_version", [], (s) => s.get());
    const userVersion = Number(version?.user_version ?? 0);
    // Validate the captured header before catalog errors can mask its refusal.
    validateUserVersion?.(userVersion);
    const objects = executeWithCachedStatement(
      database,
      "SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE type IN ('table', 'view', 'index', 'trigger')",
      [],
      (s) => s.all(),
    );
    const tables = objects.filter((row) => row.type === "table");
    return {
      admissionId: randomUUID(),
      revision,
      userVersion,
      schemaVersion,
      tables: new Set(tables.flatMap((row) => (typeof row.name === "string" ? [row.name] : []))),
      views: new Set(
        objects.flatMap((row) =>
          row.type === "view" && typeof row.name === "string" ? [row.name] : [],
        ),
      ),
      tableSql: new Map(
        tables.flatMap((row) =>
          typeof row.name === "string"
            ? [[row.name, typeof row.sql === "string" ? row.sql : null] as const]
            : [],
        ),
      ),
      indexes: new Set(
        objects.flatMap((row) =>
          row.type === "index" && typeof row.name === "string" ? [row.name] : [],
        ),
      ),
      indexDefinitions: new Map(
        objects.flatMap((row) =>
          row.type === "index" && typeof row.name === "string" && typeof row.tbl_name === "string"
            ? [
                [
                  row.name,
                  { table: row.tbl_name, sql: typeof row.sql === "string" ? row.sql : null },
                ] as const,
              ]
            : [],
        ),
      ),
      triggers: new Map(
        objects.flatMap((row) =>
          row.type === "trigger" && typeof row.name === "string" && typeof row.tbl_name === "string"
            ? [
                [
                  row.name,
                  { table: row.tbl_name, sql: typeof row.sql === "string" ? row.sql : null },
                ] as const,
              ]
            : [],
        ),
      ),
    };
  });
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
