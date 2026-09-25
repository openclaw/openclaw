import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { inspectNodeWorkerProcessIdentity } from "../node-host/node-worker-process-identity.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  getSupervisedCommandResources,
  recordSupervisedCommandResourcesClosed,
} from "./supervised-command-custody.js";
import { reconcileSupervisedCommandPrebinding } from "./supervised-command-prebinding.js";
import {
  isSupervisedCommandScopeClosed,
  terminateSupervisedCommandScope,
} from "./supervised-command-resources.js";
import { assertSupervisedOperationInTransaction } from "./supervised-operation.store.js";
import { parseSupervisedOperationExecution } from "./supervised-operation.types.js";
import {
  readSupervisedWorkflow,
  writeSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";

const PAGE_SIZE = 8;
const CLEANUP_LEASE_MS = 30_000;
const sql = (db: DatabaseSync) => getNodeSqliteKysely<DB>(db);

/** Unknown/corrupt custody is not permission to signal. Read the exact execution
 * afresh: neither a cached expiry nor an immutable terminal receipt grants action. */
function cleanupEligible(db: DatabaseSync, executionId: string, now: number): boolean {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("task_flow_operation_executions")
      .select("record_json")
      .where("execution_id", "=", executionId),
  );
  if (!row) {
    throw new Error("Command cleanup execution is missing");
  }
  const execution = parseSupervisedOperationExecution(JSON.parse(row.record_json));
  if (execution.executionId !== executionId) {
    throw new Error("Command cleanup execution identity changed");
  }
  try {
    assertSupervisedOperationInTransaction(db, execution, now);
  } catch (error) {
    if (error instanceof Error && error.message === "Operation no longer owns execution") {
      return true;
    }
    throw error;
  }
  const launch = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("task_flow_operation_launches")
      .select(["runner_pid", "runner_start_time"])
      .where("execution_id", "=", executionId),
  );
  if (launch?.runner_pid === null || launch?.runner_start_time === null || !launch) {
    return false;
  }
  const state = inspectNodeWorkerProcessIdentity({
    pid: launch.runner_pid,
    startTime: launch.runner_start_time,
  });
  return state === "dead" || state === "reused";
}

/** Physical reconciliation deliberately does not filter by semantic task state
 * or latest generation. The caller carries the keyset cursor across ticks so
 * a persistent failure cannot starve the ninth resource. No receipt is rewritten. */
export async function reconcileSupervisedCommandResources(params: {
  options?: Options;
  onlyFlowId?: string;
  ownerId: string;
  assertCleanupCurrent: () => void;
  onError: (error: unknown) => void;
  afterExecutionId?: string;
}): Promise<{ nextExecutionId: string | undefined; inspected: number }> {
  if (!params.ownerId || params.ownerId.length > 128) {
    throw new Error("Invalid command cleanup owner");
  }
  const options = params.options ?? {};
  params.assertCleanupCurrent();
  const rows =
    readSupervisedWorkflow((db) => {
      if (!tableExists(db, "task_flow_command_resources")) {
        return [];
      }
      let query = sql(db)
        .selectFrom("task_flow_command_resources as resource")
        .innerJoin(
          "task_flow_operation_executions as execution",
          "execution.execution_id",
          "resource.execution_id",
        )
        .innerJoin(
          "task_flow_operations as operation",
          "operation.operation_id",
          "execution.operation_id",
        )
        .select("resource.execution_id")
        .where("resource.state", "in", ["planned", "sealed", "bound"])
        .orderBy("resource.execution_id", "asc")
        .limit(PAGE_SIZE);
      if (params.onlyFlowId !== undefined) {
        query = query.where("operation.flow_id", "=", params.onlyFlowId);
      }
      if (params.afterExecutionId !== undefined) {
        query = query.where("resource.execution_id", ">", params.afterExecutionId);
      }
      return executeSqliteQuerySync(db, query).rows;
    }, options) ?? [];

  for (const item of rows) {
    // A fresh nonce also prevents a resumed invocation of the same supervisor
    // owner from using an earlier cleanup lease (same-owner ABA).
    const cleanupOwner = `${params.ownerId}:${randomUUID()}`;
    let claimed = false;
    try {
      params.assertCleanupCurrent();
      const resource = getSupervisedCommandResources(item.execution_id, options);
      if (resource && ["planned", "sealed"].includes(resource.state)) {
        await reconcileSupervisedCommandPrebinding(
          item.execution_id,
          params.assertCleanupCurrent,
          options,
        );
        continue;
      }
      if (resource?.state !== "bound" || !resource.identity || !resource.identity_json) {
        continue;
      }
      const { identity, identity_json: encoded } = resource;
      if (await isSupervisedCommandScopeClosed(identity)) {
        // Exact physical observation remains admissible after task cancellation;
        // the store still compares the immutable accepted binding.
        recordSupervisedCommandResourcesClosed(identity, Date.now(), options);
        continue;
      }
      params.assertCleanupCurrent();
      const expiresAt = Date.now() + CLEANUP_LEASE_MS;
      claimed = writeSupervisedWorkflow((db) => {
        params.assertCleanupCurrent();
        const now = Date.now();
        if (!cleanupEligible(db, item.execution_id, now)) {
          return false;
        }
        return (
          executeSqliteQuerySync(
            db,
            sql(db)
              .updateTable("task_flow_command_resources")
              .set({ cleanup_owner: cleanupOwner, cleanup_expires_at_ms: expiresAt })
              .where("execution_id", "=", item.execution_id)
              .where("state", "=", "bound")
              .where("identity_json", "=", encoded)
              .where((eb) =>
                eb.or([eb("cleanup_owner", "is", null), eb("cleanup_expires_at_ms", "<=", now)]),
              ),
          ).numAffectedRows === 1n
        );
      }, options);
      if (!claimed) {
        continue;
      }
      const assertOwned = () => {
        params.assertCleanupCurrent();
        const current = readSupervisedWorkflow((db) => {
          const row = executeSqliteQueryTakeFirstSync(
            db,
            sql(db)
              .selectFrom("task_flow_command_resources")
              .selectAll()
              .where("execution_id", "=", item.execution_id),
          );
          const now = Date.now();
          return (
            row?.state === "bound" &&
            row.identity_json === encoded &&
            row.cleanup_owner === cleanupOwner &&
            row.cleanup_expires_at_ms !== null &&
            row.cleanup_expires_at_ms > now &&
            cleanupEligible(db, item.execution_id, now)
          );
        }, options);
        if (!current) {
          throw new Error("Command cleanup custody no longer current");
        }
      };
      assertOwned();
      await terminateSupervisedCommandScope(identity, assertOwned);
      assertOwned();
      if (await isSupervisedCommandScopeClosed(identity)) {
        recordSupervisedCommandResourcesClosed(identity, Date.now(), options);
      }
    } catch (error) {
      try {
        params.onError(error);
      } catch {
        // An observer failure must not strand other independent resource rows.
      }
    } finally {
      if (claimed) {
        try {
          writeSupervisedWorkflow(
            (db) =>
              executeSqliteQuerySync(
                db,
                sql(db)
                  .updateTable("task_flow_command_resources")
                  .set({ cleanup_owner: null, cleanup_expires_at_ms: null })
                  .where("execution_id", "=", item.execution_id)
                  .where("cleanup_owner", "=", cleanupOwner),
              ),
            options,
          );
        } catch (error) {
          try {
            params.onError(error);
          } catch {
            /* Continue the bounded sweep. */
          }
        }
      }
    }
  }
  return {
    nextExecutionId: rows.length === PAGE_SIZE ? rows.at(-1)?.execution_id : undefined,
    inspected: rows.length,
  };
}
