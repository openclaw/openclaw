import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";

export const legacySessionMigrationReadOperations = {
  "legacySessionMigration.readLedger": (_input: undefined, database: EngineConnection) => ({
    type: "legacySessionMigration.readLedger" as const,
    row: executeSqliteQueryTakeFirstSync(
      database,
      getNodeSqliteKysely<Pick<DB, "migration_sources">>(database)
        .selectFrom("migration_sources")
        .select(["report_json", "status"])
        .where("source_key", "=", "legacy-main-session-keys"),
    ),
  }),
};
