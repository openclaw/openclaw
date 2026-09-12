import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { NodeWorkerProcessIdentity } from "../node-host/node-worker-process-identity.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { reserveSupervisedOperationLaunchInTransaction } from "./supervised-operation.capacity.js";
import {
  assertReviewRuntimeClosed,
  exactExecution,
  executionRow,
  operationRow,
  readExecution,
  readOperation,
  saveExecution,
  saveOperation,
} from "./supervised-operation.persistence.js";
import {
  encodeSupervisedOperationRequest,
  parseSupervisedOperationOutcome,
  type SupervisedOperation,
  type SupervisedOperationExecution,
  type SupervisedOperationOutcome,
} from "./supervised-operation.types.js";
import { readSupervisedProcessHostIdentity } from "./supervised-process-resources.js";
import { readSupervisedRecoveryInTransaction } from "./supervised-task.recovery.js";
import {
  assertSupervisedAttemptInTransaction,
  parkSupervisedAttemptForOperationInTransaction,
  readSupervisedEpisodeInTransaction,
  wakeSupervisedEpisodeInTransaction,
} from "./supervised-task.store.js";
import type { SupervisedTask } from "./supervised-task.types.js";
import {
  readSupervisedWorkflow,
  writeSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";
import {
  authorizeSupervisedOperationInTransaction,
  readSupervisedWorkflowContractInTransaction,
} from "./supervised-workflow.store.js";

export {
  getSupervisedOperation,
  getSupervisedOperationExecution,
} from "./supervised-operation.persistence.js";
export {
  listSupervisedOperations,
  reconcileSupervisedOperationRecords,
} from "./supervised-operation.recovery.js";

const sql = (db: DatabaseSync) => getNodeSqliteKysely<DB>(db);
const active = ["queued", "running", "reconciling"];
const MAX_OPERATIONS_PER_EPISODE = 256;
const MAX_EXECUTIONS_PER_OPERATION = 8;

function episodeCurrent(db: DatabaseSync, operation: SupervisedOperation, now: number): boolean {
  if (readSupervisedRecoveryInTransaction(db, operation.flowId, operation.episode)?.fault_json) {
    return false;
  }
  const task = readSupervisedEpisodeInTransaction(db, operation.flowId, operation.episode);
  return Boolean(
    task && !task.endpoint && task.policy.deadlineAt > now && operation.deadlineAt > now,
  );
}

function currentExecution(db: DatabaseSync, expected: SupervisedOperationExecution, now: number) {
  const execution = exactExecution(db, expected);
  const operation = readOperation(db, execution.operationId);
  if (
    !operation ||
    operation.state !== "running" ||
    operation.executionId !== execution.executionId ||
    operation.generation !== execution.generation ||
    execution.outcome ||
    execution.leaseExpiresAt <= now ||
    !episodeCurrent(db, operation, now)
  ) {
    throw new Error("Operation no longer owns execution");
  }
  const contract = readSupervisedWorkflowContractInTransaction(
    db,
    operation.flowId,
    operation.episode,
  );
  if (!contract || contract.hash !== operation.contractHash) {
    throw new Error("Operation accepted contract changed");
  }
  return { operation, execution };
}
function finishOperation(
  db: DatabaseSync,
  operation: SupervisedOperation,
  outcome: SupervisedOperationOutcome,
  now: number,
) {
  const result = saveOperation(db, operation, {
    ...operation,
    state: outcome.status,
    outcome,
    updatedAt: now,
  });
  wakeSupervisedEpisodeInTransaction(db, operation.flowId, operation.episode, now);
  return result;
}

/** Admission, capability check, operation reservation, and parent wait are one commit. */
export function enqueueSupervisedOperation(
  expected: SupervisedTask,
  value: unknown,
  now: number,
  options: Options = {},
): SupervisedOperation {
  return writeSupervisedWorkflow(
    (db) => enqueueSupervisedOperationInTransaction(db, expected, value, now),
    options,
  );
}

/** Candidate consumption installs the accepted artifact and parent wait atomically. */
export function enqueueSupervisedOperationInTransaction(
  db: DatabaseSync,
  expected: SupervisedTask,
  value: unknown,
  now: number,
): SupervisedOperation {
  const encoded = encodeSupervisedOperationRequest(value);
  const task = assertSupervisedAttemptInTransaction(db, expected, now);
  const contract = authorizeSupervisedOperationInTransaction(db, task, encoded.request);
  const existing = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("task_flow_operations")
      .select("operation_id")
      .where("flow_id", "=", task.flowId)
      .where("episode", "=", task.episode)
      .where("idempotency_key", "=", encoded.request.key),
  );
  if (existing) {
    const operation = readOperation(db, existing.operation_id)!;
    if (operation.inputHash !== encoded.hash || operation.contractHash !== contract.hash) {
      throw new Error("Operation idempotency key has different accepted input");
    }
    parkSupervisedAttemptForOperationInTransaction(db, task, operation.operationId, now);
    return operation;
  }
  const count = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("task_flow_operations")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("flow_id", "=", task.flowId)
      .where("episode", "=", task.episode),
  );
  if ((count?.count ?? 0) >= MAX_OPERATIONS_PER_EPISODE) {
    throw new Error("Episode operation budget exhausted");
  }
  const pending = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("task_flow_operations")
      .select("operation_id")
      .where("flow_id", "=", task.flowId)
      .where("episode", "=", task.episode)
      .where("state", "in", active)
      .limit(1),
  );
  if (pending) {
    throw new Error("Episode already has an outstanding operation");
  }
  const operation: SupervisedOperation = {
    operationId: randomUUID(),
    flowId: task.flowId,
    episode: task.episode,
    admissionRevision: task.revision,
    request: encoded.request,
    inputHash: encoded.hash,
    contractHash: contract.hash,
    workspaceVersion: null,
    state: "queued",
    generation: 0,
    executionId: null,
    dueAt: now,
    deadlineAt: task.policy.deadlineAt,
    createdAt: now,
    updatedAt: now,
    publication: null,
    reconciliations: [],
    outcome: null,
  };
  executeSqliteQuerySync(
    db,
    sql(db).insertInto("task_flow_operations").values(operationRow(operation)),
  );
  parkSupervisedAttemptForOperationInTransaction(db, task, operation.operationId, now);
  return operation;
}

export function claimSupervisedOperation(
  operationId: string,
  ownerId: string,
  now: number,
  options: Options = {},
  launcher?: NodeWorkerProcessIdentity,
): SupervisedOperationExecution | undefined {
  if (!ownerId || ownerId.length > 128) {
    throw new Error("Invalid operation owner");
  }
  return writeSupervisedWorkflow((db) => {
    const operation = readOperation(db, operationId);
    if (!operation || operation.state !== "queued" || operation.dueAt > now) {
      return undefined;
    }
    if (!episodeCurrent(db, operation, now)) {
      finishOperation(
        db,
        operation,
        {
          status: "cancelled",
          summary: "Episode ended or its deadline expired before dispatch",
          facts: {},
          artifacts: [],
        },
        now,
      );
      return undefined;
    }
    const contract = readSupervisedWorkflowContractInTransaction(
      db,
      operation.flowId,
      operation.episode,
    );
    if (!contract || contract.hash !== operation.contractHash) {
      throw new Error("Accepted operation contract unavailable");
    }
    if (
      operation.generation >=
      Math.min(MAX_EXECUTIONS_PER_OPERATION, 1 + contract.contract.maxRecoveryAttempts)
    ) {
      finishOperation(
        db,
        operation,
        {
          status: "failed",
          summary: "Operation execution budget exhausted",
          facts: {},
          artifacts: [],
        },
        now,
      );
      return undefined;
    }
    const execution: SupervisedOperationExecution = {
      executionId: randomUUID(),
      operationId,
      generation: operation.generation + 1,
      ownerId,
      leaseExpiresAt: Math.min(operation.deadlineAt, now + (launcher ? 120_000 : 10_000)),
      startedAt: now,
      dispatchedAt: null,
      finishedAt: null,
      process: null,
      outcome: null,
      preparationError: null,
      ...(launcher && process.platform === "linux"
        ? { launchHost: readSupervisedProcessHostIdentity() }
        : {}),
    };
    executeSqliteQuerySync(
      db,
      sql(db).insertInto("task_flow_operation_executions").values(executionRow(execution)),
    );
    if (launcher) {
      reserveSupervisedOperationLaunchInTransaction(db, execution.executionId, launcher, now);
    }
    saveOperation(db, operation, {
      ...operation,
      state: "running",
      generation: execution.generation,
      executionId: execution.executionId,
      updatedAt: now,
    });
    return execution;
  }, options);
}

export function assertSupervisedOperationCurrent(
  expected: SupervisedOperationExecution,
  now: number,
  options: Options = {},
): void {
  const found = readSupervisedWorkflow((db) => currentExecution(db, expected, now), options);
  if (!found) {
    throw new Error("Operation store unavailable");
  }
}

export function assertSupervisedOperationInTransaction(
  db: DatabaseSync,
  expected: SupervisedOperationExecution,
  now: number,
) {
  return currentExecution(db, expected, now).operation;
}

export function pinSupervisedOperationWorkspaceInTransaction(
  db: DatabaseSync,
  expected: SupervisedOperationExecution,
  version: string,
  now: number,
) {
  const { operation, execution } = currentExecution(db, expected, now);
  if (execution.dispatchedAt !== null) {
    throw new Error("Operation input must be frozen before dispatch");
  }
  if (operation.workspaceVersion && operation.workspaceVersion !== version) {
    throw new Error("Operation input artifact is immutable");
  }
  return saveOperation(db, operation, { ...operation, workspaceVersion: version, updatedAt: now });
}
export function heartbeatSupervisedOperation(
  expected: SupervisedOperationExecution,
  now: number,
  options: Options = {},
): void {
  writeSupervisedWorkflow((db) => {
    const { operation, execution } = currentExecution(db, expected, now);
    saveExecution(db, execution, {
      ...execution,
      leaseExpiresAt: Math.min(operation.deadlineAt, now + 10_000),
    });
  }, options);
}

export function scheduleSupervisedOperationPoll(
  expected: SupervisedOperationExecution,
  dueAt: number,
  now: number,
  options: Options = {},
): void {
  writeSupervisedWorkflow((db) => {
    const { operation } = currentExecution(db, expected, now);
    if (operation.request.kind !== "ci" || dueAt < now || !Number.isSafeInteger(dueAt)) {
      throw new Error("Invalid operation polling wake");
    }
    saveOperation(db, operation, {
      ...operation,
      dueAt: Math.min(operation.deadlineAt, dueAt),
      updatedAt: now,
    });
  }, options);
}

/** Runner failures with reconcilable external receipts remain owned work, not a user endpoint. */
export function releaseSupervisedOperationForReconciliation(
  expected: SupervisedOperationExecution,
  now: number,
  options: Options = {},
  preparationError?: string,
): void {
  writeSupervisedWorkflow((db) => {
    const { operation, execution } = currentExecution(db, expected, now);
    saveExecution(db, execution, {
      ...execution,
      leaseExpiresAt: now,
      preparationError:
        preparationError === undefined
          ? execution.preparationError
          : preparationError.length > 0 && preparationError.length <= 2048
            ? preparationError
            : "Preparation failed; diagnostic exceeded its bound",
    });
    saveOperation(db, operation, { ...operation, state: "reconciling", updatedAt: now });
  }, options);
}
export function reserveSupervisedOperationDispatch(
  expected: SupervisedOperationExecution,
  now: number,
  options: Options = {},
): void {
  writeSupervisedWorkflow((db) => {
    const { execution, operation } = currentExecution(db, expected, now);
    if (execution.dispatchedAt !== null) {
      throw new Error("Operation dispatch already reserved; reconcile, do not repeat");
    }
    if (operation.request.kind === "review") {
      const resource = executeSqliteQueryTakeFirstSync(
        db,
        sql(db)
          .selectFrom("task_flow_command_resources")
          .select("state")
          .where("execution_id", "=", execution.executionId),
      );
      if (resource?.state !== "bound") {
        throw new Error("Review dispatch requires bound runtime custody");
      }
    }
    saveExecution(db, execution, { ...execution, dispatchedAt: now });
  }, options);
}
export function bindSupervisedOperationProcess(
  expected: SupervisedOperationExecution,
  process: NonNullable<SupervisedOperationExecution["process"]>,
  now: number,
  options: Options = {},
): void {
  writeSupervisedWorkflow((db) => {
    const { execution } = currentExecution(db, expected, now);
    if (execution.process || execution.dispatchedAt !== null) {
      throw new Error("Bind independent runner identity once, before dispatch");
    }
    saveExecution(db, execution, { ...execution, process });
  }, options);
}

/** Preparation is immutable across runner generations, before any remote write. */
export function prepareSupervisedPublication(
  expected: SupervisedOperationExecution,
  prepared: NonNullable<SupervisedOperation["publication"]>,
  now: number,
  options: Options = {},
): void {
  writeSupervisedWorkflow((db) => {
    const { operation, execution } = currentExecution(db, expected, now);
    if (
      operation.request.kind !== "publication" ||
      prepared.artifactId !== execution.executionId ||
      execution.dispatchedAt !== null ||
      prepared.pushReservedAt !== null ||
      prepared.createReservedAt !== null ||
      prepared.remoteHead !== null ||
      prepared.pullRequestUrl !== null
    ) {
      throw new Error("Invalid publication preparation boundary");
    }
    if (operation.publication) {
      if (JSON.stringify(operation.publication) !== JSON.stringify(prepared)) {
        throw new Error("Publication preparation is immutable");
      }
      return;
    }
    saveOperation(db, operation, { ...operation, publication: prepared, updatedAt: now });
  }, options);
}

export function reserveSupervisedPublicationAction(
  expected: SupervisedOperationExecution,
  action: "push" | "create",
  now: number,
  options: Options = {},
): void {
  writeSupervisedWorkflow((db) => {
    const { operation, execution } = currentExecution(db, expected, now);
    if (!operation.publication || execution.dispatchedAt === null) {
      throw new Error("Publication requires prepared artifact and dispatch authority");
    }
    const field = action === "push" ? "pushReservedAt" : "createReservedAt";
    saveOperation(db, operation, {
      ...operation,
      updatedAt: now,
      publication: { ...operation.publication, [field]: operation.publication[field] ?? now },
    });
  }, options);
}

/** Observations survive revocation; this function grants no transport authority. */
export function observeSupervisedPublication(
  expected: SupervisedOperationExecution,
  observation: { remoteHead?: string; pullRequestUrl?: string },
  now: number,
  options: Options = {},
): void {
  writeSupervisedWorkflow((db) => {
    const execution = exactExecution(db, expected);
    const operation = readOperation(db, execution.operationId);
    if (!operation?.publication || execution.dispatchedAt === null) {
      throw new Error("No dispatched publication to observe");
    }
    const prepared = operation.publication;
    if (
      (observation.remoteHead && observation.remoteHead !== prepared.headCommit) ||
      (observation.pullRequestUrl &&
        prepared.pullRequestUrl &&
        observation.pullRequestUrl !== prepared.pullRequestUrl)
    ) {
      throw new Error("Publication observation conflicts with the exact prepared artifact");
    }
    if (operation.outcome) {
      return;
    }
    saveOperation(db, operation, {
      ...operation,
      updatedAt: now,
      publication: { ...prepared, ...observation },
    });
  }, options);
}

/** A late observation cannot authorize a new effect or overwrite a successor. */
export function recordSupervisedOperationOutcome(
  expected: SupervisedOperationExecution,
  value: unknown,
  now: number,
  options: Options = {},
): SupervisedOperation {
  return writeSupervisedWorkflow(
    (db) => recordSupervisedOperationOutcomeInTransaction(db, expected, value, now),
    options,
  );
}

/** Compose the immutable receipt with the workspace owner's acceptance transaction. */
export function recordSupervisedOperationOutcomeInTransaction(
  db: DatabaseSync,
  expected: SupervisedOperationExecution,
  value: unknown,
  now: number,
): SupervisedOperation {
  const outcome = parseSupervisedOperationOutcome(value);
  const execution = exactExecution(db, expected);
  const operation = readOperation(db, execution.operationId)!;
  if (execution.outcome) {
    if (JSON.stringify(execution.outcome) !== JSON.stringify(outcome)) {
      throw new Error("Conflicting immutable execution observation");
    }
    return operation;
  }
  assertReviewRuntimeClosed(db, operation, execution);
  if (execution.dispatchedAt === null && outcome.status === "succeeded") {
    throw new Error("Undispatched operation cannot claim success");
  }
  saveExecution(db, execution, { ...execution, finishedAt: now, outcome });
  // Read-only review scratch is private runtime state, not an unaccepted file
  // result. Commit its disposal permission with the receipt, after exact scope
  // closure, so an outer-runner crash cannot leak one reservation per review.
  // Unknown/input-required evidence is deliberately retained.
  if (
    operation.request.kind === "review" &&
    execution.process &&
    (outcome.status === "succeeded" || outcome.status === "failed")
  ) {
    executeSqliteQuerySync(
      db,
      sql(db)
        .updateTable("task_flow_workspace_allocations")
        .set({ state: "released", discardable_at_ms: now, updated_at_ms: now })
        .where("flow_id", "=", operation.flowId)
        .where("episode", "=", operation.episode)
        .where("owner_kind", "=", "operation")
        .where("owner_id", "=", execution.executionId)
        .where("owner_pid", "=", execution.process.pid)
        .where("owner_start_time", "=", execution.process.startTime)
        .where("kind", "=", "draft")
        .where("state", "=", "reserved")
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom("task_flow_command_resources")
              .select("execution_id")
              .where("execution_id", "=", execution.executionId)
              .where("state", "=", "closed"),
          ),
        ),
    );
  }

  if (
    operation.outcome ||
    operation.executionId !== execution.executionId ||
    operation.generation !== execution.generation
  ) {
    return operation;
  }
  return finishOperation(
    db,
    operation,
    episodeCurrent(db, operation, now)
      ? outcome
      : {
          status: "cancelled",
          summary: "Observed an operation result after episode authority ended",
          facts: { observedExecution: execution.executionId, observedStatus: outcome.status },
          artifacts: [],
        },
    now,
  );
}

/** Expired leases are unresolved, never presumed safe to replay. */
export function markSupervisedOperationReconciling(
  expected: SupervisedOperationExecution,
  now: number,
  options: Options = {},
): SupervisedOperation {
  return writeSupervisedWorkflow((db) => {
    const execution = exactExecution(db, expected);
    const operation = readOperation(db, execution.operationId)!;
    if (
      operation.outcome ||
      operation.executionId !== execution.executionId ||
      operation.state === "reconciling"
    ) {
      return operation;
    }
    if (operation.state !== "running" || execution.leaseExpiresAt > now) {
      throw new Error("A live operation owner cannot be displaced");
    }
    return saveOperation(db, operation, {
      ...operation,
      state: "reconciling",
      dueAt: now,
      updatedAt: now,
    });
  }, options);
}

/** Host reconciliation supplies evidence; the model cannot call this transition. */
export function resolveSupervisedOperationReconciliation(
  expected: SupervisedOperation,
  resolution: { retryAt: number; evidence: string } | { outcome: SupervisedOperationOutcome },
  now: number,
  options: Options = {},
): SupervisedOperation {
  return writeSupervisedWorkflow((db) => {
    const operation = readOperation(db, expected.operationId);
    if (
      !operation ||
      operation.state !== "reconciling" ||
      operation.generation !== expected.generation ||
      operation.executionId !== expected.executionId
    ) {
      throw new Error("Reconciliation snapshot was superseded");
    }
    if (operation.executionId) {
      const execution = readExecution(db, operation.executionId);
      if (!execution) {
        throw new Error("Reconciliation execution is unavailable");
      }
      assertReviewRuntimeClosed(db, operation, execution);
    }
    if ("outcome" in resolution) {
      return finishOperation(
        db,
        operation,
        parseSupervisedOperationOutcome(resolution.outcome),
        now,
      );
    }
    const resources =
      operation.executionId &&
      executeSqliteQueryTakeFirstSync(
        db,
        sql(db)
          .selectFrom("task_flow_command_resources")
          .select("state")
          .where("execution_id", "=", operation.executionId),
      );
    if (resources && resources.state !== "closed") {
      throw new Error("Command resources remain unresolved; replay is not authorized");
    }
    if (
      !resolution.evidence.trim() ||
      resolution.evidence.length > 4096 ||
      !Number.isSafeInteger(resolution.retryAt) ||
      resolution.retryAt < now ||
      !episodeCurrent(db, operation, now)
    ) {
      throw new Error("Invalid reconciliation retry authority");
    }
    // The original execution and any late receipt remain addressable forever
    // through their generation. A successor gets a fresh identity at claim.
    return saveOperation(db, operation, {
      ...operation,
      state: "queued",
      executionId: null,
      dueAt: resolution.retryAt,
      updatedAt: now,
      reconciliations: [
        ...operation.reconciliations,
        { generation: operation.generation, at: now, evidence: resolution.evidence },
      ],
    });
  }, options);
}
