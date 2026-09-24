import type { DatabaseSync } from "node:sqlite";
import { executeWithCachedStatement } from "./kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runSqlitePinnedReadSnapshotSync } from "./sqlite-pinned-read-snapshot.js";
import {
  createSqliteIndexContract,
  createSqliteTableContract,
  type SqliteIndexContract,
  type SqliteIndexListRow,
  type SqliteIndexTermRow,
  type SqliteSchemaRow,
  type SqliteTableContract,
  type SqliteTableDefinition,
  type SqliteTableListRow,
} from "./sqlite-schema-contract-assembly.js";
import {
  createSqliteSchemaIssue,
  legacySqliteSchemaIssueMessages,
  throwSqliteSchemaMismatches,
  type SqliteSchemaCompatibility,
  type SqliteSchemaIssue,
  type SqliteSchemaIssueCode,
} from "./sqlite-schema-issues.js";
import {
  normalizeSchemaSql,
  normalizeSqlIdentifier,
  normalizeSqlWhitespace,
  quoteSqliteIdentifier,
  readSqlToken,
} from "./sqlite-schema-sql.js";

export type { SqliteSchemaCompatibility, SqliteSchemaIssue } from "./sqlite-schema-issues.js";

type SqliteSchemaContract = Map<string, SqliteTableContract>;

export type SqliteTableContractReader = (tableName: string) => SqliteTableContract | undefined;

export type CanonicalSqliteNamedIndexContract = {
  definition: string;
  fingerprint: SqliteIndexContract;
  name: string;
  tableName: string;
  unique: boolean;
};

const schemaContractCache = new Map<string, SqliteSchemaContract>();

/** Reuse actual table facts only within one unchanged read transaction on this connection. */
export function createSqliteTableContractReader(database: DatabaseSync): SqliteTableContractReader {
  const tables = new Map<string, SqliteTableContract | undefined>();
  return (tableName) => {
    if (!tables.has(tableName)) {
      tables.set(tableName, collectSqliteTableContract(database, tableName));
    }
    return tables.get(tableName);
  };
}

/**
 * Require every object from one committed schema while allowing unrelated
 * tables and indexes that do not replace a canonical object.
 */
export function assertSqliteSchemaContains(
  database: DatabaseSync,
  databaseLabel: string,
  schemaSql: string,
  compatibility: SqliteSchemaCompatibility = {},
  readTable?: SqliteTableContractReader,
): void {
  const issues = collectSqliteSchemaIssues(database, schemaSql, compatibility, readTable);
  if (issues.length > 0) {
    throwSqliteSchemaMismatches(databaseLabel, legacySqliteSchemaIssueMessages(issues));
  }
}

/** Collect stable, machine-readable differences from one committed schema. */
export function collectSqliteSchemaIssues(
  database: DatabaseSync,
  schemaSql: string,
  compatibility: SqliteSchemaCompatibility = {},
  readTable?: SqliteTableContractReader,
): SqliteSchemaIssue[] {
  return runSqlitePinnedReadSnapshotSync(database, () =>
    collectSqliteSchemaIssuesInSnapshot(database, schemaSql, compatibility, readTable),
  );
}

function collectSqliteSchemaIssuesInSnapshot(
  database: DatabaseSync,
  schemaSql: string,
  compatibility: SqliteSchemaCompatibility,
  readTable: SqliteTableContractReader | undefined,
): SqliteSchemaIssue[] {
  const expected = getSqliteSchemaContract(schemaSql);
  const allowedMissingTables = new Set(compatibility.allowedMissingTables ?? []);
  const allowedMissingIndexes = new Set(compatibility.allowedMissingIndexes ?? []);

  const issues: SqliteSchemaIssue[] = [];
  const add = (code: SqliteSchemaIssueCode, objectName: string, message?: string) => {
    issues.push(createSqliteSchemaIssue(code, objectName, message));
  };
  for (const [tableName, expectedTable] of expected) {
    const actualTable = readTable
      ? readTable(tableName)
      : collectSqliteTableContract(database, tableName);
    if (!actualTable) {
      if (allowedMissingTables.has(tableName)) {
        continue;
      }
      add("missing-table", tableName);
      continue;
    }

    issues.push(
      ...compareTableDefinitions(
        tableName,
        actualTable.definition,
        expectedTable.definition,
        compatibility,
        !allowedMissingTables.has(tableName),
      ),
    );
    const actualIndexFingerprints = new Set(
      actualTable.indexes.map((index) => JSON.stringify(index)),
    );
    const expectedIndexFingerprints = new Set<string>();
    for (const expectedIndex of expectedTable.indexes) {
      const fingerprint = JSON.stringify(expectedIndex);
      expectedIndexFingerprints.add(fingerprint);
      if (!actualIndexFingerprints.has(fingerprint)) {
        const objectName = expectedIndex.name ?? tableName;
        // Index names are schema-wide and case-insensitive, including on other tables.
        if (
          expectedIndex.name &&
          allowedMissingIndexes.has(expectedIndex.name) &&
          !database
            .prepare(
              "SELECT 1 FROM main.sqlite_schema WHERE type = 'index' AND name = ? COLLATE NOCASE LIMIT 1",
            )
            .get(expectedIndex.name)
        ) {
          continue;
        }
        add(
          "missing-or-drifted-index",
          objectName,
          `missing or drifted index ${expectedIndex.name ?? `on ${tableName}`}`,
        );
      }
    }
    for (const actualIndex of actualTable.indexes) {
      if (actualIndex.unique === 1 && !expectedIndexFingerprints.has(JSON.stringify(actualIndex))) {
        const objectName = actualIndex.name ?? tableName;
        add(
          "unexpected-unique-index",
          objectName,
          `unexpected unique index ${actualIndex.name ?? `on ${tableName}`}`,
        );
      }
    }
    const optionalCanonicalTriggerGroups = collectOptionalCanonicalTriggerGroups(
      database,
      compatibility,
      tableName,
    );
    const optionalCanonicalTriggers = optionalCanonicalTriggerGroups.flatMap(
      (group) => group.triggers,
    );
    const allowedMissingCanonicalTriggers = optionalCanonicalTriggerGroups
      .filter((group) => group.optional)
      .flatMap((group) => group.triggers);
    for (const expectedTrigger of expectedTable.triggers) {
      if (
        allowedMissingCanonicalTriggers.some(
          (canonicalTrigger) => canonicalTrigger.name === expectedTrigger.name,
        )
      ) {
        continue;
      }
      if (
        !actualTable.triggers.some((actualTrigger) =>
          isEqualTrigger(actualTrigger, expectedTrigger),
        )
      ) {
        add("missing-or-drifted-trigger", expectedTrigger.name);
      }
    }
    for (const triggerGroup of optionalCanonicalTriggerGroups) {
      const isPresent = actualTable.triggers.some((actualTrigger) =>
        triggerGroup.triggers.some(
          (canonicalTrigger) => actualTrigger.name === canonicalTrigger.name,
        ),
      );
      if (triggerGroup.optional && !isPresent) {
        continue;
      }
      for (const canonicalTrigger of triggerGroup.triggers) {
        if (
          !actualTable.triggers.some((actualTrigger) =>
            isEqualTrigger(actualTrigger, canonicalTrigger),
          )
        ) {
          add("missing-or-drifted-trigger", canonicalTrigger.name);
        }
      }
    }
    for (const actualTrigger of actualTable.triggers) {
      if (
        !expectedTable.triggers.some((expectedTrigger) =>
          isEqualTrigger(actualTrigger, expectedTrigger),
        ) &&
        !optionalCanonicalTriggers.some((canonicalTrigger) =>
          isEqualTrigger(actualTrigger, canonicalTrigger),
        )
      ) {
        add("unexpected-trigger", actualTrigger.name);
      }
    }
    if (actualTable.virtualTableSql !== expectedTable.virtualTableSql) {
      add("virtual-table-definition-drift", tableName);
    }
    if (
      actualTable.strict !== expectedTable.strict ||
      actualTable.withoutRowid !== expectedTable.withoutRowid
    ) {
      add("table-options-drift", tableName);
    }
  }
  return issues;
}

/** Require stable canonical tables before a version-specific additive migration. */
export function assertSqliteSchemaTablesPresent(
  database: DatabaseSync,
  databaseLabel: string,
  schemaSql: string,
  options: { allowedMissingTables?: readonly string[] } = {},
): void {
  const allowedMissingTables = new Set(options.allowedMissingTables ?? []);
  const requiredTables = getCanonicalSqliteTableNames(schemaSql).filter(
    (tableName) => !allowedMissingTables.has(tableName),
  );
  const missingTables: string[] = [];
  // Bound name parameters without limiting the schema; ordinals never come from catalog rows.
  const batchSize = 500;
  for (let offset = 0; offset < requiredTables.length; offset += batchSize) {
    const tables = requiredTables.slice(offset, offset + batchSize);
    const expected = tables.map((_table, ordinal) => `(${ordinal}, ?)`).join(", ");
    const present = database
      .prepare(
        `WITH expected(ordinal, name) AS (VALUES ${expected})
         SELECT ordinal FROM expected
         WHERE EXISTS (
           SELECT 1 FROM main.sqlite_schema
           WHERE type = 'table' AND name = expected.name LIMIT 1
         )`,
      )
      .all(...tables);
    const presentOrdinals = new Set(present.map((row) => row.ordinal));
    for (const [ordinal, tableName] of tables.entries()) {
      if (!presentOrdinals.has(ordinal)) {
        missingTables.push(`missing table ${tableName}`);
      }
    }
  }
  if (missingTables.length > 0) {
    throwSqliteSchemaMismatches(databaseLabel, missingTables);
  }
}

/** Return every explicit named index owned by one committed schema. */
export function getCanonicalSqliteNamedIndexContracts(
  schemaSql: string,
): CanonicalSqliteNamedIndexContract[] {
  const schema = getSqliteSchemaContract(schemaSql);
  const indexes: CanonicalSqliteNamedIndexContract[] = [];
  for (const [tableName, table] of schema) {
    for (const fingerprint of table.indexes) {
      if (fingerprint.name === null || fingerprint.sql === null || fingerprint.origin !== "c") {
        continue;
      }
      indexes.push({
        definition: readCanonicalIndexDefinition(fingerprint),
        fingerprint,
        name: fingerprint.name,
        tableName,
        unique: fingerprint.unique === 1,
      });
    }
  }
  return indexes;
}

/** Return every table owned by one committed schema. */
export function getCanonicalSqliteTableNames(schemaSql: string): string[] {
  return [...getSqliteSchemaContract(schemaSql).keys()];
}

/** Inspect one explicit main-schema index using the canonical schema fingerprint shape. */
export function collectSqliteNamedIndexContract(
  database: DatabaseSync,
  indexName: string,
): SqliteIndexContract | undefined {
  // Authorize the original catalog columns even when the index is absent.
  const row = database
    .prepare(`
      SELECT tbl_name FROM (
        SELECT name, sql, tbl_name FROM main.sqlite_schema WHERE type = 'index' AND name = ?
      )
    `)
    .get(indexName);
  if (!row || typeof row.tbl_name !== "string") {
    return undefined;
  }
  const index = (
    database.prepare(`PRAGMA main.index_list(${quoteSqliteIdentifier(row.tbl_name)})`).all() as
      | SqliteIndexListRow[]
      | undefined
  )?.find((candidate) => candidate.name === indexName);
  return index ? collectSqliteIndexContract(database, index) : undefined;
}

function collectOptionalCanonicalTriggerGroups(
  database: DatabaseSync,
  compatibility: SqliteSchemaCompatibility,
  tableName: string,
): Array<{
  optional: boolean;
  triggers: Array<{ name: string; sql: string | null }>;
}> {
  return (compatibility.optionalCanonicalTriggerGroups ?? [])
    .filter((group) => group.tableName === tableName)
    .map((group) => ({
      optional:
        !group.optionalWhenTableMissing ||
        !database
          .prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1")
          .get(group.optionalWhenTableMissing),
      triggers: group.triggers.map((trigger) => ({
        name: trigger.name,
        sql: normalizeOptionalCanonicalTriggerSql(trigger.sql),
      })),
    }));
}

function normalizeOptionalCanonicalTriggerSql(sql: string): string | null {
  // sqlite_schema stores main-schema trigger names without the schema qualifier.
  return normalizeSchemaSql(sql)?.replace(/^(CREATE TRIGGER) main\./iu, "$1 ") ?? null;
}

function getSqliteSchemaContract(schemaSql: string): SqliteSchemaContract {
  let expected = schemaContractCache.get(schemaSql);
  if (!expected) {
    expected = buildSqliteSchemaContract(schemaSql);
    schemaContractCache.set(schemaSql, expected);
  }
  return expected;
}

type CanonicalTableRow = SqliteSchemaRow & { table_id: string };
type CanonicalIndexRow = SqliteIndexListRow & {
  table_id: string;
  index_seq: number;
  sql: string | null;
};
type CanonicalIndexTermRow = SqliteIndexTermRow & { table_id: string; index_seq: number };
type CanonicalTriggerRow = SqliteSchemaRow & { tbl_name: string };

function collectCanonicalSqliteFacts(database: DatabaseSync) {
  const tableOptions = database
    .prepare("PRAGMA table_list")
    // SAFETY: SQLite table_list defines name, strict, and wr on every native row.
    .all() as SqliteTableListRow[];
  // Tables and views can shadow table-valued PRAGMAs, including in temp schemas.
  if (
    tableOptions.some((row) => {
      const name = row.name.toLowerCase();
      return name === "pragma_index_list" || name === "pragma_index_xinfo";
    })
  ) {
    return undefined;
  }
  const indexes = database
    .prepare(`
    SELECT CAST(t.rowid AS TEXT) AS table_id, i.seq AS index_seq,
      i.name, i.origin, i.partial, i."unique", d.sql
    FROM sqlite_schema AS t
    CROSS JOIN pragma_index_list(t.name) AS i
    LEFT JOIN sqlite_schema AS d ON d.type = 'index' AND d.name = i.name
    WHERE t.type = 'table' AND t.name NOT LIKE 'sqlite_%'
  `)
    // SAFETY: fixed catalog/PRAGMA columns; the left join preserves null DDL for WR primary keys.
    .all() as CanonicalIndexRow[];
  const terms = database
    .prepare(`
    SELECT CAST(t.rowid AS TEXT) AS table_id, i.seq AS index_seq,
      x.seqno, x.cid, x.name, x."desc", x.coll, x."key"
    FROM sqlite_schema AS t
    CROSS JOIN pragma_index_list(t.name) AS i
    CROSS JOIN pragma_index_xinfo(i.name) AS x
    WHERE t.type = 'table' AND t.name NOT LIKE 'sqlite_%'
    ORDER BY t.rowid, i.seq, x.seqno
  `)
    // SAFETY: index_xinfo supplies all six native term fields; index_list supplies table-local seq keys.
    .all() as CanonicalIndexTermRow[];
  const triggers = database
    .prepare(`
    SELECT tbl_name, name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY tbl_name, name
  `)
    // SAFETY: canonical trigger catalog rows have text names and nullable text DDL.
    .all() as CanonicalTriggerRow[];
  return {
    tableOptions,
    indexes: groupCanonicalRows(indexes, (row) => row.table_id),
    terms: groupCanonicalRows(terms, (row) => row.table_id),
    triggers: groupCanonicalRows(triggers, (row) => row.tbl_name),
  };
}

function groupCanonicalRows<Row, Key extends string | number>(
  rows: Row[],
  key: (row: Row) => Key,
): Map<Key, Row[]> {
  const groups = new Map<Key, Row[]>();
  for (const row of rows) {
    const name = key(row);
    const group = groups.get(name);
    if (group) {
      group.push(row);
    } else {
      groups.set(name, [row]);
    }
  }
  return groups;
}

function buildSqliteSchemaContract(schemaSql: string): SqliteSchemaContract {
  const database = openNodeSqliteDatabase(":memory:");
  try {
    database.exec(schemaSql);
    // Decimal text keeps catalog rowids exact without introducing native integer conversion errors.
    const rows = database
      .prepare(
        `
          SELECT CAST(rowid AS TEXT) AS table_id, name, sql
          FROM sqlite_schema
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
          ORDER BY name
        `,
      )
      .all() as CanonicalTableRow[];
    if (rows.length === 0) {
      return new Map();
    }
    const facts = collectCanonicalSqliteFacts(database);
    if (!facts) {
      return new Map(
        rows.map((table) => [
          table.name,
          collectSqliteTableContractFromRow(database, table.name, table),
        ]),
      );
    }
    return new Map(
      rows.map((table) => {
        const tableList = facts.tableOptions.find((entry) => entry.name === table.name);
        if (!tableList) {
          throw new Error(`Could not inspect SQLite table options for ${table.name}.`);
        }
        const termsByIndex = groupCanonicalRows(
          facts.terms.get(table.table_id) ?? [],
          (term) => term.index_seq,
        );
        const indexes = (facts.indexes.get(table.table_id) ?? [])
          .map((index) =>
            createSqliteIndexContract(index, index.sql, termsByIndex.get(index.index_seq) ?? []),
          )
          .toSorted(compareJson);
        return [
          table.name,
          createSqliteTableContract(
            table.name,
            table,
            tableList,
            indexes,
            facts.triggers.get(table.name) ?? [],
          ),
        ];
      }),
    );
  } finally {
    database.close();
  }
}

function readCanonicalIndexDefinition(index: SqliteIndexContract): string {
  if (index.name === null || index.sql === null) {
    throw new Error("Canonical SQLite named index is missing its schema definition.");
  }
  const createPrefix =
    index.unique === 1 ? /^CREATE\s+UNIQUE\s+INDEX\s+/iu : /^CREATE\s+INDEX\s+/iu;
  const prefix = createPrefix.exec(index.sql);
  if (!prefix) {
    throw new Error(`Canonical SQLite index ${index.name} has an unreadable definition.`);
  }
  const name = readSqlToken(index.sql, prefix[0].length);
  if (!name || normalizeSqlIdentifier(name.raw) !== index.name.toLowerCase()) {
    throw new Error(`Canonical SQLite index ${index.name} has an unexpected schema name.`);
  }
  const definition = index.sql.slice(name.end).trim();
  if (!/^ON\s+/iu.test(definition)) {
    throw new Error(`Canonical SQLite index ${index.name} has an unreadable target.`);
  }
  return definition;
}

function collectSqliteTableContract(
  database: DatabaseSync,
  tableName: string,
): SqliteTableContract | undefined {
  const table = executeWithCachedStatement(
    database,
    "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
    [tableName],
    (statement) => statement.get(tableName),
  ) as SqliteSchemaRow | undefined;
  if (!table) {
    return undefined;
  }
  return collectSqliteTableContractFromRow(database, tableName, table);
}

function collectSqliteTableContractFromRow(
  database: DatabaseSync,
  tableName: string,
  table: SqliteSchemaRow,
): SqliteTableContract {
  const quotedTable = quoteSqliteIdentifier(tableName);
  const tableList = (
    database.prepare(`PRAGMA table_list(${quotedTable})`).all() as SqliteTableListRow[]
  ).find((entry) => entry.name === tableName);
  if (!tableList) {
    throw new Error(`Could not inspect SQLite table options for ${tableName}.`);
  }
  const indexes = (
    database.prepare(`PRAGMA index_list(${quotedTable})`).all() as SqliteIndexListRow[]
  )
    .map((index) => collectSqliteIndexContract(database, index))
    .toSorted(compareJson);
  const triggers = executeWithCachedStatement(
    database,
    `
          SELECT name, sql
          FROM sqlite_schema
          WHERE type = 'trigger' AND tbl_name = ?
          ORDER BY name
        `,
    [tableName],
    (statement) => statement.all(tableName),
  ) as SqliteSchemaRow[];
  return createSqliteTableContract(tableName, table, tableList, indexes, triggers);
}

function compareTableDefinitions(
  tableName: string,
  actual: SqliteTableDefinition | null,
  expected: SqliteTableDefinition | null,
  compatibility: SqliteSchemaCompatibility,
  allowCompatibleAdditiveColumns: boolean,
): SqliteSchemaIssue[] {
  const issues: SqliteSchemaIssue[] = [];
  const add = (code: SqliteSchemaIssueCode, objectName: string) => {
    issues.push(createSqliteSchemaIssue(code, objectName));
  };
  if (!actual || !expected) {
    if (actual !== expected) {
      add("table-definition-drift", tableName);
    }
    return issues;
  }
  const allowedMissingColumns = new Set(compatibility.allowedMissingColumns ?? []);
  for (const [columnName, definition] of actual.columns) {
    if (!expected.columns.has(columnName)) {
      if (
        allowCompatibleAdditiveColumns &&
        compatibility.allowCompatibleAdditiveColumns &&
        isCompatibleAdditiveColumnDefinition(definition)
      ) {
        continue;
      }
      const objectName = `${tableName}.${columnName}`;
      add("unexpected-column", objectName);
    }
  }
  for (const [columnName, expectedDefinition] of expected.columns) {
    const objectName = `${tableName}.${columnName}`;
    const actualDefinition = actual.columns.get(columnName);
    if (actualDefinition === undefined) {
      if (!allowedMissingColumns.has(objectName)) {
        add("missing-column", objectName);
      }
      continue;
    }
    if (actualDefinition === expectedDefinition) {
      continue;
    }
    const allowed = compatibility.allowedColumnDefinitions?.[objectName] ?? [];
    if (!allowed.some((definition) => normalizeSqlWhitespace(definition) === actualDefinition)) {
      add("column-definition-drift", objectName);
    }
  }
  if (JSON.stringify(actual.constraints) !== JSON.stringify(expected.constraints)) {
    add("table-constraint-drift", tableName);
  }
  return issues;
}

const SQLITE_STRICT_DATATYPES = new Set(["ANY", "BLOB", "INT", "INTEGER", "REAL", "TEXT"]);

function isCompatibleAdditiveColumnDefinition(definition: string): boolean {
  const name = readSqlToken(definition, 0);
  const type = name ? readSqlToken(definition, name.end) : null;
  return Boolean(
    type?.keyword &&
    SQLITE_STRICT_DATATYPES.has(type.keyword) &&
    definition.slice(type.end).trim().length === 0,
  );
}

function collectSqliteIndexContract(
  database: DatabaseSync,
  index: SqliteIndexListRow,
): SqliteIndexContract {
  const row = executeWithCachedStatement(
    database,
    "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?",
    [index.name],
    (statement) => statement.get(index.name),
  ) as { sql?: unknown } | undefined;
  const terms = database
    .prepare(`PRAGMA index_xinfo(${quoteSqliteIdentifier(index.name)})`)
    .all() as SqliteIndexTermRow[];
  return createSqliteIndexContract(index, typeof row?.sql === "string" ? row.sql : null, terms);
}

function isEqualTrigger(left: SqliteSchemaRow, right: SqliteSchemaRow): boolean {
  return left.name === right.name && left.sql === right.sql;
}

function compareJson(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

export function readSqliteSchemaCookie(database: DatabaseSync) {
  return database.prepare("PRAGMA schema_version").get()?.schema_version;
}
