import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import {
  applySupervisedDecision,
  endSupervisedTask,
  expireSupervisedTask,
} from "./supervised-task.transitions.js";
import {
  validateSupervisedTask,
  type SupervisedDecision,
  type SupervisedGoal,
  type SupervisedPolicy,
  type SupervisedTask,
} from "./supervised-task.types.js";

type Database = Pick<DB, "task_flow_episodes" | "task_flow_supervisors">;
type Options = OpenClawStateDatabaseOptions;
function readSnapshot<T>(
  operation: (database: { db: DatabaseSync }) => T,
  options: Options,
): T | undefined {
  return withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => runSqliteDeferredTransactionSync(db, () => operation({ db })),
    options,
  );
}
const activePhases = ["ready", "waiting", "running"];
const MAX_ACTIVE_EPISODES = 128;
const schemaStart = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
  "CREATE TABLE IF NOT EXISTS task_flow_episodes (",
);
const schemaEnd = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
  "CREATE TABLE IF NOT EXISTS flow_runs (",
  schemaStart,
);
if (schemaStart < 0 || schemaEnd < 0) {
  throw new Error("Supervised TaskFlow schema missing");
}
const schema = OPENCLAW_STATE_SCHEMA_SQL.slice(schemaStart, schemaEnd);

function readTask(db: DatabaseSync, flowId: string, episode?: number): SupervisedTask | undefined {
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

function decodeTaskRow(row: Selectable<DB["task_flow_episodes"]>): SupervisedTask {
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

function write<T>(operation: (db: DatabaseSync) => T, options: Options): T {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.exec(schema); // sqlite-allow-raw -- Canonical first-use additive DDL in the admitting transaction.
      return operation(db);
    },
    options,
    { operationLabel: "taskflow.supervision" },
  );
}

function rowForTask(task: SupervisedTask) {
  validateSupervisedTask(task);
  return {
    flow_id: task.flowId,
    episode: task.episode,
    revision: task.revision,
    phase: task.phase,
    due_at_ms: task.dueAt,
    deadline_at_ms: task.policy.deadlineAt,
    record_json: JSON.stringify(task),
  };
}

function insertTask(db: DatabaseSync, task: SupervisedTask): SupervisedTask {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<Database>(db).insertInto("task_flow_episodes").values(rowForTask(task)),
  );
  return task;
}

function replaceTask(
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
      .set(rowForTask(task))
      .where("flow_id", "=", previous.flowId)
      .where("episode", "=", previous.episode)
      .where("revision", "=", previous.revision),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error("Supervised TaskFlow revision conflict");
  }
  return task;
}

function supervisorCurrent(
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

export function heartbeatTaskSupervisor(
  ownerId: string,
  now: number,
  ttlMs: number,
  options: Options = {},
  flowId?: string,
): void {
  if (!ownerId || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 60_000) {
    throw new Error("Invalid supervisor heartbeat");
  }
  write((db) => {
    const renewed = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<Database>(db)
        .insertInto("task_flow_supervisors")
        .values({
          owner_id: ownerId,
          flow_id: flowId ?? null,
          observed_at_ms: now,
          expires_at_ms: now + ttlMs,
          stopped_at_ms: null,
        })
        .onConflict((conflict) =>
          conflict
            .column("owner_id")
            .doUpdateSet({ observed_at_ms: now, expires_at_ms: now + ttlMs, stopped_at_ms: null })
            .where("task_flow_supervisors.stopped_at_ms", "is", null)
            .where("task_flow_supervisors.expires_at_ms", ">", now)
            .where("task_flow_supervisors.flow_id", flowId ? "=" : "is", flowId ?? null),
        ),
    );
    if (renewed.numAffectedRows !== 1n) {
      throw new Error("Expired or stopped supervisor cannot renew; start a new owner");
    }
    // Retain stopped/expired owner tombstones: deleting one could let a stale
    // process insert the same identity again and resurrect revoked authority.
  }, options);
}

export function stopTaskSupervisor(ownerId: string, now: number, options: Options = {}): void {
  write((db) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<Database>(db)
        .updateTable("task_flow_supervisors")
        .set({ stopped_at_ms: now, expires_at_ms: now })
        .where("owner_id", "=", ownerId),
    );
  }, options);
}

export type SupervisedTaskInput = {
  flowId?: string;
  agentId: string;
  model: string;
  runtime: SupervisedTask["runtime"];
  prompt: string;
  goal?: SupervisedGoal;
  policy: SupervisedPolicy;
};

export function createSupervisedTask(
  input: SupervisedTaskInput,
  ownerId: string,
  now: number,
  options: Options = {},
): SupervisedTask {
  return write((db) => {
    const flowId = input.flowId ?? randomUUID();
    if (!supervisorCurrent(db, ownerId, now, flowId)) {
      throw new Error("No current supervisor accepted custody; start tasks supervise work first");
    }
    if (input.policy.deadlineAt <= now) {
      throw new Error("Task deadline must be in the future");
    }
    assertAdmissionCapacity(db);
    if (readTask(db, flowId)) {
      throw new Error("Supervised TaskFlow already exists");
    }
    return insertTask(
      db,
      validateSupervisedTask({
        version: 1,
        flowId,
        episode: 1,
        revision: 0,
        agentId: input.agentId,
        model: input.model,
        runtime: input.runtime,
        prompt: input.prompt,
        goal: input.goal ?? null,
        goalSource: input.goal ? "operator" : null,
        policy: input.policy,
        phase: "ready",
        next: input.prompt,
        dueAt: now,
        attempts: 0,
        lastAttemptId: null,
        attempt: null,
        endpoint: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }, options);
}

export function getSupervisedTask(
  flowId: string,
  options: Options = {},
  episode?: number,
): SupervisedTask | undefined {
  return readSnapshot(
    ({ db }) => (tableExists(db, "task_flow_episodes") ? readTask(db, flowId, episode) : undefined),
    options,
  );
}

export function listSupervisedTasks(options: Options = {}, activeOnly = false): SupervisedTask[] {
  return (
    readSnapshot(({ db }) => {
      if (!tableExists(db, "task_flow_episodes")) {
        return [];
      }
      let query = getNodeSqliteKysely<Database>(db).selectFrom("task_flow_episodes").selectAll();
      if (activeOnly) {
        query = query.where("phase", "in", activePhases);
      }
      return executeSqliteQuerySync(
        db,
        query.orderBy("due_at_ms").orderBy("flow_id").limit(256),
      ).rows.map(decodeTaskRow);
    }, options) ?? []
  );
}

/** Claim and dispatch reservation are separate; crashing before dispatch is safe to recover. */
export function claimSupervisedTask(
  flowId: string,
  ownerId: string,
  now: number,
  options: Options = {},
): SupervisedTask | undefined {
  return write((db) => {
    const task = readTask(db, flowId);
    if (!task || task.endpoint || !supervisorCurrent(db, ownerId, now, flowId)) {
      return undefined;
    }
    if (now >= task.policy.deadlineAt) {
      return replaceTask(db, task, expireSupervisedTask(task, now));
    }
    if (task.attempt) {
      if (
        task.attempt.expiresAt > now &&
        supervisorCurrent(db, task.attempt.ownerId, now, task.flowId)
      ) {
        return undefined;
      }
      if (task.attempt.dispatched) {
        return replaceTask(db, task, expireSupervisedTask(task, now));
      }
      // No dispatch reservation exists. A successor can safely reclaim, but
      // this still consumes an attempt: crashes cannot reset the episode budget.
    } else if (task.dueAt > now) {
      return undefined;
    }
    if (task.attempts >= task.policy.maxAttempts) {
      return replaceTask(db, task, expireSupervisedTask(task, now));
    }
    const expiresAt = Math.min(task.policy.deadlineAt, now + task.policy.attemptTimeoutMs);
    return replaceTask(db, task, {
      ...task,
      phase: "running",
      attempts: task.attempts + 1,
      dueAt: expiresAt,
      attempt: { id: randomUUID(), ownerId, startedAt: now, expiresAt, dispatched: false },
      updatedAt: now,
    });
  }, options);
}

function readOwnedTask(db: DatabaseSync, expected: SupervisedTask, now: number): SupervisedTask {
  const task = readTask(db, expected.flowId, expected.episode);
  if (
    !task?.attempt ||
    !expected.attempt ||
    task.attempt.id !== expected.attempt.id ||
    task.attempt.ownerId !== expected.attempt.ownerId ||
    task.phase !== "running" ||
    task.attempt.expiresAt <= now ||
    task.policy.deadlineAt <= now ||
    !supervisorCurrent(db, task.attempt.ownerId, now, task.flowId)
  ) {
    throw new Error("Supervised attempt no longer owns execution");
  }
  return task;
}

export function assertSupervisedAttemptCurrent(
  expected: SupervisedTask,
  now: number,
  options: Options = {},
): void {
  const found = readSnapshot(({ db }) => readOwnedTask(db, expected, now), options);
  if (!found) {
    throw new Error("Supervised task store unavailable");
  }
}

export function reserveSupervisedDispatch(
  expected: SupervisedTask,
  now: number,
  options: Options = {},
): SupervisedTask {
  return write((db) => {
    const task = readOwnedTask(db, expected, now);
    if (!task.attempt || task.attempt.dispatched) {
      throw new Error("Attempt dispatch already reserved; reconcile instead of replaying");
    }
    return replaceTask(db, task, {
      ...task,
      attempt: { ...task.attempt, dispatched: true },
      updatedAt: now,
    });
  }, options);
}

export function settleSupervisedDecision(
  expected: SupervisedTask,
  decision: SupervisedDecision,
  now: number,
  options: Options = {},
): SupervisedTask {
  return write((db) => {
    const task = readOwnedTask(db, expected, now);
    return replaceTask(db, task, applySupervisedDecision(task, decision, now));
  }, options);
}

export function failSupervisedAttempt(
  expected: SupervisedTask,
  reason: string,
  now: number,
  options: Options = {},
): SupervisedTask | undefined {
  return write((db) => {
    const task = readTask(db, expected.flowId, expected.episode);
    // Deadline/error settlement can occur after authority expired, but never
    // overwrites a successor or endpoint. It grants no further dispatch.
    if (
      !task?.attempt ||
      task.attempt.id !== expected.attempt?.id ||
      task.attempt.ownerId !== expected.attempt?.ownerId
    ) {
      return undefined;
    }
    const uncertain = task.attempt.dispatched;
    return replaceTask(
      db,
      task,
      endSupervisedTask(task, {
        kind: uncertain ? "input_required" : "failed",
        reason,
        ...(uncertain
          ? { question: "Inspect the attempt outcome and reconcile any effects before resuming." }
          : {}),
        effects: uncertain ? "unknown" : "not_dispatched",
        evidence: [],
        acceptedBy: "supervisor",
        at: now,
      }),
    );
  }, options);
}

export function cancelSupervisedTask(
  flowId: string,
  now: number,
  options: Options = {},
): SupervisedTask {
  // A failed cancellation must not even initialize the shared database. Recheck
  // the record inside the transaction; this read is not cancellation authority.
  if (!getSupervisedTask(flowId, options)) {
    throw new Error("Unknown supervised task");
  }
  return write((db) => {
    const task = readTask(db, flowId);
    if (!task) {
      throw new Error("Unknown supervised task");
    }
    if (task.endpoint) {
      return task;
    }
    return replaceTask(
      db,
      task,
      endSupervisedTask(task, {
        kind: "cancelled",
        reason: "Operator cancelled supervision",
        evidence: [],
        acceptedBy: "operator",
        effects: task.attempt?.dispatched ? "unknown" : "not_dispatched",
        at: now,
      }),
    );
  }, options);
}

export function resumeSupervisedTask(
  flowId: string,
  expectedEpisode: number,
  input: string,
  policy: SupervisedPolicy,
  ownerId: string,
  now: number,
  options: Options = {},
): SupervisedTask {
  return write((db) => {
    const previous = readTask(db, flowId);
    if (
      !previous ||
      previous.episode !== expectedEpisode ||
      previous.phase !== "input_required" ||
      !supervisorCurrent(db, ownerId, now, flowId)
    ) {
      throw new Error("Resume requires the latest input endpoint and a current supervisor");
    }
    if (policy.deadlineAt <= now) {
      throw new Error("Resume deadline must be in the future");
    }
    assertAdmissionCapacity(db);
    return insertTask(
      db,
      validateSupervisedTask({
        ...previous,
        episode: previous.episode + 1,
        revision: 0,
        phase: "ready",
        next: input,
        policy,
        attempts: 0,
        lastAttemptId: null,
        dueAt: now,
        attempt: null,
        endpoint: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }, options);
}

export function inspectTaskSupervision(flowId: string, now: number, options: Options = {}) {
  return readSnapshot(({ db }) => {
    if (!tableExists(db, "task_flow_episodes")) {
      return undefined;
    }
    const task = readTask(db, flowId);
    if (!task) {
      return undefined;
    }
    const observer = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<Database>(db)
        .selectFrom("task_flow_supervisors")
        .selectAll()
        .where("stopped_at_ms", "is", null)
        .where("expires_at_ms", ">", now)
        .where((eb) => eb.or([eb("flow_id", "is", null), eb("flow_id", "=", flowId)]))
        .orderBy("observed_at_ms", "desc")
        .limit(1),
    );
    const currentOwner = task.attempt
      ? supervisorCurrent(db, task.attempt.ownerId, now, task.flowId)
      : false;
    return {
      task,
      continuation: task.endpoint ? "stopped" : observer ? "armed" : "unknown",
      execution:
        task.attempt && currentOwner && task.attempt.expiresAt > now
          ? "attempt_owned"
          : "not_observed",
      operatorRequired: task.phase === "input_required",
      observedAt: now,
      supervisorObservedAt: observer?.observed_at_ms ?? null,
      supervisorExpiresAt: observer?.expires_at_ms ?? null,
    };
  }, options);
}

function assertAdmissionCapacity(db: DatabaseSync): void {
  const query = getNodeSqliteKysely<Database>(db)
    .selectFrom("task_flow_episodes")
    .select("flow_id")
    .where("phase", "in", activePhases)
    .limit(MAX_ACTIVE_EPISODES);
  if (executeSqliteQuerySync(db, query).rows.length >= MAX_ACTIVE_EPISODES) {
    throw new Error("Supervised TaskFlow capacity reached; no custody accepted");
  }
}

/** Deadline processing is independent of whether a model promise settles. */
export function reconcileSupervisedTasks(now: number, options: Options = {}): void {
  write((db) => {
    const rows = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<Database>(db)
        .selectFrom("task_flow_episodes")
        .select(["flow_id", "episode"])
        .where("phase", "in", activePhases)
        .limit(MAX_ACTIVE_EPISODES),
    ).rows;
    for (const row of rows) {
      const task = readTask(db, row.flow_id, row.episode);
      if (!task || task.endpoint) {
        continue;
      }
      const abandoned =
        task.attempt &&
        (task.attempt.expiresAt <= now ||
          !supervisorCurrent(db, task.attempt.ownerId, now, task.flowId));
      if (task.policy.deadlineAt <= now || (abandoned && task.attempt?.dispatched)) {
        replaceTask(db, task, expireSupervisedTask(task, now));
      } else if (abandoned) {
        replaceTask(
          db,
          task,
          task.attempts >= task.policy.maxAttempts
            ? expireSupervisedTask(task, now)
            : { ...task, phase: "ready", attempt: null, dueAt: now, updatedAt: now },
        );
      }
    }
  }, options);
}

export function findCurrentTaskSupervisor(now: number, options: Options = {}): string | undefined {
  return readSnapshot(({ db }) => {
    if (!tableExists(db, "task_flow_supervisors")) {
      return undefined;
    }
    return executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<Database>(db)
        .selectFrom("task_flow_supervisors")
        .select("owner_id")
        .where("flow_id", "is", null)
        .where("stopped_at_ms", "is", null)
        .where("expires_at_ms", ">", now)
        .orderBy("observed_at_ms", "desc")
        .limit(1),
    )?.owner_id;
  }, options);
}

/** Existing table is the opt-in marker; inspection does not initialize state. */
export function isTaskSupervisionActivated(options: Options = {}): boolean {
  return readSnapshot(({ db }) => tableExists(db, "task_flow_episodes"), options) ?? false;
}
