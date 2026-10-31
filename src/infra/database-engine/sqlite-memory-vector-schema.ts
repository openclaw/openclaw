import type { DatabaseSync } from "node:sqlite";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "../sqlite-database-admission.js";
import { createSqliteTableContractReader } from "../sqlite-schema-catalog.js";
import type { SearchSchema } from "./contract.js";
import {
  buildSqliteMemoryVectorSchema,
  getSqliteMemorySearchFragmentFingerprint,
  matchesSqliteMemorySearchFragment,
} from "./sqlite-memory-search-fragments.js";

function vectorAdmission(tableName: string, dimensions: number): SqliteDatabaseAdmissionKey<true> {
  const descriptor = getSqliteMemorySearchFragmentFingerprint({
    kind: "vector",
    tableName,
    dimensions,
  });
  return {
    name: `memory.vector-schema:${JSON.stringify([tableName, dimensions, descriptor.fingerprint])}`,
    schemaDependent: true,
    read: (value) => (value === true ? true : undefined),
  };
}

/** Successful owner DDL publishes computed facts; it never rereads the table it just created. */
export function createSqliteMemoryVectorSchema(
  db: DatabaseSync,
  tableName: string,
  dimensions: number,
  ifNotExists: boolean,
): void {
  // sqlite-allow-raw: Engine-owned virtual-table DDL cannot be expressed through the query builder.
  db.exec(buildSqliteMemoryVectorSchema({ tableName, dimensions, ifNotExists }));
  if (!ifNotExists) {
    publishSqliteDatabaseAdmission(db, vectorAdmission(tableName, dimensions), true);
  }
}

/** Dimensions are declared by the memory owner; admission says nothing about index completeness. */
export function admitSqliteMemoryVectorSearch(db: DatabaseSync, definition: SearchSchema): void {
  const index = definition.vector!.chunks!;
  const dimensions = index.postgres!.dimensions;
  const key = vectorAdmission(index.table, dimensions);
  if (getSqliteDatabaseAdmission(db, key)) {
    return;
  }
  const catalog = createSqliteTableContractReader(db, [index.table]).readCatalog(
    [index.table],
    [index.table],
  );
  if (!catalog.tables.some((table) => table.name === index.table)) {
    if (catalog.views.some((view) => view.name === index.table)) {
      throw new Error(`cannot modify ${index.table} because it is a view`);
    }
    createSqliteMemoryVectorSchema(db, index.table, dimensions, false);
    return;
  }
  if (
    !matchesSqliteMemorySearchFragment(catalog, {
      kind: "vector",
      tableName: index.table,
      dimensions,
    })
  ) {
    throw new Error(
      `Memory vector schema differs for ${index.table}; rebuild the derived memory index.`,
    );
  }
  publishSqliteDatabaseAdmission(db, key, true);
}
