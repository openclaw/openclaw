// Migrates OpenClaw-owned SQLite tables to canonical STRICT schemas.
import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import {
  readGeneratedSqliteCatalog,
  readGeneratedSqliteFingerprint,
} from "../state/postgres-schema.generated/sqlite-catalogs.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import type { SqliteSchemaCatalog, SqliteSchemaSource } from "./sqlite-schema-catalog-types.js";
import { quoteSqliteIdentifier } from "./sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

type TableListRow = {
  name?: unknown;
  schema?: unknown;
  strict?: unknown;
  type?: unknown;
  wr?: unknown;
};

type TableColumnRow = {
  hidden?: unknown;
  name?: unknown;
  pk?: unknown;
  type?: unknown;
};

type SchemaObjectRow = {
  name?: unknown;
  sql?: unknown;
  tbl_name?: unknown;
  type?: unknown;
};

type PreservedSchemaObject = {
  name: string;
  sql: string;
  type: "index" | "trigger" | "view";
};

type CanonicalStrictTable = {
  columnTypes: Map<string, string>;
  columns: string[];
  createSql: string;
  name: string;
  uniqueConstraints: UniqueConstraint[];
  rowidAlias: string | null;
  rowidStorage: TableRowidStorage;
  usesAutoincrement: boolean;
};

type TableRowidStorage = "implicit" | "integer-primary-key" | "without-rowid";

type TableRowidModel = {
  alias: string | null;
  storage: TableRowidStorage;
};

type UniqueConstraint = {
  columns: string[];
  collations: string[];
  name: string;
  origin: "primary-key" | "unique";
};

type IndexListRow = {
  name?: unknown;
  origin?: unknown;
  partial?: unknown;
  unique?: unknown;
};

type IndexXInfoRow = {
  cid?: unknown;
  coll?: unknown;
  desc?: unknown;
  key?: unknown;
  name?: unknown;
  seqno?: unknown;
};

export type SqliteStrictMigrationOptions = {
  busyTimeoutMs?: number;
  databaseLabel?: string;
  /** The caller owns object creation; an already-STRICT fragment needs no DDL replay. */
  expectedSchema?: SqliteSchemaSource;
  integrityCheck?: "quick" | "full";
};

export type SqliteStrictMigrationResult = {
  migratedTables: string[];
};

const DEFAULT_STRICT_MIGRATION_BUSY_TIMEOUT_MS = 5_000;
const STRICT_MIGRATION_TABLE_PREFIX = "__openclaw_strict_migration_";
const SQLITE_ROWID_ALIASES = ["_rowid_", "rowid", "oid"] as const;

export function readMainTableList(
  db: DatabaseSync,
  options: { includeInternal?: boolean } = {},
): Array<TableListRow & { name: string }> {
  return (db.prepare("PRAGMA table_list").all() as TableListRow[]).filter(
    (row): row is TableListRow & { name: string } =>
      row.schema === "main" &&
      typeof row.name === "string" &&
      (options.includeInternal === true || !row.name.startsWith("sqlite_")),
  );
}

/** Canonical bootstrap needs no legacy rebuild when every ordinary table is already STRICT. */
export function hasNonStrictSqliteTables(db: DatabaseSync): boolean {
  return readMainTableList(db).some((row) => row.type === "table" && Number(row.strict) !== 1);
}

function readTableColumns(db: DatabaseSync, tableName: string): TableColumnRow[] {
  return db
    .prepare(`PRAGMA table_xinfo(${quoteSqliteIdentifier(tableName)})`)
    .all() as TableColumnRow[];
}

function readVisibleColumns(db: DatabaseSync, tableName: string): string[] {
  return readTableColumns(db, tableName)
    .filter((row) => Number(row.hidden ?? 0) === 0)
    .map((row) => {
      if (typeof row.name !== "string" || row.name.length === 0) {
        throw new Error(`SQLite table ${tableName} has an invalid column name`);
      }
      return row.name;
    });
}

function readTableRowidModel(
  db: DatabaseSync,
  tableName: string,
  tableRow: TableListRow,
): TableRowidModel {
  if (Number(tableRow.wr ?? 0) === 1) {
    return { alias: null, storage: "without-rowid" };
  }
  const columns = readTableColumns(db, tableName);
  const primaryKeyIndex = db
    .prepare(`SELECT 1 AS found FROM pragma_index_list(?) WHERE origin = 'pk' LIMIT 1`)
    .get(tableName);
  return resolveTableRowidModel(tableName, columns, Boolean(primaryKeyIndex));
}

function resolveTableRowidModel(
  tableName: string,
  columns: readonly TableColumnRow[],
  hasPrimaryKeyIndex: boolean,
): TableRowidModel {
  const primaryKeyColumns = columns.filter((column) => Number(column.pk ?? 0) > 0);
  const primaryKeyType = primaryKeyColumns[0]?.type;
  if (
    primaryKeyColumns.length === 1 &&
    typeof primaryKeyType === "string" &&
    primaryKeyType.toUpperCase() === "INTEGER" &&
    !hasPrimaryKeyIndex
  ) {
    return { alias: null, storage: "integer-primary-key" };
  }
  const declaredNames = new Set(
    columns.flatMap((column) =>
      typeof column.name === "string" ? [column.name.toLowerCase()] : [],
    ),
  );
  const alias = SQLITE_ROWID_ALIASES.find((candidate) => !declaredNames.has(candidate)) ?? null;
  if (!alias) {
    throw new Error(
      `SQLite table ${tableName} shadows every rowid alias; its implicit rowids cannot be migrated safely`,
    );
  }
  return { alias, storage: "implicit" };
}

function canonicalStrictTablesFromCatalog(catalog: SqliteSchemaCatalog): CanonicalStrictTable[] {
  return catalog.tables
    .map((table) => {
      if (table.sql === null) {
        throw new Error(`Canonical SQLite table ${table.name} has no CREATE statement`);
      }
      const rowidModel: TableRowidModel =
        table.withoutRowid === 1
          ? { alias: null, storage: "without-rowid" }
          : resolveTableRowidModel(
              table.name,
              table.columns,
              table.indexes.some((index) => index.origin === "pk"),
            );
      const columnTypes = new Map<string, string>();
      for (const column of table.columns) {
        if (
          column.hidden === 0 &&
          typeof column.name === "string" &&
          typeof column.type === "string"
        ) {
          columnTypes.set(column.name, column.type.toUpperCase());
        }
      }
      const result: CanonicalStrictTable = {
        columnTypes,
        columns: table.columns.filter((column) => column.hidden === 0).map((column) => column.name),
        createSql: table.sql,
        name: table.name,
        uniqueConstraints: [],
        rowidAlias: rowidModel.alias,
        rowidStorage: rowidModel.storage,
        usesAutoincrement: /\bAUTOINCREMENT\b/iu.test(table.sql),
      };
      return result;
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function readUniqueConstraints(db: DatabaseSync, table: CanonicalStrictTable): UniqueConstraint[] {
  const tableName = table.name;
  if (/\bON\s+CONFLICT\s+(IGNORE|REPLACE)\b/iu.test(table.createSql)) {
    return [];
  }
  const indexes = db
    .prepare(`PRAGMA index_list(${quoteSqliteIdentifier(tableName)})`)
    .all() as IndexListRow[]; // SAFETY: PRAGMA index_list row shape is stable across SQLite versions.
  const constraints: UniqueConstraint[] = [];
  for (const index of indexes) {
    if (Number(index.unique ?? 0) !== 1 || typeof index.name !== "string") {
      continue;
    }
    if (Number(index.partial ?? 0) === 1) {
      continue;
    }
    const terms = (
      db
        .prepare(`PRAGMA index_xinfo(${quoteSqliteIdentifier(index.name)})`)
        .all() as IndexXInfoRow[]
    ) // SAFETY: PRAGMA index_xinfo row shape is stable across SQLite versions.
      .toSorted((left, right) => Number(left.seqno ?? 0) - Number(right.seqno ?? 0));
    const columns: string[] = [];
    const collations: string[] = [];
    let hasExpressionTerm = false;
    let hasUnsupportedType = false;
    for (const term of terms) {
      if (Number(term.key ?? 0) !== 1) {
        continue;
      }
      if (typeof term.name !== "string") {
        hasExpressionTerm = true;
        break;
      }
      const declaredType = table.columnTypes.get(term.name);
      if (declaredType !== "TEXT" && declaredType !== "BLOB") {
        hasUnsupportedType = true;
        break;
      }
      columns.push(term.name);
      collations.push(typeof term.coll === "string" ? term.coll : "BINARY");
    }
    if (hasExpressionTerm || hasUnsupportedType || columns.length === 0) {
      continue;
    }
    constraints.push({
      columns,
      collations,
      name: index.name,
      origin: index.origin === "pk" ? "primary-key" : "unique",
    });
  }
  return constraints;
}

function readCanonicalStrictTables(schemaSql: string): CanonicalStrictTable[] {
  const canonical = openNodeSqliteDatabase(":memory:");
  try {
    canonical.exec(schemaSql);
    const tables = readMainTableList(canonical).filter((row) => row.type === "table");
    const nonStrict = tables.filter((row) => Number(row.strict ?? 0) !== 1).map((row) => row.name);
    if (nonStrict.length > 0) {
      throw new Error(
        `Canonical SQLite schema contains non-STRICT tables: ${nonStrict.toSorted().join(", ")}`,
      );
    }
    return tables
      .map((row) => {
        const tableName = row.name;
        const schemaRow = canonical
          .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(tableName) as { sql?: unknown } | undefined;
        if (typeof schemaRow?.sql !== "string") {
          throw new Error(`Canonical SQLite table ${tableName} has no CREATE statement`);
        }
        const rowidModel = readTableRowidModel(canonical, tableName, row);
        const visibleColumns = readTableColumns(canonical, tableName).filter(
          (column) => Number(column.hidden ?? 0) === 0,
        );
        const columnTypes = new Map<string, string>();
        for (const column of visibleColumns) {
          if (typeof column.name === "string" && typeof column.type === "string") {
            columnTypes.set(column.name, column.type.toUpperCase());
          }
        }
        const columnList = visibleColumns.map((column) => {
          if (typeof column.name !== "string" || column.name.length === 0) {
            throw new Error(`Canonical SQLite table ${tableName} has an invalid column name`);
          }
          return column.name;
        });
        const usesAutoincrement = /\bAUTOINCREMENT\b/iu.test(schemaRow.sql);
        const result: CanonicalStrictTable = {
          columnTypes,
          columns: columnList,
          createSql: schemaRow.sql,
          name: tableName,
          uniqueConstraints: [],
          rowidAlias: rowidModel.alias,
          rowidStorage: rowidModel.storage,
          usesAutoincrement,
        };
        result.uniqueConstraints = readUniqueConstraints(canonical, result);
        return result;
      })
      .toSorted((left, right) => left.name.localeCompare(right.name));
  } finally {
    canonical.close();
  }
}

function rewriteCreateTableName(createSql: string, replacementName: string): string {
  const openingParen = createSql.indexOf("(");
  if (openingParen === -1) {
    throw new Error("Canonical SQLite table CREATE statement has no column list");
  }
  return `CREATE TABLE ${quoteSqliteIdentifier(replacementName)} ${createSql.slice(openingParen)}`;
}

function readPreservedSchemaObjects(
  db: DatabaseSync,
  tableNames: ReadonlySet<string>,
): PreservedSchemaObject[] {
  return (
    db
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('index', 'trigger', 'view')",
      )
      .all() as SchemaObjectRow[]
  )
    .flatMap<PreservedSchemaObject>((row) => {
      if (
        (row.type !== "index" && row.type !== "trigger" && row.type !== "view") ||
        typeof row.name !== "string" ||
        typeof row.tbl_name !== "string" ||
        typeof row.sql !== "string" ||
        (row.type === "index" && !tableNames.has(row.tbl_name))
      ) {
        return [];
      }
      return [{ name: row.name, sql: row.sql, type: row.type }];
    })
    .toSorted((left, right) => {
      const typeOrder = { view: 0, index: 1, trigger: 2 } as const;
      return typeOrder[left.type] - typeOrder[right.type] || left.name.localeCompare(right.name);
    });
}

export function readAutoincrementHighWater(db: DatabaseSync, tableName: string): string | null {
  const sequenceTable = db
    .prepare(
      "SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_sequence'",
    )
    .get();
  if (!sequenceTable) {
    return null;
  }
  const row = db
    .prepare("SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name = ?")
    .get(tableName) as { seq?: unknown } | undefined;
  if (row === undefined) {
    return null;
  }
  const normalized = typeof row.seq === "string" ? /^(\d+)(?:\.0+)?$/u.exec(row.seq)?.[1] : null;
  if (!normalized) {
    throw new Error(
      `SQLite table ${tableName} has an invalid AUTOINCREMENT high-water mark (${typeof row.seq}: ${String(row.seq)})`,
    );
  }
  return normalized;
}

export function restoreAutoincrementHighWater(
  db: DatabaseSync,
  tableName: string,
  previousHighWater: string | null,
): void {
  if (previousHighWater === null) {
    return;
  }
  const currentHighWater = readAutoincrementHighWater(db, tableName);
  const restored =
    currentHighWater === null || BigInt(previousHighWater) > BigInt(currentHighWater)
      ? previousHighWater
      : currentHighWater;
  db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(tableName);
  db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, CAST(? AS INTEGER))").run(
    tableName,
    restored,
  );
}

function assertMatchingColumns(
  tableName: string,
  currentColumns: readonly string[],
  canonicalColumns: readonly string[],
): void {
  const current = new Set(currentColumns);
  const canonical = new Set(canonicalColumns);
  const missing = canonicalColumns.filter((column) => !current.has(column));
  const extra = currentColumns.filter((column) => !canonical.has(column));
  if (missing.length === 0 && extra.length === 0) {
    return;
  }
  const details = [
    missing.length > 0 ? `missing ${missing.join(", ")}` : "",
    extra.length > 0 ? `extra ${extra.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  throw new Error(`SQLite table ${tableName} does not match its canonical columns (${details})`);
}

function readForeignKeysEnabled(db: DatabaseSync): boolean {
  const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: unknown } | undefined;
  return Number(row?.foreign_keys ?? 0) === 1;
}

/** Temporarily relax foreign keys around synchronous staging work, outside a transaction. */
export function withSqliteForeignKeysDisabled<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) {
    throw new Error("SQLite foreign-key enforcement cannot change inside a transaction");
  }
  const enabled = readForeignKeysEnabled(db);
  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    const result = fn();
    if (isPromiseLike(result)) {
      throw new Error(
        "SQLite foreign-key scope must be synchronous; Promise returns are not supported",
      );
    }
    return result;
  } finally {
    db.exec(enabled ? "PRAGMA foreign_keys = ON;" : "PRAGMA foreign_keys = OFF;");
  }
}

/**
 * Rebuild canonical non-STRICT tables inside the caller's transaction.
 * Foreign-key enforcement must be disabled before BEGIN; integrity is checked
 * before this function returns so any bad row or relationship rolls back.
 */
export function migrateSqliteSchemaToStrictInTransaction(
  db: DatabaseSync,
  schemaSql: string,
  options: Pick<
    SqliteStrictMigrationOptions,
    "databaseLabel" | "expectedSchema" | "integrityCheck"
  > = {},
): SqliteStrictMigrationResult {
  if (!db.isTransaction) {
    throw new Error("SQLite STRICT schema migration requires an active transaction");
  }
  const expectedSchema = options.expectedSchema ?? schemaSql;
  const descriptor =
    typeof expectedSchema === "string" ? readGeneratedSqliteFingerprint(expectedSchema) : undefined;
  const expectedTableNames =
    descriptor?.tableNames ??
    (typeof expectedSchema === "string"
      ? undefined
      : expectedSchema.tables.map((table) => table.name));
  const readCurrentTables = () =>
    new Map(
      readMainTableList(db)
        .filter((row) => row.type === "table")
        .map((row) => [row.name, row]),
    );
  let currentTableRows =
    options.expectedSchema !== undefined && expectedTableNames
      ? readCurrentTables()
      : new Map<string, TableListRow & { name: string }>();
  if (
    options.expectedSchema !== undefined &&
    expectedTableNames?.every((name) => Number(currentTableRows.get(name)?.strict ?? 0) === 1)
  ) {
    return { migratedTables: [] };
  }
  const catalog =
    typeof expectedSchema === "string"
      ? descriptor && readGeneratedSqliteCatalog(expectedSchema)
      : expectedSchema;
  const generatedStrictSchema = catalog?.tables.every((table) => table.strict === 1);
  // Custom public SQL and schemas containing virtual tables retain the native
  // discovery path. Generated STRICT fragments need no scratch database.
  const canonicalTables =
    catalog && generatedStrictSchema
      ? canonicalStrictTablesFromCatalog(catalog)
      : readCanonicalStrictTables(schemaSql);
  if (
    options.expectedSchema === undefined ||
    !generatedStrictSchema ||
    canonicalTables.some((table) => !currentTableRows.has(table.name))
  ) {
    db.exec(schemaSql);
    currentTableRows = readCurrentTables();
  }
  const tablesToMigrate = canonicalTables.filter(
    (table) => Number(currentTableRows.get(table.name)?.strict ?? 0) !== 1,
  );
  if (tablesToMigrate.length === 0) {
    return { migratedTables: [] };
  }
  if (readForeignKeysEnabled(db)) {
    throw new Error("SQLite STRICT schema migration requires foreign_keys=OFF before BEGIN");
  }

  const names = new Set(tablesToMigrate.map((table) => table.name));
  const preservedObjects = readPreservedSchemaObjects(db, names);
  // SQLite reparses every trigger and view during ALTER TABLE. Temporarily
  // remove them so a referenced table can be absent between DROP and RENAME.
  for (const type of ["trigger", "view"] as const) {
    for (const object of preservedObjects) {
      if (object.type === type) {
        db.exec(`DROP ${type.toUpperCase()} ${quoteSqliteIdentifier(object.name)};`);
      }
    }
  }
  for (const [index, table] of tablesToMigrate.entries()) {
    const migrationTable = `${STRICT_MIGRATION_TABLE_PREFIX}${index}_${table.name}`;
    if (currentTableRows.has(migrationTable)) {
      throw new Error(`SQLite STRICT migration table already exists: ${migrationTable}`);
    }
    const currentColumns = readVisibleColumns(db, table.name);
    assertMatchingColumns(table.name, currentColumns, table.columns);
    const currentTableRow = currentTableRows.get(table.name);
    if (!currentTableRow) {
      throw new Error(`SQLite table ${table.name} disappeared during STRICT migration`);
    }
    const currentRowidModel = readTableRowidModel(db, table.name, currentTableRow);
    if (currentRowidModel.storage !== table.rowidStorage) {
      throw new Error(
        `SQLite table ${table.name} changes rowid storage from ${currentRowidModel.storage} to ${table.rowidStorage}; refusing an identity-changing STRICT migration`,
      );
    }
    const previousHighWater = table.usesAutoincrement
      ? readAutoincrementHighWater(db, table.name)
      : null;
    db.exec(rewriteCreateTableName(table.createSql, migrationTable));
    // Preflight every UNIQUE constraint (PRIMARY KEY, table-level UNIQUE,
    // CREATE UNIQUE INDEX) for normalized-key collisions. Legacy non-STRICT
    // tables allow BLOB and TEXT values to coexist as distinct keys; after
    // CAST they may collapse onto the same canonical row and surface as a
    // generic INSERT failure. Detecting the collision here yields a targeted
    // diagnosis with the constraint name and lets the operator resolve the
    // duplicate rows before retrying the upgrade. The migration transaction
    // remains the final enforcement.
    for (const constraint of table.uniqueConstraints) {
      const groupTerms = constraint.columns.map((column, termIndex) => {
        const quoted = quoteSqliteIdentifier(column);
        const declaredType = table.columnTypes.get(column);
        const converted =
          declaredType === "TEXT"
            ? `CAST(${quoted} AS TEXT)`
            : declaredType === "BLOB"
              ? `CAST(${quoted} AS BLOB)`
              : quoted;
        return `${converted} COLLATE ${constraint.collations[termIndex]}`;
      });
      const nonNullGuards = constraint.columns.map(
        (column) => `MIN(${quoteSqliteIdentifier(column)} IS NOT NULL) = 1`,
      );
      const collisionCount = db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM (` +
            `SELECT 1 FROM ${quoteSqliteIdentifier(table.name)} ` +
            `GROUP BY ${groupTerms.join(", ")} ` +
            `HAVING COUNT(*) > 1 AND ${nonNullGuards.join(" AND ")}` +
            `);`,
        )
        // SAFETY: COUNT aggregate always returns a numeric cnt column.
        .get() as { cnt?: unknown } | undefined;
      if (Number(collisionCount?.cnt ?? 0) > 0) {
        throw new Error(
          `SQLite table ${table.name} has ${String(collisionCount?.cnt)} ${constraint.origin} collision group(s) whose values would collide after CAST (constraint: ${constraint.name}); remove the duplicate rows manually before upgrading`,
        );
      }
    }
    const insertColumns = table.columns.map(quoteSqliteIdentifier);
    if (table.rowidAlias) {
      insertColumns.unshift(quoteSqliteIdentifier(table.rowidAlias));
    }
    const insertColumnList = insertColumns.join(", ");
    // Build SELECT expressions from the original column names so embedded
    // double quotes (e.g. a column named na"me) survive the type lookup.
    // Reconstructing the name from the quoted identifier via replaceAll
    // collapses "" back to ", losing the original name and skipping the CAST.
    const selectColumns: string[] = [];
    if (table.rowidAlias) {
      selectColumns.push(quoteSqliteIdentifier(table.rowidAlias));
    }
    for (const column of table.columns) {
      const quoted = quoteSqliteIdentifier(column);
      if (column === table.rowidAlias) {
        selectColumns.push(quoted);
        continue;
      }
      const declaredType = table.columnTypes.get(column);
      if (declaredType === "TEXT") {
        selectColumns.push(`CAST(${quoted} AS TEXT)`);
      } else if (declaredType === "BLOB") {
        selectColumns.push(`CAST(${quoted} AS BLOB)`);
      } else {
        selectColumns.push(quoted);
      }
    }
    const selectExpressions = selectColumns;
    try {
      db.exec(
        `INSERT INTO ${quoteSqliteIdentifier(migrationTable)} (${insertColumnList}) ` +
          `SELECT ${selectExpressions.join(", ")} FROM ${quoteSqliteIdentifier(table.name)};`,
      );
    } catch (error) {
      throw new Error(`Failed migrating SQLite table ${table.name} to STRICT`, { cause: error });
    }
    db.exec(`DROP TABLE ${quoteSqliteIdentifier(table.name)};`);
    db.exec(
      `ALTER TABLE ${quoteSqliteIdentifier(migrationTable)} RENAME TO ${quoteSqliteIdentifier(table.name)};`,
    );
    restoreAutoincrementHighWater(db, table.name, previousHighWater);
  }

  // Recreate canonical objects first, then retain any database-local indexes or
  // triggers that are not part of the checked-in schema.
  db.exec(schemaSql);
  const findObject = db.prepare(
    "SELECT 1 AS found FROM sqlite_schema WHERE type = ? AND name = ? LIMIT 1",
  );
  for (const object of preservedObjects) {
    if (!findObject.get(object.type, object.name)) {
      db.exec(object.sql);
    }
  }
  assertSqliteIntegrity(db, options.databaseLabel ?? "SQLite STRICT schema migration", {
    check: options.integrityCheck ?? "quick",
    tables: tablesToMigrate.map((table) => table.name),
  });
  return { migratedTables: tablesToMigrate.map((table) => table.name) };
}

/** Atomically upgrade OpenClaw-owned tables described by a canonical STRICT schema. */
export function migrateSqliteSchemaToStrict(
  db: DatabaseSync,
  schemaSql: string,
  options: SqliteStrictMigrationOptions = {},
): SqliteStrictMigrationResult {
  if (db.isTransaction) {
    throw new Error("SQLite STRICT schema migration cannot start inside a transaction");
  }
  const foreignKeysWereEnabled = readForeignKeysEnabled(db);
  if (foreignKeysWereEnabled) {
    db.exec("PRAGMA foreign_keys = OFF;");
  }
  try {
    return runSqliteImmediateTransactionSync(
      db,
      () => migrateSqliteSchemaToStrictInTransaction(db, schemaSql, options),
      {
        busyTimeoutMs: options.busyTimeoutMs ?? DEFAULT_STRICT_MIGRATION_BUSY_TIMEOUT_MS,
        databaseLabel: options.databaseLabel,
        operationLabel: "sqlite.strict-schema-migration",
      },
    );
  } finally {
    if (foreignKeysWereEnabled) {
      db.exec("PRAGMA foreign_keys = ON;");
    }
  }
}
