import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { readStateSchemaContentVersion } from "./openclaw-state-db-schema-version.js";
import type { DB } from "./openclaw-state-db.generated.js";

// Valid v1 stores can carry optional writer metadata, such as the normalized 2026.7.1 stamp.
// That app_version does not establish that the store ever had a deletion journal.
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
