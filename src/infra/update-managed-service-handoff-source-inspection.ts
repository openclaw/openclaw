import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";

/** Match every schema object, including wrong shapes, using SQLite's identifier casing. */
export function hasManagedHandoffSchemaObject(db: DatabaseSync): boolean {
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<{ sqlite_schema: { name: string } }>(db)
        .selectFrom("sqlite_schema")
        .select("name")
        .where((eb) => eb(eb.fn<string>("lower", ["name"]), "=", "managed_update_handoffs")),
    ),
  );
}

/** A first writer may have created the private inode before SQLite commits its schema. */
export function isManagedHandoffSchemaEmpty(db: DatabaseSync): boolean {
  return !executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<{ sqlite_schema: { name: string } }>(db)
      .selectFrom("sqlite_schema")
      .select("name")
      .limit(1),
  );
}
