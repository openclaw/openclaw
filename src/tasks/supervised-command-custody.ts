import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeWorkerProcessIdentity } from "../node-host/node-worker-process-identity.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  decodeSupervisedCommandBinding as decodeBinding,
  supervisedCommandIdentitySchema as identitySchema,
  supervisedCommandPrebindingSchema as prebindingSchema,
} from "./supervised-command-custody.persistence.js";
import {
  supervisedCommandScopeName,
  type SupervisedCommandScopeIdentity,
} from "./supervised-command-resources.js";
import { assertSupervisedOperationInTransaction } from "./supervised-operation.store.js";
import {
  parseSupervisedOperationExecution,
  type SupervisedOperationExecution,
} from "./supervised-operation.types.js";
import { readSupervisedProcessHostIdentity } from "./supervised-process-resources.js";
import {
  writeSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";

export { getSupervisedCommandResources } from "./supervised-command-custody.persistence.js";

function planSupervisedOperationResources(
  kind: "command" | "review",
  execution: SupervisedOperationExecution,
  now: number,
  options: Options,
) {
  const prebinding = prebindingSchema.parse({
    kind: "prebinding",
    executionId: execution.executionId,
    ...readSupervisedProcessHostIdentity(),
    launcher: requireNodeWorkerProcessIdentity(process.pid),
    transport: "not_started",
  });
  return writeSupervisedWorkflow((db) => {
    const operation = assertSupervisedOperationInTransaction(db, execution, now);
    const persisted = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<DB>(db)
        .selectFrom("task_flow_operation_executions")
        .select("dispatched_at_ms")
        .where("execution_id", "=", execution.executionId),
    );
    if (operation.request.kind !== kind || persisted?.dispatched_at_ms !== null) {
      throw new Error("Command resources must be planned before payload dispatch");
    }
    const result = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db)
        .insertInto("task_flow_command_resources")
        .values({
          execution_id: execution.executionId,
          scope_name: supervisedCommandScopeName(execution.executionId),
          state: "planned",
          identity_json: JSON.stringify(prebinding),
          created_at_ms: now,
          updated_at_ms: now,
        })
        .onConflict((conflict) => conflict.column("execution_id").doNothing()),
    );
    if (result.numAffectedRows !== 1n) {
      throw new Error("Command resource launch already reserved; reconcile instead of relaunching");
    }
  }, options);
}

/** Historical physical table/identity are shared by real operation executions.
 * Preserve command-only API admission while review names its own operation kind. */
export function planSupervisedCommandResources(
  execution: SupervisedOperationExecution,
  now: number,
  options: Options = {},
) {
  return planSupervisedOperationResources("command", execution, now, options);
}
export function planSupervisedReviewResources(
  execution: SupervisedOperationExecution,
  now: number,
  options: Options = {},
) {
  return planSupervisedOperationResources("review", execution, now, options);
}

function assertExactLaunchOwner(db: DatabaseSync, expected: SupervisedOperationExecution) {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("task_flow_operation_executions")
      .select("record_json")
      .where("execution_id", "=", expected.executionId),
  );
  if (!row) {
    throw new Error("Command launch owner missing");
  }
  const actual = parseSupervisedOperationExecution(JSON.parse(row.record_json));
  const processIdentity = requireNodeWorkerProcessIdentity(process.pid);
  if (
    actual.operationId !== expected.operationId ||
    actual.generation !== expected.generation ||
    actual.ownerId !== expected.ownerId ||
    actual.process?.pid !== processIdentity.pid ||
    actual.process.startTime !== processIdentity.startTime
  ) {
    throw new Error("Command launch belongs to another process owner");
  }
}

/** Consume before entering any async transport spawn path. Recovery may close
 * a dead owner's not_started plan, so neither a stale owner nor a late callback
 * may create a transport without this transactional gate. */
export function startSupervisedCommandTransport(
  expected: SupervisedOperationExecution,
  now: number,
  options: Options = {},
) {
  writeSupervisedWorkflow((db) => {
    assertExactLaunchOwner(db, expected);
    assertSupervisedOperationInTransaction(db, expected, now);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<DB>(db)
        .selectFrom("task_flow_command_resources")
        .selectAll()
        .where("execution_id", "=", expected.executionId),
    );
    const plan = row ? decodeBinding(row.identity_json).prebinding : null;
    const host = readSupervisedProcessHostIdentity();
    if (
      row?.state !== "planned" ||
      !plan ||
      plan.executionId !== expected.executionId ||
      plan.transport !== "not_started" ||
      plan.hostId !== host.hostId ||
      plan.bootId !== host.bootId ||
      plan.launcher.pid !== process.pid ||
      plan.launcher.startTime !== requireNodeWorkerProcessIdentity(process.pid).startTime
    ) {
      throw new Error("Command transport launch gate unavailable");
    }
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db)
        .updateTable("task_flow_command_resources")
        .set({
          identity_json: JSON.stringify({ ...plan, transport: "started" }),
          updated_at_ms: now,
        })
        .where("execution_id", "=", expected.executionId)
        .where("state", "=", "planned")
        .where("identity_json", "=", row.identity_json),
    );
  }, options);
}

/** Persist the required-all callback before an outer finally can fail or die. */
export function recordSupervisedCommandTransportExtinct(
  expected: SupervisedOperationExecution,
  now: number,
  options: Options = {},
) {
  writeSupervisedWorkflow((db) => {
    assertExactLaunchOwner(db, expected);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<DB>(db)
        .selectFrom("task_flow_command_resources")
        .selectAll()
        .where("execution_id", "=", expected.executionId),
    );
    const plan = row ? decodeBinding(row.identity_json).prebinding : null;
    if (!row || !plan || !["planned", "sealed"].includes(row.state)) {
      return;
    }
    if (plan.transport !== "started") {
      throw new Error("Command transport was not started");
    }
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db)
        .updateTable("task_flow_command_resources")
        .set({
          identity_json: JSON.stringify({ ...plan, transport: "extinct" }),
          updated_at_ms: now,
        })
        .where("execution_id", "=", expected.executionId)
        .where("identity_json", "=", row.identity_json),
    );
  }, options);
}

/** Close the admission gate even after execution permission expires. A late
 * wrapper can no longer bind or launch payload. This is NOT extinction proof. */
export function sealSupervisedCommandPlan(
  expected: SupervisedOperationExecution,
  now: number,
  options: Options = {},
) {
  return writeSupervisedWorkflow((db) => {
    assertExactLaunchOwner(db, expected);
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db)
        .updateTable("task_flow_command_resources")
        .set({ state: "sealed", updated_at_ms: now })
        .where("execution_id", "=", expected.executionId)
        .where("state", "=", "planned"),
    );
    return (
      executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<DB>(db)
          .selectFrom("task_flow_command_resources")
          .select("state")
          .where("execution_id", "=", expected.executionId),
      )?.state === "sealed"
    );
  }, options);
}

/** Exact spawning owner reports BOTH required-all transport extinction and
 * absence of its sealed never-reused unit. Missing-unit reads alone are invalid. */
export function recordSealedSupervisedCommandClosed(
  expected: SupervisedOperationExecution,
  now: number,
  options: Options = {},
) {
  writeSupervisedWorkflow((db) => {
    assertExactLaunchOwner(db, expected);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<DB>(db)
        .selectFrom("task_flow_command_resources")
        .selectAll()
        .where("execution_id", "=", expected.executionId),
    );
    const binding = decodeBinding(row?.identity_json ?? null);
    // A concurrent recovery sweep may already have recorded this closure.
    if (row?.state === "closed" && !binding.identity) {
      return;
    }
    if (row?.state !== "sealed") {
      throw new Error("Command launch gate was not sealed");
    }
    if (binding.identity || (binding.prebinding && binding.prebinding.transport !== "extinct")) {
      throw new Error("Command transport extinction is not recorded");
    }
    const result = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db)
        .updateTable("task_flow_command_resources")
        .set({ state: "closed", updated_at_ms: now })
        .where("execution_id", "=", expected.executionId)
        .where("state", "=", "sealed")
        .where(
          "identity_json",
          row?.identity_json === null ? "is" : "=",
          row?.identity_json ?? null,
        ),
    );
    if (result.numAffectedRows !== 1n) {
      throw new Error("Command launch gate was not sealed");
    }
  }, options);
}

export function bindSupervisedCommandResources(
  execution: SupervisedOperationExecution,
  value: SupervisedCommandScopeIdentity,
  now: number,
  options: Options = {},
) {
  const identity = identitySchema.parse(value);
  if (
    identity.executionId !== execution.executionId ||
    identity.scopeName !== supervisedCommandScopeName(execution.executionId)
  ) {
    throw new Error("Command resource identity does not match its reserved execution");
  }
  return writeSupervisedWorkflow((db) => {
    assertSupervisedOperationInTransaction(db, execution, now);
    const result = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db)
        .updateTable("task_flow_command_resources")
        .set({
          state: "bound",
          identity_json: JSON.stringify(identity),
          updated_at_ms: now,
        })
        .where("execution_id", "=", execution.executionId)
        .where("state", "=", "planned")
        .where("scope_name", "=", identity.scopeName),
    );
    if (result.numAffectedRows !== 1n) {
      throw new Error("Command resource binding was already consumed");
    }
  }, options);
}

/** Observation only: an expired owner may report exact kernel closure, but
 * cannot obtain new action authority or rewrite its task/operation outcome. */
export function recordSupervisedCommandResourcesClosed(
  identity: SupervisedCommandScopeIdentity,
  now: number,
  options: Options = {},
) {
  const encoded = JSON.stringify(identitySchema.parse(identity));
  writeSupervisedWorkflow((db) => {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<DB>(db)
        .selectFrom("task_flow_command_resources")
        .selectAll()
        .where("execution_id", "=", identity.executionId),
    );
    if (!row || row.identity_json !== encoded) {
      throw new Error("Kernel closure does not match the exact accepted resource binding");
    }
    if (row.state === "closed") {
      return;
    }
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db)
        .updateTable("task_flow_command_resources")
        .set({ state: "closed", updated_at_ms: now })
        .where("execution_id", "=", identity.executionId)
        .where("state", "=", "bound")
        .where("identity_json", "=", encoded),
    );
  }, options);
}
