import type { DatabaseSync } from "node:sqlite";
import type {
  SqliteColumnCatalog,
  SqliteForeignKeyCatalog,
  SqliteIndexListRow,
  SqliteIndexTermRow,
  SqliteSchemaCatalog,
  SqliteSchemaRow,
  SqliteTableListRow,
  SqliteViewCatalog,
} from "./sqlite-schema-catalog-types.js";
import {
  createSqliteIndexContract,
  createSqliteTableContract,
  type SqliteTableContract,
} from "./sqlite-schema-contract-assembly.js";
import { normalizeSchemaSql, quoteSqliteIdentifier } from "./sqlite-schema-sql.js";

export type SqliteTableContractReader = ((tableName: string) => SqliteTableContract | undefined) & {
  readCatalog?: (
    viewNames: readonly string[],
    tableNames: readonly string[],
  ) => SqliteSchemaCatalog;
  readView?: (viewName: string) => SqliteViewCatalog | undefined;
};

/** Reuse actual catalog facts only within one unchanged read transaction on this connection. */
export function createSqliteTableContractReader(
  database: DatabaseSync,
  viewNames: readonly string[] = [],
  tableNames: readonly string[] = [],
) {
  let catalog: SqliteSchemaCatalog | undefined;
  let tables: ReadonlyMap<string, SqliteTableContract> | undefined;
  const unreadVirtualTables = new Set<string>();
  const readCatalog = (requestedTableNames: readonly string[] = []) => {
    if (!catalog) {
      const virtualTableNames = [...tableNames, ...requestedTableNames];
      catalog = readSqliteSchemaCatalog(database, { viewNames, virtualTableNames });
      for (const table of catalog.tables) {
        if (
          table.sql &&
          /^CREATE VIRTUAL TABLE /iu.test(table.sql) &&
          !virtualTableNames.includes(table.name)
        ) {
          unreadVirtualTables.add(table.name);
        }
      }
    } else {
      for (const name of requestedTableNames) {
        if (!unreadVirtualTables.has(name)) {
          continue;
        }
        const columns = readSqliteColumnCatalog(database, name);
        catalog = {
          ...catalog,
          tables: catalog.tables.map((table) =>
            table.name === name ? { ...table, columns } : table,
          ),
        };
        unreadVirtualTables.delete(name);
        tables = undefined;
      }
    }
    return catalog;
  };
  return Object.assign(
    (tableName: string) => {
      const currentCatalog = readCatalog([tableName]);
      return (tables ??= sqliteSchemaContractFromCatalog(currentCatalog)).get(tableName);
    },
    {
      readCatalog: (expectedViewNames: readonly string[], expectedTableNames: readonly string[]) =>
        expectedViewNames.every((name) => viewNames.includes(name))
          ? readCatalog(expectedTableNames)
          : readSqliteSchemaCatalog(database, {
              viewNames: expectedViewNames,
              virtualTableNames: expectedTableNames,
            }),
      readView: (viewName: string) => {
        const views = viewNames.includes(viewName)
          ? readCatalog().views
          : readSqliteSchemaCatalog(database, {
              viewNames: [viewName],
              virtualTableNames: [],
            }).views;
        return views.find((view) => view.name === viewName);
      },
    },
  );
}

/** Preserve admission's historical column-order and automatic-index-name compatibility. */
export function sqliteSchemaContractFromCatalog(
  catalog: SqliteSchemaCatalog,
): ReadonlyMap<string, SqliteTableContract> {
  return new Map(
    catalog.tables.map((table) => [
      table.name,
      createSqliteTableContract(
        table.name,
        table,
        { schema: "main", name: table.name, strict: table.strict, wr: table.withoutRowid },
        table.indexes
          .map((index) => createSqliteIndexContract(index, index.sql, index.terms))
          .toSorted(compareJson),
        table.triggers,
        table.columns,
        table.foreignKeys,
      ),
    ]),
  );
}

type CatalogObject = SqliteSchemaRow & { type: string; tbl_name: string };
type IndexRow = SqliteIndexListRow & { table_name: string; index_seq: number };
type IndexTermRow = SqliteIndexTermRow & { table_name: string; index_seq: number };
type IndexFactsRow = Omit<IndexRow, "name"> & { index_name: string } & (
    | SqliteIndexTermRow
    | { [Key in keyof SqliteIndexTermRow]: null }
  );
type ColumnRow = SqliteColumnCatalog & { table_name: string };
type ForeignKeyRow = SqliteForeignKeyCatalog & { table_name: string };

function groupRows<Row, Key extends string | number>(
  rows: readonly Row[],
  key: (row: Row) => Key,
): Map<Key, Row[]> {
  const groups = new Map<Key, Row[]>();
  for (const row of rows) {
    const name = key(row);
    const group = groups.get(name) ?? [];
    group.push(row);
    groups.set(name, group);
  }
  return groups;
}

/** Read one native catalog in five statements, independent of its table count. */
function readSqliteSchemaCatalog(
  database: DatabaseSync,
  options: { viewNames?: readonly string[]; virtualTableNames?: readonly string[] } = {},
): SqliteSchemaCatalog {
  // Selecting the original columns preserves catalog authorizer behavior, including empty stores.
  const objects = database
    .prepare("SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY name")
    // SAFETY: SQLite owns these catalog columns and their fixed string/null types.
    .all() as CatalogObject[];
  const tables = objects.filter((row) => row.type === "table" && !row.name.startsWith("sqlite_"));
  const views = objects.filter(
    (row) => row.type === "view" && (!options.viewNames || options.viewNames.includes(row.name)),
  );
  if (tables.length === 0 && views.length === 0) {
    return { tables: [], views: [] };
  }
  // SAFETY: Native table_list returns string schema/name and integer strict/wr flags.
  const tableOptions = database.prepare("PRAGMA table_list").all() as (SqliteTableListRow & {
    type: string;
  })[];
  // Unrelated virtual tables may require an extension that this connection does not load.
  const deferredVirtualTables = tableOptions
    .filter(
      (row) =>
        row.schema === "main" &&
        row.type === "virtual" &&
        options.virtualTableNames &&
        !options.virtualTableNames.includes(row.name),
    )
    .map((row) => row.name);
  // A table/view in either schema can shadow a table-valued PRAGMA. Native PRAGMAs cannot be shadowed.
  const shadowed = tableOptions.some((row) =>
    [
      "pragma_index_list",
      "pragma_index_xinfo",
      "pragma_table_xinfo",
      "pragma_foreign_key_list",
    ].includes(row.name.toLowerCase()),
  );
  let indexes: Map<string, IndexRow[]> | undefined;
  let terms: Map<string, IndexTermRow[]> | undefined;
  if (!shadowed) {
    indexes = new Map();
    terms = new Map();
    const rows = database
      .prepare(`
        SELECT t.name AS table_name, i.seq AS index_seq,
          i.name AS index_name, i.origin, i.partial, i."unique",
          x.seqno, x.cid, x.name, x."desc", x.coll, x."key"
        FROM main.sqlite_schema AS t
        CROSS JOIN pragma_index_list(t.name, 'main') AS i
        LEFT JOIN pragma_index_xinfo(i.name, 'main') AS x ON 1 = 1
        WHERE t.type = 'table' AND substr(t.name, 1, 7) <> 'sqlite_'
        ORDER BY t.name, i.seq, x.seqno
      `)
      // SAFETY: Unshadowed native PRAGMAs have fixed field types; absent LEFT JOIN terms are all null.
      .all() as IndexFactsRow[];
    for (const row of rows) {
      const tableIndexes = indexes.get(row.table_name) ?? [];
      if (tableIndexes.at(-1)?.index_seq !== row.index_seq) {
        tableIndexes.push({
          table_name: row.table_name,
          index_seq: row.index_seq,
          name: row.index_name,
          origin: row.origin,
          partial: row.partial,
          unique: row.unique,
        });
        indexes.set(row.table_name, tableIndexes);
      }
      if (row.seqno !== null) {
        const tableTerms = terms.get(row.table_name) ?? [];
        tableTerms.push({
          table_name: row.table_name,
          index_seq: row.index_seq,
          seqno: row.seqno,
          cid: row.cid,
          name: row.name,
          desc: row.desc,
          coll: row.coll,
          key: row.key,
        });
        terms.set(row.table_name, tableTerms);
      }
    }
  }
  // Unrelated views may reference removed tables; only declared views need column inspection.
  const columnObjectClause = !options.viewNames
    ? "t.type IN ('table', 'view')"
    : options.viewNames.length > 0
      ? `t.type = 'table' OR (t.type = 'view' AND t.name IN (${options.viewNames.map(() => "?").join(", ")}))`
      : "t.type = 'table'";
  const columnTableClause = deferredVirtualTables.length
    ? `AND t.name NOT IN (${deferredVirtualTables.map(() => "?").join(", ")})`
    : "";
  const columns = shadowed
    ? undefined
    : groupRows(
        database
          .prepare(`
          SELECT t.name AS table_name, x.cid, x.name, x.type, x."notnull", x.dflt_value, x.pk, x.hidden
          FROM main.sqlite_schema AS t
          CROSS JOIN pragma_table_xinfo(t.name, 'main') AS x
          WHERE (${columnObjectClause}) AND substr(t.name, 1, 7) <> 'sqlite_'
            ${columnTableClause}
          ORDER BY t.name, x.cid
        `)
          // SAFETY: Unshadowed table_xinfo provides fixed string/null column fields and integer flags/positions.
          .all(...(options.viewNames ?? []), ...deferredVirtualTables) as ColumnRow[],
        (row) => row.table_name,
      );
  const foreignKeys = shadowed
    ? undefined
    : groupRows(
        database
          .prepare(`
          SELECT t.name AS table_name, f.id, f.seq, f."table", f."from", f."to",
            f.on_update, f.on_delete, f."match"
          FROM main.sqlite_schema AS t
          CROSS JOIN pragma_foreign_key_list(t.name, 'main') AS f
          WHERE t.type = 'table' AND substr(t.name, 1, 7) <> 'sqlite_'
          ORDER BY t.name, f.id, f.seq
        `)
          // SAFETY: Unshadowed foreign_key_list provides string/null identifiers/actions and integer id/seq.
          .all() as ForeignKeyRow[],
        (row) => row.table_name,
      );
  const triggers = groupRows(
    objects.filter((row) => row.type === "trigger"),
    (row) => row.tbl_name,
  );
  const indexSql = new Map(
    objects.filter((row) => row.type === "index").map((row) => [row.name, row.sql]),
  );
  const normalizedRow = (row: SqliteSchemaRow): SqliteSchemaRow => ({
    name: row.name,
    sql: normalizeSchemaSql(row.sql),
  });
  const readColumns = (name: string): SqliteColumnCatalog[] =>
    deferredVirtualTables.includes(name)
      ? []
      : columns
        ? (columns.get(name) ?? []).map(({ table_name: _tableName, ...column }) => column)
        : readSqliteColumnCatalog(database, name);
  const readTriggers = (name: string) => (triggers.get(name) ?? []).map(normalizedRow);
  return {
    tables: tables.map((table) => {
      const tableOption = tableOptions.find(
        (row) => row.schema === "main" && row.name === table.name,
      );
      if (!tableOption) {
        throw new Error(`Could not inspect SQLite table options for ${table.name}.`);
      }
      const nativeIndexes = indexes
        ? (indexes.get(table.name) ?? [])
        : (
            database
              .prepare(`PRAGMA main.index_list(${quoteSqliteIdentifier(table.name)})`)
              // SAFETY: Native index_list provides string names/origin and integer flags/seq.
              .all() as (SqliteIndexListRow & { seq: number })[]
          ).map(({ name, origin, partial, unique, seq }) => ({
            name,
            origin,
            partial,
            unique,
            index_seq: seq,
          }));
      const tableTerms = groupRows(terms?.get(table.name) ?? [], (row) => row.index_seq);
      return {
        name: table.name,
        sql: normalizeSchemaSql(table.sql),
        strict: tableOption.strict,
        withoutRowid: tableOption.wr,
        columns: readColumns(table.name),
        foreignKeys: foreignKeys
          ? (foreignKeys.get(table.name) ?? []).map(
              ({ table_name: _tableName, ...foreignKey }) => foreignKey,
            )
          : (database
              .prepare(`PRAGMA main.foreign_key_list(${quoteSqliteIdentifier(table.name)})`)
              // SAFETY: Native foreign_key_list provides string/null identifiers/actions and integer id/seq.
              .all() as SqliteForeignKeyCatalog[]),
        indexes: nativeIndexes
          .map((index) => ({
            name: index.name,
            origin: index.origin,
            partial: index.partial,
            unique: index.unique,
            sql: normalizeSchemaSql(indexSql.get(index.name) ?? null),
            terms: terms
              ? (tableTerms.get(index.index_seq) ?? []).map(
                  ({ table_name: _tableName, index_seq: _indexSeq, ...term }) => term,
                )
              : (database
                  .prepare(`PRAGMA main.index_xinfo(${quoteSqliteIdentifier(index.name)})`)
                  // SAFETY: Native index_xinfo provides string/null term fields and integer flags/positions.
                  .all() as SqliteIndexTermRow[]),
          }))
          .toSorted((left, right) => left.name.localeCompare(right.name)),
        triggers: readTriggers(table.name),
      };
    }),
    views: views.map((view) => ({
      name: view.name,
      sql: normalizeSchemaSql(view.sql),
      columns: readColumns(view.name),
      triggers: readTriggers(view.name),
    })),
  };
}

function readSqliteColumnCatalog(database: DatabaseSync, name: string): SqliteColumnCatalog[] {
  return (
    database
      .prepare(`PRAGMA main.table_xinfo(${quoteSqliteIdentifier(name)})`)
      // SAFETY: Native table_xinfo provides string/null column fields and integer flags/positions.
      .all() as SqliteColumnCatalog[]
  );
}

function compareJson(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
