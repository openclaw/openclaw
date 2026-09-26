import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import type { NodeWorkerCleanupBinding } from "./node-worker-launch-receipt.js";
import { readNodeWorkerLaunchReceipt } from "./node-worker-launch-store.kernel.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";

const COMPLETION_SCHEMA = ["node_worker_launches", "node_worker_launch_cleanup"]
  .map((table) => extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table))
  .join("\n");

/** The anchor records root exit and positive lineage EOF before extinguishing its own group. */
export function recordNodeWorkerLineageSettled(binding: NodeWorkerCleanupBinding): boolean {
  const worker = requireNodeWorkerProcessIdentity(process.pid);
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      const current = readNodeWorkerLaunchReceipt(db, binding.launchId);
      if (
        !current ||
        current.state !== "running" ||
        current.planHash !== binding.planHash ||
        current.workerCleanupMode !== "owned-anchor" ||
        current.container ||
        current.supervisor.pid !== binding.supervisor.pid ||
        current.supervisor.startTime !== binding.supervisor.startTime ||
        current.worker?.pid !== worker.pid ||
        current.worker.startTime !== worker.startTime ||
        inspectNodeWorkerProcessIdentity(worker) !== "live"
      ) {
        return false;
      }
      const result = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Pick<OpenClawStateDatabase, "node_worker_launch_cleanup">>(db)
          .updateTable("node_worker_launch_cleanup")
          .set({ lineage_settled: 1 })
          .where("launch_id", "=", binding.launchId)
          .where("cleanup_mode", "=", "owned-anchor"),
      );
      return result.numAffectedRows === 1n;
    },
    {
      path: binding.databasePath,
      env: {
        ...process.env,
        OPENCLAW_SUPERVISOR_MODE: binding.externallySupervised ? "external" : undefined,
      },
    },
    { schemaSql: COMPLETION_SCHEMA, operationLabel: "node-worker-launch.lineage-settled" },
  );
}
