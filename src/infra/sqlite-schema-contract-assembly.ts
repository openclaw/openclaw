import type {
  SqliteColumnCatalog,
  SqliteForeignKeyCatalog,
  SqliteIndexListRow,
  SqliteIndexTermRow,
  SqliteSchemaRow,
  SqliteTableListRow,
} from "./sqlite-schema-catalog-types.js";
import {
  findSqlCharacter,
  findSqlClosingParenthesis,
  normalizeSchemaSql,
  normalizeSqlIdentifier,
  normalizeSqlWhitespace,
  readSqlToken,
  readTableConstraintKeyword,
  splitSqlList,
} from "./sqlite-schema-sql.js";

type SqliteIndexTermContract = Omit<SqliteIndexTermRow, "cid"> & {
  kind: "column" | "expression" | "rowid";
};

export type SqliteIndexContract = {
  name: string | null;
  origin: string;
  partial: number;
  sql: string | null;
  terms: SqliteIndexTermContract[];
  unique: number;
};

export type SqliteTableDefinition = {
  columns: Map<string, string>;
  constraints: string[];
};

export type SqliteTableContract = {
  definition: SqliteTableDefinition | null;
  columns: readonly SqliteColumnCatalog[];
  foreignKeys: readonly SqliteForeignKeyCatalog[];
  indexes: SqliteIndexContract[];
  strict: number;
  triggers: Array<{ name: string; sql: string | null }>;
  virtualTableSql: string | null;
  withoutRowid: number;
};

export function createSqliteTableContract(
  tableName: string,
  table: SqliteSchemaRow,
  tableList: SqliteTableListRow,
  indexes: SqliteIndexContract[],
  triggers: readonly SqliteSchemaRow[],
  columns: readonly SqliteColumnCatalog[],
  foreignKeys: readonly SqliteForeignKeyCatalog[],
): SqliteTableContract {
  const normalizedTriggers = triggers.map((trigger) => ({
    name: trigger.name,
    sql: normalizeSchemaSql(trigger.sql),
  }));
  // This literal prefix cannot become CREATE VIRTUAL TABLE after normalization.
  const normalizedTableSql = table.sql?.startsWith("CREATE TABLE ")
    ? null
    : normalizeSchemaSql(table.sql);
  const isVirtualTable =
    normalizedTableSql !== null && /^CREATE VIRTUAL TABLE /iu.test(normalizedTableSql);

  return {
    definition: isVirtualTable ? null : parseSqliteTableDefinition(table.sql, tableName),
    indexes,
    columns,
    foreignKeys,
    strict: tableList.strict,
    triggers: normalizedTriggers,
    virtualTableSql: isVirtualTable ? normalizedTableSql : null,
    withoutRowid: tableList.wr,
  };
}

export function createSqliteIndexContract(
  index: SqliteIndexListRow,
  schemaSql: string | null,
  rows: readonly SqliteIndexTermRow[],
): SqliteIndexContract {
  const terms = rows.map<SqliteIndexTermContract>(({ cid, coll, desc, key, name, seqno }) => ({
    coll,
    desc,
    key,
    kind: cid === -2 ? "expression" : cid === -1 ? "rowid" : "column",
    name,
    seqno,
  }));
  return {
    name: index.name.startsWith("sqlite_autoindex_") ? null : index.name,
    origin: index.origin,
    partial: index.partial,
    sql: normalizeSchemaSql(schemaSql),
    terms,
    unique: index.unique,
  };
}

export function parseSqliteTableDefinition(
  sql: string | null,
  tableName: string,
): SqliteTableDefinition {
  if (sql === null) {
    throw new Error(`Could not inspect SQLite table definition for ${tableName}.`);
  }
  const open = findSqlCharacter(sql, "(");
  if (open === -1) {
    throw new Error(`SQLite table ${tableName} has no column definition.`);
  }
  const close = findSqlClosingParenthesis(sql, open);
  const columns = new Map<string, string>();
  const constraints: string[] = [];
  for (const rawDefinition of splitSqlList(sql.slice(open + 1, close))) {
    const definition = normalizeSqlWhitespace(rawDefinition);
    if (!definition) {
      continue;
    }
    const token = readSqlToken(definition, 0);
    if (!token) {
      throw new Error(`SQLite table ${tableName} contains an unreadable definition.`);
    }
    if (readTableConstraintKeyword(definition, token)) {
      constraints.push(definition);
      continue;
    }
    const columnName = normalizeSqlIdentifier(token.raw);
    if (columns.has(columnName)) {
      throw new Error(`SQLite table ${tableName} contains duplicate column ${columnName}.`);
    }
    columns.set(columnName, definition);
  }
  return {
    columns: new Map([...columns].toSorted(([left], [right]) => left.localeCompare(right))),
    constraints: constraints.toSorted(),
  };
}
