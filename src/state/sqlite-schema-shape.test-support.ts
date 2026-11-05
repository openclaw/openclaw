import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readRow, readRows } from "./openclaw-state-db-fixtures.test-support.js";

// Ignore autoindex suffixes, but preserve index terms, order, collation and predicates.
type ColumnShape = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
};

type IndexShape = {
  name: string;
  unique: number;
  origin: string;
  partial: number;
  sql: string | null;
  terms: IndexTermShape[];
};

type IndexTermShape = {
  kind: "column" | "expression" | "rowid";
  name: string | null;
  coll: string;
  desc: number;
};

type SqliteSchemaShape = Record<
  string,
  {
    columns: ColumnShape[];
    indexes: IndexShape[];
    strict: number;
  }
>;

type IndexListRow = Pick<IndexShape, "name" | "unique" | "origin" | "partial">;

export function hashSqliteSchema(database: DatabaseSync): string {
  const schema = readRows(
    database,
    `SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
  );
  return createHash("sha256").update(JSON.stringify(schema)).digest("hex");
}

/** Execute schema SQL in memory and return its comparable shape. */
export function createSqliteSchemaShapeFromSql(schemaUrl: URL): SqliteSchemaShape {
  using db = new DatabaseSync(":memory:");
  db.exec(readFileSync(schemaUrl, "utf8"));
  return collectSqliteSchemaShape(db);
}

/** Collect table columns and indexes from an open SQLite database. */
export function collectSqliteSchemaShape(db: DatabaseSync): SqliteSchemaShape {
  const tables = readRows(
    db,
    `SELECT m.name, t.strict FROM sqlite_master m
    JOIN pragma_table_list t ON t.schema = 'main' AND t.name = m.name
    WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name`,
  ) as { name: string; strict: number }[];
  return Object.fromEntries(
    tables.map(({ name, strict }) => [
      name,
      {
        columns: (
          readRows(
            db,
            'SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)',
            name,
          ) as ColumnShape[]
        ).toSorted((left, right) => left.name.localeCompare(right.name)),
        indexes: collectIndexes(db, name),
        strict,
      },
    ]),
  );
}

/** Normalize only DDL whitespace while preserving the full structured shape. */
export function normalizeSqliteSchemaShapeSql(shape: SqliteSchemaShape): SqliteSchemaShape {
  return Object.fromEntries(
    Object.entries(shape).map(([tableName, table]) => [
      tableName,
      {
        ...table,
        indexes: table.indexes.map((index) => ({
          ...index,
          sql: index.sql?.replace(/\s+/gu, " ").trim() ?? null,
        })),
      },
    ]),
  );
}

// Cover the whole repair registry, not a hand-picked index.
export function replaceNamedIndexesWithNoncanonicalIndexes(db: DatabaseSync): string[] {
  const indexes = readRows(
    db,
    `SELECT name, tbl_name FROM sqlite_schema
    WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`,
  ) as { name: string; tbl_name: string }[];

  for (const index of indexes) {
    const [firstColumn] = readRows(db, "SELECT name FROM pragma_table_info(?)", index.tbl_name);
    if (!firstColumn) {
      throw new Error(`SQLite table ${index.tbl_name} has no columns`);
    }
    db.exec(`
      DROP INDEX main.${quoteSqliteIdentifier(index.name)};
      CREATE INDEX main.${quoteSqliteIdentifier(index.name)} ON ${quoteSqliteIdentifier(index.tbl_name)}(
        ${quoteSqliteIdentifier(String(firstColumn.name))}, ${quoteSqliteIdentifier(String(firstColumn.name))}
      );
    `);
  }

  return indexes.map((index) => index.name);
}

function collectIndexes(db: DatabaseSync, tableName: string): IndexShape[] {
  return (
    readRows(
      db,
      'SELECT name, "unique", origin, partial FROM pragma_index_list(?)',
      tableName,
    ) as IndexListRow[]
  )
    .map(({ name, unique, origin, partial }) => {
      const row = readRow(
        db,
        "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?",
        name,
      );
      return {
        name: normalizeAutoIndexName(name),
        unique,
        origin,
        partial,
        sql: typeof row?.sql === "string" ? row.sql : null,
        terms: collectIndexTerms(db, name),
      };
    })
    .toSorted((left, right) => {
      const nameOrder = left.name.localeCompare(right.name);
      return nameOrder !== 0
        ? nameOrder
        : JSON.stringify(left).localeCompare(JSON.stringify(right));
    });
}

function collectIndexTerms(db: DatabaseSync, indexName: string): IndexTermShape[] {
  return readRows(
    db,
    `SELECT CASE cid WHEN -2 THEN 'expression' WHEN -1 THEN 'rowid'
    ELSE 'column' END AS kind, name, coll, "desc" FROM pragma_index_xinfo(?) WHERE key = 1`,
    indexName,
  ) as IndexTermShape[];
}

function normalizeAutoIndexName(name: string): string {
  return name.startsWith("sqlite_autoindex_") ? "sqlite_autoindex" : name;
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
