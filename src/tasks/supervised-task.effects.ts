import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { expireSupervisedTask } from "./supervised-task.transitions.js";
import type { SupervisedTask } from "./supervised-task.types.js";

/** Ending the coordinator episode does not prove a separately owned operation
 * stopped. Its later receipt remains independent of this immutable endpoint. */
export function supervisedEpisodeHasDispatchedEffects(
  db: DatabaseSync,
  task: SupervisedTask,
): boolean {
  if (task.attempt?.dispatched) {
    return true;
  }
  if (!tableExists(db, "task_flow_operation_executions")) {
    return false;
  }
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<DB>(db)
        .selectFrom("task_flow_operation_executions as x")
        .innerJoin("task_flow_operations as o", "o.operation_id", "x.operation_id")
        .select("x.execution_id")
        .where("o.flow_id", "=", task.flowId)
        .where("o.episode", "=", task.episode)
        .where("x.dispatched_at_ms", "is not", null)
        .limit(1),
    ),
  );
}
export function expireSupervisedEpisodeInTransaction(
  db: DatabaseSync,
  task: SupervisedTask,
  now: number,
): SupervisedTask {
  const expired = expireSupervisedTask(task, now);
  return expired.endpoint && supervisedEpisodeHasDispatchedEffects(db, task)
    ? { ...expired, endpoint: { ...expired.endpoint, effects: "unknown" } }
    : expired;
}
