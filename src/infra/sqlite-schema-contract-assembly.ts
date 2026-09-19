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

export type SqliteIndexListRow = {
  name: string;
  origin: string;
  partial: number;
  unique: number;
};

export type SqliteIndexTermRow = {
  cid: number;
  coll: string;
  desc: number;
  key: number;
  name: string | null;
  seqno: number;
};

type SqliteIndexTermContract = Omit<SqliteIndexTermRow, "cid"> & {
  kind: "column" | "expression" | "rowid";
};

export type SqliteSchemaRow = {
  name: string;
  sql: string | null;
  tbl_name?: string;
};

export type SqliteTableListRow = {
  name: string;
  strict: number;
  wr: number;
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
  triggers: SqliteSchemaRow[],
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
    definition: isVirtualTable ? null : parseTableDefinition(table.sql, tableName),
    indexes,
    strict: tableList.strict,
    triggers: normalizedTriggers,
    virtualTableSql: isVirtualTable ? normalizedTableSql : null,
    withoutRowid: tableList.wr,
  };
}

export function createSqliteIndexContract(
  index: SqliteIndexListRow,
  schemaSql: string | null,
  rows: SqliteIndexTermRow[],
): SqliteIndexContract {
  const terms = rows.map(({ cid, coll, desc, key, name, seqno }) => ({
    coll,
    desc,
    key,
    kind: sqliteIndexTermKind(cid),
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

function sqliteIndexTermKind(cid: number): SqliteIndexTermContract["kind"] {
  return cid === -2 ? "expression" : cid === -1 ? "rowid" : "column";
}

function parseTableDefinition(sql: string | null, tableName: string): SqliteTableDefinition {
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
