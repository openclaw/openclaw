import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import type { SqliteSchemaCatalog } from "./sqlite-schema-catalog-types.js";
import { readSqliteSchemaCatalog } from "./sqlite-schema-catalog.js";
import {
  assertSqliteSchemaContains,
  type SqliteSchemaCompatibility,
  type SqliteTableContractReader,
} from "./sqlite-schema-contract.js";

/** Memory migrations accept caller-selected table identifiers, so their catalogs cannot be generated. */
function buildDynamicSqliteSchemaCatalog(schemaSql: string): SqliteSchemaCatalog {
  const database = openNodeSqliteDatabase(":memory:");
  try {
    database.exec(schemaSql);
    return readSqliteSchemaCatalog(database);
  } finally {
    database.close();
  }
}

const dynamicCatalogs = new Map<string, SqliteSchemaCatalog>();

export function assertDynamicSqliteSchemaContains(
  database: DatabaseSync,
  databaseLabel: string,
  schemaSql: string,
  compatibility: SqliteSchemaCompatibility = {},
  readTable?: SqliteTableContractReader,
): void {
  let catalog = dynamicCatalogs.get(schemaSql);
  if (!catalog) {
    catalog = buildDynamicSqliteSchemaCatalog(schemaSql);
    dynamicCatalogs.set(schemaSql, catalog);
  }
  assertSqliteSchemaContains(database, databaseLabel, catalog, compatibility, readTable);
}
