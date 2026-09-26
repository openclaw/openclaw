import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  applyFlowPatch,
  areTaskFlowRecordsEqual,
  buildFlowRecord,
  buildTaskMirroredFlowCreateFields,
  normalizeRestoredFlowRecord,
} from "./task-flow-registry.records.js";
import {
  bindTaskFlowRecord,
  deleteTaskFlowRowInDatabase,
  readTaskFlowRecord,
  upsertTaskFlowRowInDatabase,
} from "./task-flow-registry.store.kernel.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  buildManagedFlowCancellationPatch,
  isOneTaskFlowEligible,
} from "./task-initial-flow.rules.js";
import { assertParentFlowRecordLinkAllowed } from "./task-registry-parent-flow-rules.js";
import { applyTaskRecordPatch } from "./task-registry-records.js";
import {
  bindTaskRecord,
  listTaskRecordsForFlowReadInDatabase,
  readTaskRecord,
  upsertTaskRunRowInDatabase,
} from "./task-registry.store.kernel.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

export type InitialTaskFlowFacts = {
  task: TaskRecord | null;
  flow: TaskFlowRecord | null;
};

export type InitialTaskFlowCreateInput = {
  taskId: string;
  flowId: string;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
};

export type InitialTaskFlowCreateResult =
  | { created: false; task: TaskRecord | null }
  | { created: true; task: TaskRecord; flow: TaskFlowRecord };

export type InitialTaskFlowLinkInput = {
  taskId: string;
  flow: TaskFlowRecord;
  now: number;
};

export type InitialTaskFlowLinkResult =
  | ({ linked: false } & InitialTaskFlowFacts)
  | { linked: true; task: TaskRecord; previous: TaskRecord; flow: TaskFlowRecord };

export type InitialTaskFlowDeleteInput = {
  taskId: string;
  flow: TaskFlowRecord;
};

export type InitialTaskFlowDeleteResult = {
  deleted: boolean;
  flow: TaskFlowRecord | null;
};

export type InitialTaskManagedCancellationResult =
  | ({ changed: false } & InitialTaskFlowFacts)
  | { changed: true; task: TaskRecord; flow: TaskFlowRecord; previous: TaskFlowRecord };

function assertWriteTransaction(db: DatabaseSync): void {
  if (!db.isTransaction) {
    throw new Error("Initial task-flow mutation requires a write transaction");
  }
}

/** Each stage commits separately; the caller publishes before admitting the next stage. */
export function createInitialTaskFlowInDatabase(
  db: DatabaseSync,
  input: InitialTaskFlowCreateInput,
  assertCurrent?: (facts: InitialTaskFlowFacts) => void,
): InitialTaskFlowCreateResult {
  assertWriteTransaction(db);
  const task = readTaskRecord(db, input.taskId);
  if (!task || !isOneTaskFlowEligible(task)) {
    return { created: false, task: task ?? null };
  }
  if (!input.flowId.trim() || readTaskFlowRecord(db, input.flowId)) {
    throw new Error("Initial task flow requires an unused flow ID");
  }
  const flow = {
    ...buildFlowRecord(
      buildTaskMirroredFlowCreateFields({ task, requesterOrigin: input.requesterOrigin }),
    ),
    flowId: input.flowId,
  };
  assertCurrent?.({ task, flow });
  upsertTaskFlowRowInDatabase(db, bindTaskFlowRecord(flow));
  return { created: true, task, flow };
}

export function linkInitialTaskFlowInDatabase(
  db: DatabaseSync,
  input: InitialTaskFlowLinkInput,
  assertCurrent?: (facts: InitialTaskFlowFacts) => void,
): InitialTaskFlowLinkResult {
  assertWriteTransaction(db);
  const task = readTaskRecord(db, input.taskId) ?? null;
  const flow = readTaskFlowRecord(db, input.flow.flowId) ?? null;
  if (
    !task ||
    !isOneTaskFlowEligible(task) ||
    !flow ||
    flow.syncMode !== "task_mirrored" ||
    !areTaskFlowRecordsEqual(flow, input.flow)
  ) {
    return { linked: false, task, flow };
  }
  assertParentFlowRecordLinkAllowed(
    { ownerKey: task.ownerKey, scopeKind: task.scopeKind, parentFlowId: flow.flowId },
    flow,
  );
  const linked = applyTaskRecordPatch(task, { parentFlowId: flow.flowId }, input.now);
  assertCurrent?.({ task, flow });
  // Linking changes only the task row; retain the current delivery state byte-for-byte.
  upsertTaskRunRowInDatabase({ db }, bindTaskRecord(linked));
  return { linked: true, task: linked, previous: task, flow };
}

export function deleteUnlinkedInitialTaskFlowInDatabase(
  db: DatabaseSync,
  input: InitialTaskFlowDeleteInput,
  assertCurrent?: (facts: InitialTaskFlowFacts) => void,
): InitialTaskFlowDeleteResult {
  assertWriteTransaction(db);
  const flow = readTaskFlowRecord(db, input.flow.flowId) ?? null;
  if (!flow || flow.syncMode !== "task_mirrored" || !areTaskFlowRecordsEqual(flow, input.flow)) {
    return { deleted: false, flow };
  }
  // A different task may adopt this flow while creation and linking publish separately.
  const linked = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("task_runs")
      .select("task_id")
      .where((eb) => eb(eb.fn<string>("trim", [eb.ref("parent_flow_id")]), "=", flow.flowId))
      .limit(1),
  );
  if (linked) {
    return { deleted: false, flow };
  }
  assertCurrent?.({ task: readTaskRecord(db, input.taskId) ?? null, flow });
  deleteTaskFlowRowInDatabase(db, flow.flowId);
  return { deleted: true, flow };
}

export function finalizeInitialTaskManagedCancellationInDatabase(
  db: DatabaseSync,
  input: { taskId: string; flowId: string; now: number },
  assertCurrent?: (facts: InitialTaskFlowFacts) => void,
): InitialTaskManagedCancellationResult {
  assertWriteTransaction(db);
  const task = readTaskRecord(db, input.taskId) ?? null;
  if (!task || task.parentFlowId?.trim() !== input.flowId) {
    return { changed: false, task, flow: null };
  }
  const stored = readTaskFlowRecord(db, input.flowId);
  if (!stored) {
    return { changed: false, task, flow: null };
  }
  const flow = normalizeRestoredFlowRecord(stored);
  const patch = buildManagedFlowCancellationPatch(
    task,
    flow,
    () => listTaskRecordsForFlowReadInDatabase(db, flow.flowId),
    input.now,
  );
  if (!patch) {
    return { changed: false, task, flow };
  }
  const next = applyFlowPatch(flow, patch);
  assertCurrent?.({ task, flow });
  upsertTaskFlowRowInDatabase(db, bindTaskFlowRecord(next));
  return { changed: true, task, flow: next, previous: flow };
}
