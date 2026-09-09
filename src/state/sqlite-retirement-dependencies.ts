import type { DatabaseSync } from "node:sqlite";
import { quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";

type RetiredTable = "commitments" | "session_groups";

function assertNoRetiredStateForeignKeys(db: DatabaseSync, tableName: RetiredTable): void {
  const tables = db
    .prepare(
      `SELECT name
         FROM sqlite_schema
        WHERE type = 'table' AND name <> ?
        ORDER BY name`,
    )
    .all(tableName);
  for (const table of tables) {
    const foreignKeys = db
      .prepare(`PRAGMA foreign_key_list(${quoteSqliteIdentifier(String(table.name))})`)
      .all();
    if (
      foreignKeys.some(
        (foreignKey) =>
          typeof foreignKey.table === "string" && foreignKey.table.toLowerCase() === tableName,
      )
    ) {
      throw new Error(
        `Retired OpenClaw ${tableName} schema is referenced by table ${String(table.name)}; refusing destructive migration.`,
      );
    }
  }
}

function collectRetainedSchemaSql(db: DatabaseSync, tableName: RetiredTable): Map<string, string> {
  return new Map(
    db
      .prepare(
        `SELECT type, name, sql
             FROM sqlite_schema
            WHERE type IN ('trigger', 'view')
              AND tbl_name <> ?
              AND sql IS NOT NULL
            ORDER BY type, name`,
      )
      .all(tableName)
      .map((object) => [`${String(object.type)}:${String(object.name)}`, String(object.sql)]),
  );
}

export function assertNoRetiredStateTableDependencies(
  db: DatabaseSync,
  tableName: RetiredTable,
): void {
  assertNoRetiredStateForeignKeys(db, tableName);
  const probeTable = `__openclaw_retired_${tableName}_probe`;
  if (tableExists(db, probeTable)) {
    throw new Error(
      `OpenClaw state database already contains ${probeTable}; refusing destructive migration.`,
    );
  }
  const before = collectRetainedSchemaSql(db, tableName);
  const savepoint = `openclaw_probe_${tableName}_dependencies`;
  db.exec(`SAVEPOINT ${savepoint};`);
  let changedObject: string | undefined;
  try {
    db.exec(
      `ALTER TABLE ${quoteSqliteIdentifier(tableName)} RENAME TO ${quoteSqliteIdentifier(probeTable)};`,
    );
    const after = collectRetainedSchemaSql(db, tableName);
    changedObject = [...before].find(([object, sql]) => after.get(object) !== sql)?.[0];
  } catch (error) {
    db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint};`);
    // A broken retained object makes dependency resolution ambiguous. Refuse
    // rather than discard rows that object may still own indirectly.
    throw new Error(
      `Could not prove retained SQLite views and triggers independent of ${tableName}; refusing destructive migration.`,
      { cause: error },
    );
  }
  db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint};`);
  if (changedObject) {
    const [type, name] = changedObject.split(":", 2);
    throw new Error(
      `Retired OpenClaw ${tableName} schema is referenced by ${type} ${name}; refusing destructive migration.`,
    );
  }
}

export function assertRetainedVirtualTablesUsable(
  db: DatabaseSync,
  tableName: RetiredTable,
  phase: "before" | "after",
): void {
  const virtualTables = db
    .prepare(
      `SELECT name
         FROM sqlite_schema
        WHERE type = 'table' AND lower(sql) LIKE 'create virtual table%'
        ORDER BY name`,
    )
    .all();
  for (const table of virtualTables) {
    try {
      db.prepare(`SELECT * FROM ${quoteSqliteIdentifier(String(table.name))} LIMIT 1`).all();
    } catch (error) {
      throw new Error(
        `SQLite virtual table ${String(table.name)} is unusable ${phase} ${tableName} retirement.`,
        { cause: error },
      );
    }
  }
}
