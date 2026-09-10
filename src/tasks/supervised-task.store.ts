import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  expireSupervisedEpisodeInTransaction,
  supervisedEpisodeHasDispatchedEffects,
} from "./supervised-task.effects.js";
import {
  readTask,
  decodeTaskRow,
  insertTask,
  replaceTask,
  supervisorCurrent,
} from "./supervised-task.persistence.js";
import {
  readSupervisedRecoveryInTransaction,
  recoverManagedSupervisedAttemptInTransaction,
  quarantineSupervisedTask,
  selectActiveSupervisedEpisodes,
} from "./supervised-task.recovery.js";
import {
  insertSupervisedTaskSourceInTransaction,
  type SupervisedTaskAdmission,
} from "./supervised-task.source.js";
import { applySupervisedDecision, endSupervisedTask } from "./supervised-task.transitions.js";
import {
  validateSupervisedTask,
  type SupervisedDecision,
  type SupervisedGoal,
  type SupervisedPolicy,
  type SupervisedTask,
} from "./supervised-task.types.js";
import {
  commitSupervisedAcceptanceInTransaction,
  type SupervisedAcceptanceProof,
} from "./supervised-workflow.acceptance.js";
import {
  readSupervisedWorkflow,
  writeSupervisedWorkflow as write,
  SupervisedRecordCorruptionError,
} from "./supervised-workflow.persistence.js";
import {
  insertSupervisedWorkflowContractInTransaction,
  readSupervisedWorkflowContractInTransaction,
} from "./supervised-workflow.store.js";
import type { SupervisedWorkflowContract } from "./supervised-workflow.types.js";

type Database = Pick<DB, "task_flow_episodes" | "task_flow_supervisors">;
type Options = OpenClawStateDatabaseOptions;
const MAX_ACTIVE_EPISODES = 128;
function readSnapshot<T>(
  operation: (database: { db: DatabaseSync }) => T,
  options: Options,
): T | undefined {
  return readSupervisedWorkflow((db) => operation({ db }), options);
}

export function heartbeatTaskSupervisor(
  ownerId: string,
  now: number,
  ttlMs: number,
  options: Options = {},
  flowId?: string,
): void {
  if (
    !ownerId ||
    ownerId.length > 128 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1000 ||
    ttlMs > 60_000
  ) {
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
  admission?: SupervisedTaskAdmission;
  flowId?: string;
  agentId: string;
  model: string;
  runtime: SupervisedTask["runtime"];
  prompt: string;
  goal?: SupervisedGoal;
  policy: SupervisedPolicy;
  workflow?: SupervisedWorkflowContract;
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
    const task = insertTask(
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
    if (input.workflow) {
      insertSupervisedWorkflowContractInTransaction(db, task, input.workflow);
    }
    if (input.admission) {
      insertSupervisedTaskSourceInTransaction(db, task, input.admission);
    }
    return task;
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
      const query = activeOnly
        ? selectActiveSupervisedEpisodes(db).selectAll()
        : getNodeSqliteKysely<DB>(db).selectFrom("task_flow_episodes").selectAll();
      return executeSqliteQuerySync(
        db,
        query.orderBy("due_at_ms").orderBy("flow_id").limit(256),
      ).rows.flatMap((row) => {
        if (
          activeOnly &&
          readSupervisedRecoveryInTransaction(db, row.flow_id, row.episode)?.fault_json
        ) {
          return [];
        }
        try {
          return [decodeTaskRow(row)];
        } catch {
          return [];
        }
      });
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
    if (
      !task ||
      task.endpoint ||
      readSupervisedRecoveryInTransaction(db, task.flowId, task.episode)?.fault_json ||
      !supervisorCurrent(db, ownerId, now, flowId)
    ) {
      return undefined;
    }
    if (now >= task.policy.deadlineAt) {
      return replaceTask(db, task, expireSupervisedEpisodeInTransaction(db, task, now));
    }
    if (task.attempt) {
      if (
        task.attempt.expiresAt > now &&
        supervisorCurrent(db, task.attempt.ownerId, now, task.flowId)
      ) {
        return undefined;
      }
      if (task.attempt.dispatched) {
        const recovered = recoverManagedSupervisedAttemptInTransaction(db, task, now);
        return replaceTask(
          db,
          task,
          recovered ?? expireSupervisedEpisodeInTransaction(db, task, now),
        );
      }
      // No dispatch reservation exists. A successor can safely reclaim, but
      // this still consumes an attempt: crashes cannot reset the episode budget.
    } else if (task.dueAt > now) {
      return undefined;
    }
    if (
      tableExists(db, "task_flow_operations") &&
      executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<DB>(db)
          .selectFrom("task_flow_operations")
          .select("operation_id")
          .where("flow_id", "=", task.flowId)
          .where("episode", "=", task.episode)
          .where("state", "in", ["queued", "running", "reconciling"])
          .limit(1),
      )
    ) {
      return undefined;
    }
    if (task.attempts >= task.policy.maxAttempts) {
      return replaceTask(db, task, expireSupervisedEpisodeInTransaction(db, task, now));
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
    readSupervisedRecoveryInTransaction(db, task.flowId, task.episode)?.fault_json ||
    !supervisorCurrent(db, task.attempt.ownerId, now, task.flowId)
  ) {
    throw new Error("Supervised attempt no longer owns execution");
  }
  return task;
}

/** Compose operation admission with its task wait under the canonical writer. */
export function parkSupervisedAttemptForOperationInTransaction(
  db: DatabaseSync,
  expected: SupervisedTask,
  operationId: string,
  now: number,
): SupervisedTask {
  const task = readOwnedTask(db, expected, now);
  return replaceTask(db, task, {
    ...task,
    phase: "waiting",
    attempt: null,
    next: `Await durable operation ${operationId}`,
    dueAt: Math.min(task.policy.deadlineAt, now + 1000),
    updatedAt: now,
  });
}

/** This is a wake observation, not permission to overwrite an endpoint/attempt. */
export function wakeSupervisedEpisodeInTransaction(
  db: DatabaseSync,
  flowId: string,
  episode: number,
  now: number,
): void {
  const task = readTask(db, flowId, episode);
  if (task && !task.endpoint && !task.attempt && task.dueAt > now) {
    replaceTask(db, task, { ...task, dueAt: now, updatedAt: now });
  }
}

export function readSupervisedEpisodeInTransaction(
  db: DatabaseSync,
  flowId: string,
  episode: number,
): SupervisedTask | undefined {
  return readTask(db, flowId, episode);
}

export function assertSupervisedAttemptInTransaction(
  db: DatabaseSync,
  expected: SupervisedTask,
  now: number,
): SupervisedTask {
  return readOwnedTask(db, expected, now);
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
  acceptance?: SupervisedAcceptanceProof,
): SupervisedTask {
  return write(
    (db) => settleSupervisedDecisionInTransaction(db, expected, decision, now, acceptance),
    options,
  );
}

/** Compose artifact installation and semantic settlement in one synchronous transaction. */
export function settleSupervisedDecisionInTransaction(
  db: DatabaseSync,
  expected: SupervisedTask,
  decision: SupervisedDecision,
  now: number,
  acceptance?: SupervisedAcceptanceProof,
): SupervisedTask {
  const task = readOwnedTask(db, expected, now);
  if (
    (decision.kind === "succeeded" || decision.kind === "partial") &&
    readSupervisedWorkflowContractInTransaction(db, task.flowId, task.episode)
  ) {
    if (!acceptance) {
      throw new Error("Managed workflow completion requires controller verification");
    }
    const evidence = commitSupervisedAcceptanceInTransaction(db, task, decision, acceptance, now);
    const next = applySupervisedDecision(task, { ...decision, evidence }, now);
    if (next.endpoint) {
      next.endpoint.acceptedBy = "supervisor";
    }
    return replaceTask(db, task, next);
  }
  return replaceTask(db, task, applySupervisedDecision(task, decision, now));
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
    const recovered = recoverManagedSupervisedAttemptInTransaction(db, task, now);
    if (recovered) {
      return replaceTask(db, task, recovered);
    }
    return replaceTask(
      db,
      task,
      endSupervisedTask(task, {
        kind: uncertain ? "input_required" : "failed",
        reason: !reason.trim()
          ? "Supervisor failure supplied no diagnostic detail"
          : reason.length > 4096 || Buffer.byteLength(JSON.stringify(reason)) > 4096
            ? "Supervisor failure detail omitted because it exceeds the diagnostic budget"
            : reason,
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
  return write((db) => cancelSupervisedTaskInTransaction(db, flowId, now), options);
}

export function cancelSupervisedTaskInTransaction(
  db: DatabaseSync,
  flowId: string,
  now: number,
): SupervisedTask {
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
      effects: supervisedEpisodeHasDispatchedEffects(db, task) ? "unknown" : "not_dispatched",
      at: now,
    }),
  );
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
  return write(
    (db) =>
      resumeSupervisedTaskInTransaction(db, flowId, expectedEpisode, input, policy, ownerId, now),
    options,
  );
}

export function resumeSupervisedTaskInTransaction(
  db: DatabaseSync,
  flowId: string,
  expectedEpisode: number,
  input: string,
  policy: SupervisedPolicy,
  ownerId: string,
  now: number,
): SupervisedTask {
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
  const task = insertTask(
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
  const workflow = readSupervisedWorkflowContractInTransaction(
    db,
    previous.flowId,
    previous.episode,
  );
  if (workflow) {
    insertSupervisedWorkflowContractInTransaction(db, task, workflow.contract);
    const previousHead = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<DB>(db)
        .selectFrom("task_flow_workspace_heads")
        .select("version_id")
        .where("flow_id", "=", previous.flowId)
        .where("episode", "=", previous.episode),
    );
    if (previousHead) {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db).insertInto("task_flow_workspace_heads").values({
          flow_id: task.flowId,
          episode: task.episode,
          version_id: previousHead.version_id,
        }),
      );
    }
  }
  return task;
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
      continuation:
        task.endpoint ||
        readSupervisedRecoveryInTransaction(db, task.flowId, task.episode)?.fault_json
          ? "stopped"
          : observer
            ? "armed"
            : "unknown",
      execution:
        task.attempt && currentOwner && task.attempt.expiresAt > now
          ? "attempt_owned"
          : "not_observed",
      operatorRequired:
        task.phase === "input_required" ||
        Boolean(readSupervisedRecoveryInTransaction(db, task.flowId, task.episode)?.fault_json),
      fault: readSupervisedRecoveryInTransaction(db, task.flowId, task.episode)?.fault_json ?? null,
      observedAt: now,
      supervisorObservedAt: observer?.observed_at_ms ?? null,
      supervisorExpiresAt: observer?.expires_at_ms ?? null,
    };
  }, options);
}

function assertAdmissionCapacity(db: DatabaseSync): void {
  const query = selectActiveSupervisedEpisodes(db).select("flow_id").limit(MAX_ACTIVE_EPISODES);
  if (executeSqliteQuerySync(db, query).rows.length >= MAX_ACTIVE_EPISODES) {
    throw new Error("Supervised TaskFlow capacity reached; no custody accepted");
  }
}

/** Deadline processing is independent of whether a model promise settles. */
export function reconcileSupervisedTasks(now: number, options: Options = {}): void {
  const rows =
    readSnapshot(
      ({ db }) =>
        tableExists(db, "task_flow_episodes")
          ? executeSqliteQuerySync(
              db,
              selectActiveSupervisedEpisodes(db)
                .select(["flow_id", "episode"])
                .limit(MAX_ACTIVE_EPISODES),
            ).rows
          : [],
      options,
    ) ?? [];
  for (const row of rows) {
    try {
      write((db) => {
        if (readSupervisedRecoveryInTransaction(db, row.flow_id, row.episode)?.fault_json) {
          return;
        }
        const task = readTask(db, row.flow_id, row.episode);
        if (!task || task.endpoint) {
          return;
        }
        const abandoned =
          task.attempt &&
          (task.attempt.expiresAt <= now ||
            !supervisorCurrent(db, task.attempt.ownerId, now, task.flowId));
        if (task.policy.deadlineAt <= now || (abandoned && task.attempt?.dispatched)) {
          const recovered =
            task.policy.deadlineAt > now
              ? recoverManagedSupervisedAttemptInTransaction(db, task, now)
              : undefined;
          replaceTask(db, task, recovered ?? expireSupervisedEpisodeInTransaction(db, task, now));
        } else if (abandoned) {
          replaceTask(
            db,
            task,
            task.attempts >= task.policy.maxAttempts
              ? expireSupervisedEpisodeInTransaction(db, task, now)
              : { ...task, phase: "ready", attempt: null, dueAt: now, updatedAt: now },
          );
        }
      }, options);
    } catch (error) {
      if (!(error instanceof SupervisedRecordCorruptionError)) {
        throw error;
      }
      // The failed transaction retained the exact source bytes. Isolate this
      // episode in a separate transaction; do not roll back healthy siblings.
      quarantineSupervisedTask(row.flow_id, row.episode, now, options);
    }
  }
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
