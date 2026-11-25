import { readSqliteSchemaCatalog } from "../../scripts/lib/sqlite-schema-catalog.mts";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import type { SqliteSchemaCatalog, SqliteSchemaSource } from "./sqlite-schema-catalog-types.js";
import {
  assertSqliteSchemaContains as assertContains,
  assertSqliteSchemaTablesPresent as assertTablesPresent,
  collectSqliteSchemaIssues as collectIssues,
} from "./sqlite-schema-contract.js";

const fixtures = new Map<string, SqliteSchemaCatalog>();

/** Synthetic and frozen previous-release DDL is not part of the generated runtime inventory. */
export function sqliteSchemaFixture(source: SqliteSchemaSource): SqliteSchemaCatalog {
  if (typeof source !== "string") {
    return source;
  }
  let catalog = fixtures.get(source);
  if (!catalog) {
    const database = openNodeSqliteDatabase(":memory:");
    try {
      database.exec(source);
      catalog = readSqliteSchemaCatalog(database);
      fixtures.set(source, catalog);
    } finally {
      database.close();
    }
  }
  return catalog;
}

export function assertSqliteSchemaContains(...args: Parameters<typeof assertContains>): void {
  const [database, label, schema, ...options] = args;
  assertContains(database, label, sqliteSchemaFixture(schema), ...options);
}

export function assertSqliteSchemaTablesPresent(
  ...args: Parameters<typeof assertTablesPresent>
): void {
  const [database, label, schema, ...options] = args;
  assertTablesPresent(database, label, sqliteSchemaFixture(schema), ...options);
}

export function collectSqliteSchemaIssues(...args: Parameters<typeof collectIssues>) {
  const [database, schema, ...options] = args;
  return collectIssues(database, sqliteSchemaFixture(schema), ...options);
}
