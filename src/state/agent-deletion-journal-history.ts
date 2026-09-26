import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { readStateSchemaContentVersion } from "./openclaw-state-db-schema-version.js";
import type { DB } from "./openclaw-state-db.generated.js";

/** The published July extended-stable schema predates journal ownership (introduced in v5). */
export function hasPreJournalStateSchema(database: DatabaseSync): boolean {
  if (
    readStateSchemaContentVersion(database) !== 1 ||
    tableExists(database, "config_machine_state") ||
    tableExists(database, "agent_database_leases") ||
    !tableExists(database, "agent_databases") ||
    !tableExists(database, "migration_sources")
  ) {
    return false;
  }
  const db = getNodeSqliteKysely<Pick<DB, "schema_meta" | "migration_sources">>(database);
  const metadata = executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("schema_meta").selectAll().where("meta_key", "=", "primary"),
  );
  return (
    metadata?.role === "global" &&
    metadata.schema_version === 1 &&
    metadata.agent_id === null &&
    metadata.app_version === null &&
    !executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("migration_sources")
        .select("source_key")
        .where("target_table", "=", "agent_deletion_journal")
        .limit(1),
    )
  );
}
