import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import type { NodeWorkerLaunchReceipt } from "./node-worker-launch-receipt.js";

/** Physical extinction closes unfinished turns, never a result already recorded by the worker. */
export function settleNodeWorkerActiveTurns(
  database: DatabaseSync,
  owner: NodeWorkerLaunchReceipt,
  schema = getAdmittedSqliteSchemaFacts(database),
): void {
  if (
    owner.state === "pending" ||
    owner.state === "running" ||
    !(schema ? schema.tables.has("node_worker_turns") : tableExists(database, "node_worker_turns"))
  ) {
    return;
  }
  executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<Pick<OpenClawStateDatabase, "node_worker_turns">>(database)
      .updateTable("node_worker_turns")
      .set((expression) => {
        const completedAt = expression.fn<number>("max", [
          "created_at_ms",
          "updated_at_ms",
          expression.val(owner.updatedAtMs),
        ]);
        return {
          state: owner.state === "completed" ? "interrupted" : owner.state,
          result_json: null,
          error_text: owner.errorText ?? "node worker stopped before its turn completed",
          completed_at_ms: completedAt,
          updated_at_ms: completedAt,
        };
      })
      .where("owner_launch_id", "=", owner.launchId)
      .where("state", "=", "running"),
  );
}
