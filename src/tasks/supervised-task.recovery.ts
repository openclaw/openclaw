import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { appendSupervisedFaultNotificationInTransaction } from "./supervised-task.source.js";
import type { SupervisedTask } from "./supervised-task.types.js";
import {
  writeSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";
import { readSupervisedWorkflowContractInTransaction } from "./supervised-workflow.store.js";

const sql = (db: DatabaseSync) => getNodeSqliteKysely<DB>(db);
export function readSupervisedRecoveryInTransaction(
  db: DatabaseSync,
  flowId: string,
  episode: number,
) {
  if (!tableExists(db, "task_flow_recovery")) {
    return undefined;
  }
  return executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("task_flow_recovery")
      .selectAll()
      .where("flow_id", "=", flowId)
      .where("episode", "=", episode),
  );
}

/** Models edit private drafts. An abandoned draft is not promoted or replayed;
 * a fresh attempt reads the last accepted artifact and independent op receipts. */
export function recoverManagedSupervisedAttemptInTransaction(
  db: DatabaseSync,
  task: SupervisedTask,
  now: number,
): SupervisedTask | undefined {
  const contract = readSupervisedWorkflowContractInTransaction(db, task.flowId, task.episode);
  const previous = readSupervisedRecoveryInTransaction(db, task.flowId, task.episode);
  if (
    !contract ||
    previous?.fault_json ||
    task.endpoint ||
    task.policy.deadlineAt <= now ||
    task.attempts >= task.policy.maxAttempts ||
    (previous?.recoveries ?? 0) >= contract.contract.maxRecoveryAttempts
  ) {
    return undefined;
  }
  const recoveries = (previous?.recoveries ?? 0) + 1;
  executeSqliteQuerySync(
    db,
    sql(db)
      .insertInto("task_flow_recovery")
      .values({
        flow_id: task.flowId,
        episode: task.episode,
        recoveries,
        fault_json: null,
        updated_at_ms: now,
      })
      .onConflict((conflict) =>
        conflict.columns(["flow_id", "episode"]).doUpdateSet({ recoveries, updated_at_ms: now }),
      ),
  );
  return {
    ...task,
    attempt: null,
    phase: "ready",
    dueAt: now + Math.min(30_000, 1000 * 2 ** (recoveries - 1)),
    updatedAt: now,
    // The last accepted continuation may be an operator answer. Recovery
    // discards only the unaccepted draft, never that durable instruction.
    next: task.next,
  };
}

/** Preserve an unreadable/oversized legacy record byte-for-byte, with a separate
 * terminal fault owner. That row cannot block or regain authority over others. */
export function quarantineSupervisedTask(
  flowId: string,
  episode: number,
  now: number,
  options: Options = {},
) {
  writeSupervisedWorkflow(
    (db) => quarantineSupervisedTaskInTransaction(db, flowId, episode, now),
    options,
  );
}

export function quarantineSupervisedTaskInTransaction(
  db: DatabaseSync,
  flowId: string,
  episode: number,
  now: number,
  operationId?: string,
) {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("task_flow_episodes")
      .selectAll()
      .where("flow_id", "=", flowId)
      .where("episode", "=", episode),
  );
  if (!row || (!operationId && !["ready", "waiting", "running"].includes(row.phase))) {
    return;
  }
  const operation = operationId
    ? executeSqliteQueryTakeFirstSync(
        db,
        sql(db)
          .selectFrom("task_flow_operations")
          .select(["operation_id", "record_json"])
          .where("operation_id", "=", operationId)
          .where("flow_id", "=", flowId)
          .where("episode", "=", episode),
      )
    : undefined;
  if (operationId && !operation) {
    return;
  }
  const fault = {
    kind: "input_required",
    reason:
      "Stored task or operation could not be safely reconciled; original records preserved for repair",
    originalSha256: createHash("sha256").update(row.record_json).digest("hex"),
    originalRevision: row.revision,
    at: now,
    ...(operation
      ? {
          operationId: operation.operation_id,
          operationSha256: createHash("sha256").update(operation.record_json).digest("hex"),
        }
      : {}),
  };
  const recorded = executeSqliteQuerySync(
    db,
    sql(db)
      .insertInto("task_flow_recovery")
      .values({
        flow_id: flowId,
        episode,
        recoveries: 0,
        fault_json: JSON.stringify(fault),
        updated_at_ms: now,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["flow_id", "episode"])
          .doUpdateSet({
            fault_json: JSON.stringify(fault),
            updated_at_ms: now,
          })
          .where("task_flow_recovery.fault_json", "is", null),
      ),
  );
  if (recorded.numAffectedRows === 1n) {
    appendSupervisedFaultNotificationInTransaction(db, flowId, episode, row.revision, now);
  }
}

/** Filter quarantined records before applying capacity/page limits. Otherwise
 * enough broken episodes could starve every healthy task behind the first page. */
export function selectActiveSupervisedEpisodes(db: DatabaseSync) {
  let query = sql(db)
    .selectFrom("task_flow_episodes")
    .where("phase", "in", ["ready", "waiting", "running"]);
  if (tableExists(db, "task_flow_recovery")) {
    query = query.where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("task_flow_recovery as recovery")
            .select("recovery.flow_id")
            .whereRef("recovery.flow_id", "=", "task_flow_episodes.flow_id")
            .whereRef("recovery.episode", "=", "task_flow_episodes.episode")
            .where("recovery.fault_json", "is not", null),
        ),
      ),
    );
  }
  return query;
}
