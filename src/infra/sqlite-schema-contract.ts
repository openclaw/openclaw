import type { DatabaseSync } from "node:sqlite";
import {
  readGeneratedSqliteCatalog,
  readGeneratedSqliteFingerprint,
} from "../state/postgres-schema.generated/sqlite-catalogs.js";
import { executeWithCachedStatement } from "./kysely-sync-cache-state.js";
import {
  getSqlitePinnedReadSnapshot,
  runSqliteSchemaReadSnapshotSync,
} from "./sqlite-pinned-read-snapshot.js";
import type {
  SqliteColumnCatalog,
  SqliteForeignKeyCatalog,
  SqliteIndexListRow,
  SqliteIndexTermRow,
  SqliteSchemaCatalog,
  SqliteSchemaRow,
  SqliteSchemaSource,
} from "./sqlite-schema-catalog-types.js";
import {
  createSqliteTableContractReader,
  type SqliteTableContractReader,
  sqliteSchemaContractFromCatalog,
} from "./sqlite-schema-catalog.js";
import {
  createSqliteIndexContract,
  type SqliteIndexContract,
  type SqliteTableContract,
  type SqliteTableDefinition,
} from "./sqlite-schema-contract-assembly.js";
import { fingerprintSqliteSchemaCatalog } from "./sqlite-schema-fingerprint.js";
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

type SqliteSchemaContract = ReadonlyMap<string, SqliteTableContract>;

export type { SqliteSchemaSource } from "./sqlite-schema-catalog-types.js";
export {
  createSqliteTableContractReader,
  type SqliteTableContractReader,
} from "./sqlite-schema-catalog.js";

export type CanonicalSqliteNamedIndexContract = {
  definition: string;
  fingerprint: SqliteIndexContract;
  name: string;
  tableName: string;
  unique: boolean;
};

/**
 * Require every object from one committed schema while allowing unrelated
 * tables and indexes that do not replace a canonical object.
 */
export function assertSqliteSchemaContains(
  database: DatabaseSync,
  databaseLabel: string,
  schemaSql: SqliteSchemaSource,
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
  schemaSql: SqliteSchemaSource,
  compatibility: SqliteSchemaCompatibility = {},
  readTable?: SqliteTableContractReader,
): SqliteSchemaIssue[] {
  if (!getSqlitePinnedReadSnapshot(database)) {
    return runSqliteSchemaReadSnapshotSync(database, () =>
      collectSqliteSchemaIssues(database, schemaSql, compatibility, readTable),
    );
  }
  const descriptor =
    typeof schemaSql === "string" ? readGeneratedSqliteFingerprint(schemaSql) : undefined;
  const expectedViewNames =
    descriptor?.viewNames ??
    getSqliteSchemaContract(schemaSql).catalog.views.map((view) => view.name);
  const readActualTable =
    readTable ??
    createSqliteTableContractReader(
      database,
      expectedViewNames,
      descriptor?.tableNames ??
        getSqliteSchemaContract(schemaSql).catalog.tables.map((table) => table.name),
    );
  if (hasCanonicalSqliteSchemaFingerprint(schemaSql, readActualTable, compatibility)) {
    return [];
  }
  const expected = getSqliteSchemaContract(schemaSql);
  const excludedTables = new Set(compatibility.excludedTables ?? []);
  const excludedIndexes = new Set(compatibility.excludedIndexes ?? []);
  const allowedMissingTables = new Set(compatibility.allowedMissingTables ?? []);
  const allowedMissingIndexes = new Set(compatibility.allowedMissingIndexes ?? []);

  const issues: SqliteSchemaIssue[] = [];
  const add = (code: SqliteSchemaIssueCode, objectName: string, message?: string) => {
    issues.push(createSqliteSchemaIssue(code, objectName, message));
  };
  for (const [tableName, expectedTable] of expected.tables) {
    if (excludedTables.has(tableName)) {
      continue;
    }
    const actualTable = readActualTable(tableName);
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
    for (const issue of compareTablePragmaFacts(
      tableName,
      actualTable,
      expectedTable,
      compatibility,
    )) {
      if (
        !issues.some(
          (existing) => existing.code === issue.code && existing.objectName === issue.objectName,
        )
      ) {
        issues.push(issue);
      }
    }
    const actualIndexFingerprints = new Set(
      actualTable.indexes.map((index) => JSON.stringify(index)),
    );
    const expectedIndexFingerprints = new Set<string>();
    for (const expectedIndex of expectedTable.indexes) {
      if (expectedIndex.name !== null && excludedIndexes.has(expectedIndex.name)) {
        continue;
      }
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
      if (!containsTrigger(actualTable.triggers, expectedTrigger)) {
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
        if (!containsTrigger(actualTable.triggers, canonicalTrigger)) {
          add("missing-or-drifted-trigger", canonicalTrigger.name);
        }
      }
    }
    for (const actualTrigger of actualTable.triggers) {
      if (
        !containsTrigger(expectedTable.triggers, actualTrigger) &&
        !containsTrigger(optionalCanonicalTriggers, actualTrigger)
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
  const readView =
    readActualTable.readView ??
    createSqliteTableContractReader(database, expectedViewNames).readView;
  for (const expectedView of expected.catalog.views) {
    const actualView = readView(expectedView.name);
    if (
      !actualView ||
      actualView.sql !== expectedView.sql ||
      JSON.stringify(normalizeColumns(actualView.columns)) !==
        JSON.stringify(normalizeColumns(expectedView.columns))
    ) {
      add("missing-or-drifted-view", expectedView.name);
      continue;
    }
    for (const trigger of expectedView.triggers) {
      if (!containsTrigger(actualView.triggers, trigger)) {
        add("missing-or-drifted-trigger", trigger.name);
      }
    }
    for (const trigger of actualView.triggers) {
      if (!containsTrigger(expectedView.triggers, trigger)) {
        add("unexpected-trigger", trigger.name);
      }
    }
  }
  return issues;
}

/** Require stable canonical tables before a version-specific additive migration. */
export function assertSqliteSchemaTablesPresent(
  database: DatabaseSync,
  databaseLabel: string,
  schemaSql: SqliteSchemaSource,
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
  schemaSql: SqliteSchemaSource,
): CanonicalSqliteNamedIndexContract[] {
  const schema = getSqliteSchemaContract(schemaSql);
  const indexes: CanonicalSqliteNamedIndexContract[] = [];
  for (const [tableName, table] of schema.tables) {
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
export function getCanonicalSqliteTableNames(schemaSql: SqliteSchemaSource): string[] {
  if (typeof schemaSql === "string") {
    const descriptor = readGeneratedSqliteFingerprint(schemaSql);
    if (descriptor) {
      return [...descriptor.tableNames];
    }
  }
  return [...getSqliteSchemaContract(schemaSql).tables.keys()];
}

/** Read index membership without materializing diagnostic catalog facts. */
export function getCanonicalSqliteNamedIndexNames(schemaSql: SqliteSchemaSource): string[] {
  if (typeof schemaSql === "string") {
    const descriptor = readGeneratedSqliteFingerprint(schemaSql);
    if (descriptor) {
      return [...descriptor.indexNames];
    }
  }
  return getCanonicalSqliteNamedIndexContracts(schemaSql).map((index) => index.name);
}

/** A matching native catalog needs neither expected DDL execution nor full diagnostic facts. */
export function hasCanonicalSqliteSchemaFingerprint(
  schemaSql: SqliteSchemaSource,
  readTable: SqliteTableContractReader,
  compatibility: SqliteSchemaCompatibility = {},
): boolean {
  const descriptor =
    typeof schemaSql === "string" ? readGeneratedSqliteFingerprint(schemaSql) : undefined;
  if (!descriptor || !readTable.readCatalog) {
    return false;
  }
  const catalog = readTable.readCatalog(descriptor.viewNames, descriptor.tableNames);
  if (fingerprintSqliteSchemaCatalog(catalog, descriptor) !== descriptor.fingerprint) {
    return false;
  }
  for (const group of compatibility.optionalCanonicalTriggerGroups ?? []) {
    if (
      !descriptor.tableNames.includes(group.tableName) ||
      compatibility.excludedTables?.includes(group.tableName)
    ) {
      continue;
    }
    // The matching fingerprint includes every declared table.
    const triggers = catalog.tables.find((table) => table.name === group.tableName)!.triggers;
    const optional =
      !group.optionalWhenTableMissing ||
      !catalog.tables.some((table) => table.name === group.optionalWhenTableMissing);
    if (
      optional &&
      !triggers.some((actual) => group.triggers.some((t) => t.name === actual.name))
    ) {
      continue;
    }
    if (
      !group.triggers.every((trigger) =>
        containsTrigger(triggers, {
          name: trigger.name,
          sql: normalizeOptionalCanonicalTriggerSql(trigger.sql),
        }),
      )
    ) {
      return false;
    }
  }
  if (!compatibility.excludedIndexes?.length) {
    return true;
  }
  // Excluding a named unique index makes its actual uniqueness unexpected.
  return !catalog.tables.some(
    (table) =>
      descriptor.tableNames.includes(table.name) &&
      !compatibility.excludedTables?.includes(table.name) &&
      table.indexes.some(
        (index) =>
          index.origin === "c" &&
          index.unique === 1 &&
          compatibility.excludedIndexes?.includes(index.name),
      ),
  );
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
    database
      .prepare(`PRAGMA main.index_list(${quoteSqliteIdentifier(row.tbl_name)})`)
      .all() as SqliteIndexListRow[]
  ).find((candidate) => candidate.name === indexName);
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

type ExpectedSchemaContract = {
  catalog: SqliteSchemaCatalog;
  tables: SqliteSchemaContract;
};

const expectedContracts = new WeakMap<SqliteSchemaCatalog, ExpectedSchemaContract>();
const expectedStringContracts = new Map<string, ExpectedSchemaContract>();

function getSqliteSchemaContract(schemaSql: SqliteSchemaSource): ExpectedSchemaContract {
  if (typeof schemaSql === "string") {
    const cached = expectedStringContracts.get(schemaSql);
    if (cached) {
      return cached;
    }
  }
  const catalog = typeof schemaSql === "string" ? readGeneratedSqliteCatalog(schemaSql) : schemaSql;
  if (!catalog) {
    throw new Error(
      "SQLite schema has no generated catalog; run pnpm db:postgres:gen for its declared schema input.",
    );
  }
  let expected = expectedContracts.get(catalog);
  if (!expected) {
    expected = { catalog, tables: sqliteSchemaContractFromCatalog(catalog) };
    expectedContracts.set(catalog, expected);
  }
  if (typeof schemaSql === "string") {
    expectedStringContracts.set(schemaSql, expected);
  }
  return expected;
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

function normalizeColumns(columns: readonly SqliteColumnCatalog[]) {
  return columns
    .map(({ cid: _cid, name, type, dflt_value, ...column }) => ({
      ...column,
      name: normalizeSqlIdentifier(name),
      type: type.toUpperCase(),
      dflt_value: dflt_value === null ? null : normalizeSqlWhitespace(dflt_value),
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function normalizeForeignKeys(
  foreignKeys: readonly SqliteForeignKeyCatalog[],
  excludedColumns: ReadonlySet<string>,
) {
  const groups = new Map<number, Omit<SqliteForeignKeyCatalog, "id">[]>();
  for (const { id, from, table, to, ...foreignKey } of foreignKeys) {
    const group = groups.get(id) ?? [];
    group.push({
      ...foreignKey,
      from: normalizeSqlIdentifier(from),
      table: normalizeSqlIdentifier(table),
      to: to === null ? null : normalizeSqlIdentifier(to),
    });
    groups.set(id, group);
  }
  return [...groups.values()]
    .filter((group) => !group.some((foreignKey) => excludedColumns.has(foreignKey.from)))
    .map((group) => group.toSorted((left, right) => left.seq - right.seq))
    .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function compareTablePragmaFacts(
  tableName: string,
  actual: SqliteTableContract,
  expected: SqliteTableContract,
  compatibility: SqliteSchemaCompatibility,
): SqliteSchemaIssue[] {
  const issues: SqliteSchemaIssue[] = [];
  const actualColumns = new Map(
    normalizeColumns(actual.columns).map((column) => [column.name, column]),
  );
  const expectedColumns = normalizeColumns(expected.columns);
  const excludedForeignKeyColumns = new Set<string>();
  for (const expectedColumn of expectedColumns) {
    const columnName = expectedColumn.name;
    const objectName = `${tableName}.${columnName}`;
    const actualColumn = actualColumns.get(columnName);
    if (!actualColumn) {
      if ((compatibility.allowedMissingColumns ?? []).includes(objectName)) {
        excludedForeignKeyColumns.add(columnName);
      } else {
        issues.push(createSqliteSchemaIssue("missing-column", objectName));
      }
      continue;
    }
    const actualDefinition = actual.definition?.columns.get(columnName);
    const allowedDefinitions = compatibility.allowedColumnDefinitions?.[objectName] ?? [];
    // A supported migration's explicitly allowed declaration also owns its PRAGMA metadata.
    if (
      actualDefinition !== undefined &&
      allowedDefinitions.some(
        (definition) => normalizeSqlWhitespace(definition) === actualDefinition,
      )
    ) {
      excludedForeignKeyColumns.add(columnName);
      continue;
    }
    if (JSON.stringify(actualColumn) !== JSON.stringify(expectedColumn)) {
      issues.push(createSqliteSchemaIssue("column-definition-drift", objectName));
    }
  }
  // Ordinary columns are checked against their full declarations; virtual tables have no such map.
  if (expected.definition === null) {
    const expectedNames = new Set(expectedColumns.map((column) => column.name));
    for (const actualColumn of actualColumns.values()) {
      if (!expectedNames.has(actualColumn.name)) {
        issues.push(
          createSqliteSchemaIssue("unexpected-column", `${tableName}.${actualColumn.name}`),
        );
      }
    }
  }
  if (
    JSON.stringify(normalizeForeignKeys(actual.foreignKeys, excludedForeignKeyColumns)) !==
    JSON.stringify(normalizeForeignKeys(expected.foreignKeys, excludedForeignKeyColumns))
  ) {
    issues.push(createSqliteSchemaIssue("table-constraint-drift", tableName));
  }
  return issues;
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
      const objectName = `${tableName}.${columnName}`;
      const allowedDefinitions = compatibility.allowedColumnDefinitions?.[objectName] ?? [];
      if (allowedDefinitions.some((allowed) => normalizeSqlWhitespace(allowed) === definition)) {
        continue;
      }
      if (
        allowCompatibleAdditiveColumns &&
        compatibility.allowCompatibleAdditiveColumns &&
        isCompatibleAdditiveColumnDefinition(definition)
      ) {
        continue;
      }
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
    "SELECT sql FROM main.sqlite_schema WHERE type = 'index' AND name = ?",
    [index.name],
    (statement) => statement.get(index.name),
  ) as { sql?: unknown } | undefined;
  const terms = database
    .prepare(`PRAGMA main.index_xinfo(${quoteSqliteIdentifier(index.name)})`)
    .all() as SqliteIndexTermRow[];
  return createSqliteIndexContract(index, typeof row?.sql === "string" ? row.sql : null, terms);
}

function containsTrigger(triggers: readonly SqliteSchemaRow[], expected: SqliteSchemaRow): boolean {
  return triggers.some((trigger) => trigger.name === expected.name && trigger.sql === expected.sql);
}

export function readSqliteSchemaCookie(database: DatabaseSync) {
  return database.prepare("PRAGMA schema_version").get()?.schema_version;
}
