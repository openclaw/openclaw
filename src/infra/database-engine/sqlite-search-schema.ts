import type { DatabaseSync } from "node:sqlite";
import type { SqliteSchemaCatalog } from "../sqlite-schema-catalog-types.js";
import { createSqliteTableContractReader } from "../sqlite-schema-catalog.js";
import { normalizeSchemaSql } from "../sqlite-schema-sql.js";
import type { SearchSchema } from "./contract.js";
import {
  buildSqliteMemoryBodyFtsSchema,
  buildSqliteMemoryPathFtsSchema,
  matchesSqliteMemorySearchFragment,
} from "./sqlite-memory-search-fragments.js";

export const MEMORY_INDEX_SOURCES_TABLE = "memory_index_sources";
export const MEMORY_INDEX_CHUNKS_TABLE = "memory_index_chunks";
export const MEMORY_INDEX_FTS_TABLE = "memory_index_chunks_fts";
export const MEMORY_INDEX_PATHS_FTS_TABLE = "memory_index_paths_fts";

type FtsTableSchemaStatus = "missing" | "matching" | "mismatched" | "not-fts";
type SearchSchemaObject = { type: string; name: string; sql: string | null };

/** One catalog read covers both optional indexes and their maintenance triggers. */
function inspectMemoryFts(
  db: DatabaseSync,
  tableNames: string[],
  tokenizer: "unicode61" | "trigram",
) {
  const names = [
    ...tableNames,
    ...MEMORY_CHUNK_FTS_TRIGGER_DEFINITIONS.map(({ name }) => name),
    ...MEMORY_PATH_FTS_TRIGGER_DEFINITIONS.map(({ name }) => name),
  ];
  const rows = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_schema WHERE name COLLATE NOCASE IN (${names.map(() => "?").join(", ")})`,
    )
    // SAFETY: SQLite owns these catalog columns. Names are bound, including deprecated custom names.
    .all(...names) as SearchSchemaObject[];
  const objects = new Map(rows.map((row) => [row.name.toLowerCase(), row]));
  let catalog: SqliteSchemaCatalog | undefined;
  const tableStatus = (tableName: string): FtsTableSchemaStatus => {
    const row = objects.get(tableName.toLowerCase());
    if (row?.type === "view") {
      throw new Error(`cannot modify ${tableName} because it is a view`);
    }
    if (!row?.sql) {
      return "missing";
    }
    if (!/^CREATE VIRTUAL TABLE\b/iu.test(row.sql) || !/\bUSING\s+fts5\s*\(/iu.test(row.sql)) {
      return "not-fts";
    }
    catalog ??= createSqliteTableContractReader(db).readCatalog([], tableNames);
    return matchesSqliteMemorySearchFragment(catalog, {
      kind: tableName === MEMORY_INDEX_PATHS_FTS_TABLE ? "path-fts" : "body-fts",
      tableName,
      tokenizer,
    })
      ? "matching"
      : "mismatched";
  };
  return { objects, tableStatus };
}

/** Remove only derived FTS state whose persisted schema no longer matches. */
function dropMismatchedFtsTable(
  db: DatabaseSync,
  tableName: string,
  status: FtsTableSchemaStatus,
): void {
  if (status === "missing" || status === "matching") {
    return;
  }
  // Custom names never establish ownership of an ordinary table containing user data.
  if (
    status === "not-fts" &&
    tableName !== MEMORY_INDEX_FTS_TABLE &&
    tableName !== MEMORY_INDEX_PATHS_FTS_TABLE
  ) {
    throw new Error(`Memory FTS table "${tableName}" collides with a non-FTS table`);
  }
  if (tableName === MEMORY_INDEX_PATHS_FTS_TABLE) {
    dropMemoryPathFtsTriggers(db);
  }
  if (tableName === MEMORY_INDEX_FTS_TABLE) {
    dropMemoryChunkFtsTriggers(db);
  }
  db.exec(`DROP TABLE ${tableName}`);
}

function buildMemoryFtsTriggers<
  Name extends string,
  Table extends string,
  Columns extends string,
  Insert extends string,
  Delete extends string,
>(name: Name, table: Table, columns: Columns, insert: Insert, remove: Delete) {
  const trigger = <Event extends string, Clause extends string, Body extends string>(
    event: Event,
    clause: Clause,
    body: Body,
  ) =>
    ({
      name: `${name}_after_${event}`,
      sql: `
      CREATE TRIGGER IF NOT EXISTS main.${name}_after_${event}
      AFTER ${clause} ON ${table}
      BEGIN
${body}
      END;
    `,
    }) as const;
  return [
    trigger("insert", "INSERT", insert),
    trigger(
      "update",
      `UPDATE OF ${columns}`,
      `${remove}
${insert}`,
    ),
    trigger("delete", "DELETE", remove),
  ] as const;
}

/** Optional canonical triggers owned by the derived path FTS index. */
export const MEMORY_PATH_FTS_TRIGGER_DEFINITIONS = buildMemoryFtsTriggers(
  MEMORY_INDEX_PATHS_FTS_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  "id, path, source",
  `        INSERT INTO ${MEMORY_INDEX_PATHS_FTS_TABLE} (rowid, path, source)
        VALUES (NEW.id, NEW.path, NEW.source);`,
  `        DELETE FROM ${MEMORY_INDEX_PATHS_FTS_TABLE}
        WHERE rowid = OLD.id;`,
);

/** Canonical chunks own the optional body index; every mutation addresses its rowid. */
export const MEMORY_CHUNK_FTS_TRIGGER_DEFINITIONS = buildMemoryFtsTriggers(
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_CHUNKS_TABLE,
  "chunk_rowid, text, id, path, source, model, start_line, end_line",
  `        INSERT INTO ${MEMORY_INDEX_FTS_TABLE} (rowid, text, id, path, source, model, start_line, end_line)
        VALUES (NEW.chunk_rowid, NEW.text, NEW.id, NEW.path, NEW.source, NEW.model, NEW.start_line, NEW.end_line);`,
  `        DELETE FROM ${MEMORY_INDEX_FTS_TABLE} WHERE rowid = OLD.chunk_rowid;`,
);

export function dropMemoryChunkFtsTriggers(db: DatabaseSync): void {
  for (const trigger of MEMORY_CHUNK_FTS_TRIGGER_DEFINITIONS) {
    db.exec(`DROP TRIGGER IF EXISTS main.${trigger.name}`);
  }
}

export function ensureMemoryChunkFtsTriggers(db: DatabaseSync): void {
  for (const trigger of MEMORY_CHUNK_FTS_TRIGGER_DEFINITIONS) {
    db.exec(trigger.sql);
  }
}

export function rebuildMemoryChunkFts(
  db: DatabaseSync,
  ftsTable: string,
  options: { fresh?: boolean } = {},
): void {
  if (!options.fresh) {
    db.exec(`DELETE FROM ${ftsTable}`);
  }
  db.exec(`
    INSERT INTO ${ftsTable} (
      rowid, text, id, path, source, model, start_line, end_line
    )
    SELECT chunk_rowid, text, id, path, source, model, start_line, end_line
    FROM ${MEMORY_INDEX_CHUNKS_TABLE};
  `);
}

export function reconcileMemoryChunkFtsRows(
  db: DatabaseSync,
  ftsTable: string,
  force = false,
): void {
  // Admitted body FTS DDL keeps the default columnsize=1, so FTS5 stores one %_docsize row per
  // document; counting it returns COUNT(*) of the FTS table without a full scan of %_content.
  const rowCounts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM ${MEMORY_INDEX_CHUNKS_TABLE}) AS canonical_count,
         (SELECT COUNT(*) FROM ${ftsTable}_docsize) AS derived_count`,
    )
    // SAFETY: both scalar aggregate subqueries always return their named numeric columns.
    .get() as { canonical_count: number; derived_count: number };
  if (force || rowCounts.canonical_count !== rowCounts.derived_count) {
    rebuildMemoryChunkFts(db, ftsTable);
  }
}

export function backfillMemoryPathFtsRows(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO ${MEMORY_INDEX_PATHS_FTS_TABLE} (rowid, path, source)
    SELECT id, path, source
    FROM ${MEMORY_INDEX_SOURCES_TABLE}
    WHERE NOT EXISTS (SELECT 1 FROM ${MEMORY_INDEX_PATHS_FTS_TABLE} LIMIT 1);
  `);
}

/** Admit memory's portable declaration and bind its engine-owned derived table names. */
export function admitSqliteMemoryTextSearch(
  db: DatabaseSync,
  definition: SearchSchema,
  options: { fresh?: true } = {},
): SearchSchema {
  const body = definition.text!.body!;
  const ftsTable =
    definition.text!.paths && body.table === MEMORY_INDEX_CHUNKS_TABLE
      ? MEMORY_INDEX_FTS_TABLE
      : body.table;
  // The portable declarations are already persisted on PostgreSQL; retain their exact shape.
  const tokenizer = body.postgres?.mode === "trigram" ? "trigram" : "unicode61";
  if (ftsTable.toLowerCase() === MEMORY_INDEX_PATHS_FTS_TABLE.toLowerCase()) {
    throw new Error(`Memory body FTS table "${ftsTable}" collides with the path FTS index`);
  }
  const canonical = ftsTable === MEMORY_INDEX_FTS_TABLE;
  const tables = canonical ? [ftsTable, MEMORY_INDEX_PATHS_FTS_TABLE] : [ftsTable];
  const existing = options.fresh ? undefined : inspectMemoryFts(db, tables, tokenizer);
  // Read before mutation so both fragments share one native catalog snapshot.
  const bodyStatus = existing?.tableStatus(ftsTable) ?? "missing";
  const pathStatus = canonical
    ? (existing?.tableStatus(MEMORY_INDEX_PATHS_FTS_TABLE) ?? "missing")
    : undefined;
  const matchingTrigger = (trigger: { name: string; sql: string }) =>
    normalizeSchemaSql(existing?.objects.get(trigger.name)?.sql ?? null) ===
    normalizeSchemaSql(trigger.sql.replace(`main.${trigger.name}`, trigger.name));
  const bodyTriggersMatch =
    !canonical || MEMORY_CHUNK_FTS_TRIGGER_DEFINITIONS.every(matchingTrigger);
  const pathTriggersMatch = canonical && MEMORY_PATH_FTS_TRIGGER_DEFINITIONS.every(matchingTrigger);

  db.exec("SAVEPOINT ensure_memory_search");
  try {
    dropMismatchedFtsTable(db, ftsTable, bodyStatus);
    if (bodyStatus !== "matching") {
      db.exec(buildSqliteMemoryBodyFtsSchema({ tableName: ftsTable, tokenizer }));
    }
    // Installing rowid maintenance owns the one-time rebuild of pre-rowid indexes.
    if (!options.fresh) {
      reconcileMemoryChunkFtsRows(db, ftsTable, !bodyTriggersMatch);
    }
    if (canonical && (bodyStatus !== "matching" || !bodyTriggersMatch)) {
      if (bodyStatus === "matching") {
        dropMemoryChunkFtsTriggers(db);
      }
      ensureMemoryChunkFtsTriggers(db);
    }
    if (canonical) {
      dropMismatchedFtsTable(db, MEMORY_INDEX_PATHS_FTS_TABLE, pathStatus!);
      if (pathStatus !== "matching") {
        db.exec(buildSqliteMemoryPathFtsSchema({ tokenizer }));
      }
      if (!options.fresh) {
        backfillMemoryPathFtsRows(db);
      }
      if (pathStatus !== "matching" || !pathTriggersMatch) {
        if (pathStatus === "matching") {
          dropMemoryPathFtsTriggers(db);
        }
        ensureMemoryPathFtsTriggers(db);
      }
    }
    db.exec("RELEASE ensure_memory_search");
  } catch (err) {
    db.exec("ROLLBACK TO ensure_memory_search");
    db.exec("RELEASE ensure_memory_search");
    throw err;
  }
  return {
    ...definition,
    text: {
      body: { ...body, table: ftsTable },
      ...(canonical
        ? { paths: { ...definition.text!.paths!, table: MEMORY_INDEX_PATHS_FTS_TABLE } }
        : {}),
    },
  };
}

export function dropDisabledMemoryFts(db: DatabaseSync, ftsTable: string, enabled: boolean): void {
  if (enabled) {
    return;
  }

  // Path triggers must disappear before their derived table so canonical
  // source writes stay independent of the selected body FTS table.
  dropMemoryPathFtsTriggers(db);
  db.exec(`DROP TABLE IF EXISTS ${MEMORY_INDEX_PATHS_FTS_TABLE}`);

  if (ftsTable === MEMORY_INDEX_FTS_TABLE) {
    dropMemoryChunkFtsTriggers(db);
    db.exec(`DROP TABLE IF EXISTS ${ftsTable}`);
  }
}

/** Drop the canonical source-to-path-FTS maintenance triggers. */
export function dropMemoryPathFtsTriggers(db: DatabaseSync): void {
  for (const trigger of MEMORY_PATH_FTS_TRIGGER_DEFINITIONS) {
    db.exec(`DROP TRIGGER IF EXISTS main.${trigger.name}`);
  }
}

/** Install the canonical source-to-path-FTS maintenance triggers. */
export function ensureMemoryPathFtsTriggers(db: DatabaseSync): void {
  // The named integer source identity survives VACUUM and gives every
  // FTS update/delete a direct rowid lookup instead of a virtual-table scan.
  for (const trigger of MEMORY_PATH_FTS_TRIGGER_DEFINITIONS) {
    db.exec(trigger.sql);
  }
}
