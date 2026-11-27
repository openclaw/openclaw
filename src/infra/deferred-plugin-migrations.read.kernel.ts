import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import {
  DEFERRED_PLUGIN_MIGRATION_RUN_PREFIX as RUN_PREFIX,
  deferredPluginMigrationSchema,
} from "./deferred-plugin-migrations.contract.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import type { EngineConnection } from "./sql-connection.js";

// Read workers need the ledger query, never the migration writer's runtime.
export function readPendingMigrationRows(database: EngineConnection, includeDeferred = false) {
  return executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<Pick<DB, "migration_runs">>(database)
      .selectFrom("migration_runs")
      .select(["id", "report_json", "status"])
      .where("id", "like", `${RUN_PREFIX}%`)
      .where("status", "in", includeDeferred ? ["pending", "deferred"] : ["pending"])
      .orderBy("id"),
  ).rows;
}

export function pendingMigrationRecords(rows: ReturnType<typeof readPendingMigrationRows>) {
  return rows.map((row) => deferredPluginMigrationSchema.parse(JSON.parse(row.report_json)));
}

export function readPendingMigrationRecords(database: EngineConnection, includeDeferred = false) {
  return tableExists(database, "migration_runs")
    ? pendingMigrationRecords(readPendingMigrationRows(database, includeDeferred))
    : [];
}

export const deferredPluginMigrationReadOperations = {
  "plugins.deferredMigrations.read": (input: { includeDeferred?: boolean } | undefined, db) => ({
    type: "plugins.deferredMigrations.read" as const,
    pending: readPendingMigrationRecords(db, input?.includeDeferred),
  }),
} satisfies WorkerOperationHandlers<EngineConnection>;
