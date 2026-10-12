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
  return recordCompletion(binding, "lineage");
}

/** Only the admitted Linux owner calls this after closing admission and kernel ECHILD. */
export function recordNodeWorkerDescendantsReaped(binding: NodeWorkerCleanupBinding): boolean {
  return recordCompletion(binding, "descendants");
}

function recordCompletion(
  binding: NodeWorkerCleanupBinding,
  completion: "lineage" | "descendants",
): boolean {
  const worker = requireNodeWorkerProcessIdentity(process.pid);
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      const current = readNodeWorkerLaunchReceipt(db, binding.launchId);
      if (
        !current ||
        current.state !== "running" ||
        current.planHash !== binding.planHash ||
        current.workerCleanupMode !==
          (completion === "descendants" ? "linux-subreaper" : "owned-anchor") ||
        current.container ||
        current.supervisor.pid !== binding.supervisor.pid ||
        current.supervisor.startTime !== binding.supervisor.startTime ||
        current.worker?.pid !== worker.pid ||
        current.worker.startTime !== worker.startTime ||
        inspectNodeWorkerProcessIdentity(worker) !== "live"
      ) {
        return false;
      }
      const query =
        getNodeSqliteKysely<
          Pick<
            OpenClawStateDatabase,
            "node_worker_launch_cleanup" | "node_worker_launch_process_scopes"
          >
        >(db);
      const result =
        completion === "descendants"
          ? executeSqliteQuerySync(
              db,
              query
                .updateTable("node_worker_launch_process_scopes")
                .set({ descendants_reaped: 1 })
                .where("launch_id", "=", binding.launchId)
                .where("scope_kind", "=", "linux-subreaper"),
            )
          : executeSqliteQuerySync(
              db,
              query
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
    {
      schemaSql:
        COMPLETION_SCHEMA +
        (completion === "descendants"
          ? "\n" +
            extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "node_worker_launch_process_scopes")
          : ""),
      operationLabel: "node-worker-launch." + completion + "-settled",
    },
  );
}
