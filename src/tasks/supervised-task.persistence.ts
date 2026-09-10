import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { appendSupervisedNotificationInTransaction } from "./supervised-task.source.js";
import {
  serializeSupervisedTaskForWrite,
  validateSupervisedTask,
  type SupervisedTask,
} from "./supervised-task.types.js";
type Database = Pick<DB, "task_flow_episodes" | "task_flow_supervisors">;

export function readTask(
  db: DatabaseSync,
  flowId: string,
  episode?: number,
): SupervisedTask | undefined {
  let query = getNodeSqliteKysely<Database>(db)
    .selectFrom("task_flow_episodes")
    .selectAll()
    .where("flow_id", "=", flowId);
  if (episode !== undefined) {
    query = query.where("episode", "=", episode);
  }
  const row = executeSqliteQueryTakeFirstSync(db, query.orderBy("episode", "desc").limit(1));
  if (!row) {
    return undefined;
  }
  return decodeTaskRow(row);
}

export function decodeTaskRow(row: Selectable<DB["task_flow_episodes"]>): SupervisedTask {
  const task = validateSupervisedTask(JSON.parse(row.record_json));
  if (
    row.revision !== task.revision ||
    row.phase !== task.phase ||
    row.flow_id !== task.flowId ||
    row.episode !== task.episode ||
    row.due_at_ms !== task.dueAt ||
    row.deadline_at_ms !== task.policy.deadlineAt
  ) {
    throw new Error("Supervised TaskFlow row identity disagrees with its record");
  }
  return task;
}

function rowForTask(task: SupervisedTask, previous?: SupervisedTask) {
  const recordJson = serializeSupervisedTaskForWrite(task, previous);
  return {
    flow_id: task.flowId,
    episode: task.episode,
    revision: task.revision,
    phase: task.phase,
    due_at_ms: task.dueAt,
    deadline_at_ms: task.policy.deadlineAt,
    record_json: recordJson,
  };
}

export function insertTask(db: DatabaseSync, task: SupervisedTask): SupervisedTask {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<Database>(db).insertInto("task_flow_episodes").values(rowForTask(task)),
  );
  return task;
}

export function replaceTask(
  db: DatabaseSync,
  previous: SupervisedTask,
  next: SupervisedTask,
): SupervisedTask {
  if (previous.endpoint) {
    throw new Error("An episode endpoint cannot be rewritten");
  }
  const task = {
    ...next,
    lastAttemptId: previous.attempt && !next.attempt ? previous.attempt.id : next.lastAttemptId,
    revision: previous.revision + 1,
  };
  const result = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<Database>(db)
      .updateTable("task_flow_episodes")
      .set(rowForTask(task, previous))
      .where("flow_id", "=", previous.flowId)
      .where("episode", "=", previous.episode)
      .where("revision", "=", previous.revision),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error("Supervised TaskFlow revision conflict");
  }
  if (task.endpoint) {
    appendSupervisedNotificationInTransaction(db, task, "endpoint");
  }
  return task;
}

export function supervisorCurrent(
  db: DatabaseSync,
  ownerId: string,
  now: number,
  flowId: string,
): boolean {
  return (
    executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<Database>(db)
        .selectFrom("task_flow_supervisors")
        .select("owner_id")
        .where("owner_id", "=", ownerId)
        .where("stopped_at_ms", "is", null)
        .where("expires_at_ms", ">", now)
        .where((eb) => eb.or([eb("flow_id", "is", null), eb("flow_id", "=", flowId)])),
    ) !== undefined
  );
}
