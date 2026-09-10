import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import {
  inspectNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "../node-host/node-worker-process-identity.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { getSupervisedCommandResources } from "./supervised-command-custody.persistence.js";
import { isSupervisedCommandBootRetired } from "./supervised-command-resources.js";
import { readExecution } from "./supervised-operation.persistence.js";
import {
  parseSupervisedOperationExecution,
  parseSupervisedOperation,
} from "./supervised-operation.types.js";
import { readSupervisedProcessHostIdentity } from "./supervised-process-resources.js";
import {
  readSupervisedWorkflow,
  writeSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";

const sql = (db: DatabaseSync) => getNodeSqliteKysely<DB>(db);
const MAX_SUPERVISED_OPERATION_PROCESSES = 8;

/** Physical capacity is independent of task authority, execution leases and receipts.
 * Reserve in the same transaction as the execution, before creating a process. */
export function reserveSupervisedOperationLaunchInTransaction(
  db: DatabaseSync,
  executionId: string,
  launcher: NodeWorkerProcessIdentity,
  now: number,
): void {
  if (
    !Number.isSafeInteger(launcher.pid) ||
    launcher.pid <= 0 ||
    !Number.isSafeInteger(launcher.startTime)
  ) {
    throw new Error("Invalid independent launcher identity");
  }
  const count =
    executeSqliteQueryTakeFirstSync(
      db,
      sql(db)
        .selectFrom("task_flow_operation_launches")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("state", "in", ["reserved", "spawned"]),
    )?.count ?? 0;
  if (count >= MAX_SUPERVISED_OPERATION_PROCESSES) {
    throw new Error("Independent operation process capacity exhausted");
  }
  executeSqliteQuerySync(
    db,
    sql(db).insertInto("task_flow_operation_launches").values({
      execution_id: executionId,
      launcher_pid: launcher.pid,
      launcher_start_time: launcher.startTime,
      runner_pid: null,
      runner_start_time: null,
      state: "reserved",
      created_at_ms: now,
      updated_at_ms: now,
    }),
  );
}

/** Late identity observations confer no execution authority. Either launcher or
 * child may fill the same reservation, but neither may replace its identity. */
export function observeSupervisedOperationProcess(
  executionId: string,
  identity: NodeWorkerProcessIdentity,
  now: number,
  options: Options = {},
): void {
  writeSupervisedWorkflow((db) => {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      sql(db)
        .selectFrom("task_flow_operation_launches")
        .selectAll()
        .where("execution_id", "=", executionId),
    );
    if (!row) {
      throw new Error("Independent process has no launch reservation");
    }
    const host = readExecution(db, executionId)?.launchHost;
    if (host) {
      const current = readSupervisedProcessHostIdentity();
      if (host.hostId !== current.hostId || host.bootId !== current.bootId) {
        throw new Error("Independent process launch belongs to another host boot");
      }
    }
    if (row.runner_pid !== null) {
      if (row.runner_pid !== identity.pid || row.runner_start_time !== identity.startTime) {
        throw new Error("Independent process identity is immutable");
      }
      return;
    }
    if (row.state !== "reserved") {
      throw new Error("Independent process launch already resolved");
    }
    executeSqliteQuerySync(
      db,
      sql(db)
        .updateTable("task_flow_operation_launches")
        .set({
          runner_pid: identity.pid,
          runner_start_time: identity.startTime,
          state: "spawned",
          updated_at_ms: now,
        })
        .where("execution_id", "=", executionId),
    );
  }, options);
}

/** Only the exact spawning owner may report a definite pre-spawn failure. */
export function recordSupervisedOperationNotSpawned(
  executionId: string,
  launcher: NodeWorkerProcessIdentity,
  now: number,
  options: Options = {},
): void {
  writeSupervisedWorkflow((db) => {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      sql(db)
        .selectFrom("task_flow_operation_launches")
        .selectAll()
        .where("execution_id", "=", executionId),
    );
    if (
      !row ||
      row.launcher_pid !== launcher.pid ||
      row.launcher_start_time !== launcher.startTime ||
      row.runner_pid !== null ||
      !["reserved", "not_spawned"].includes(row.state)
    ) {
      throw new Error("Cannot report definite spawn failure for this reservation");
    }
    executeSqliteQuerySync(
      db,
      sql(db)
        .updateTable("task_flow_operation_launches")
        .set({ state: "not_spawned", updated_at_ms: now })
        .where("execution_id", "=", executionId),
    );
  }, options);
}

/** Only called from the exact spawned ChildProcess exit listener. The trusted
 * bootstrap observes its reservation before any descendant-producing adapter;
 * no identity, execution binding, dispatch or resource plan means no descendants
 * can have been admitted. Launcher death or a missing PID is NOT this evidence. */
export function recordSupervisedOperationBootstrapExited(
  executionId: string,
  launcher: NodeWorkerProcessIdentity,
  now: number,
  options: Options = {},
): void {
  writeSupervisedWorkflow((db) => {
    const launch = executeSqliteQueryTakeFirstSync(
      db,
      sql(db)
        .selectFrom("task_flow_operation_launches")
        .selectAll()
        .where("execution_id", "=", executionId),
    );
    if (
      !launch ||
      launch.state !== "reserved" ||
      launch.runner_pid !== null ||
      launch.launcher_pid !== launcher.pid ||
      launch.launcher_start_time !== launcher.startTime
    ) {
      return;
    }
    const row = executeSqliteQueryTakeFirstSync(
      db,
      sql(db)
        .selectFrom("task_flow_operation_executions")
        .selectAll()
        .where("execution_id", "=", executionId),
    );
    if (!row) {
      return;
    }
    const execution = parseSupervisedOperationExecution(JSON.parse(row.record_json));
    if (
      execution.executionId !== executionId ||
      execution.process !== null ||
      execution.dispatchedAt !== null ||
      row.dispatched_at_ms !== null ||
      executeSqliteQueryTakeFirstSync(
        db,
        sql(db)
          .selectFrom("task_flow_command_resources")
          .select("execution_id")
          .where("execution_id", "=", executionId),
      )
    ) {
      return;
    }
    executeSqliteQuerySync(
      db,
      sql(db)
        .updateTable("task_flow_operation_launches")
        .set({ state: "gone", updated_at_ms: now })
        .where("execution_id", "=", executionId)
        .where("state", "=", "reserved")
        .where("runner_pid", "is", null),
    );
  }, options);
}

export function reconcileSupervisedOperationCapacity(
  now: number,
  options: Options = {},
): unknown[] {
  const errors: unknown[] = [];
  const rows =
    readSupervisedWorkflow(
      (db) =>
        tableExists(db, "task_flow_operation_launches")
          ? executeSqliteQuerySync(
              db,
              sql(db)
                .selectFrom("task_flow_operation_launches")
                .selectAll()
                .where("state", "in", ["reserved", "spawned"])
                .limit(MAX_SUPERVISED_OPERATION_PROCESSES),
            ).rows
          : [],
      options,
    ) ?? [];
  for (const row of rows) {
    try {
      const execution = readSupervisedWorkflow(
        (db) => readExecution(db, row.execution_id),
        options,
      );
      let launchBootRetired = false;
      if (execution?.launchHost) {
        try {
          const host = readSupervisedProcessHostIdentity();
          if (host.hostId !== execution.launchHost.hostId) {
            continue;
          }
          launchBootRetired = host.bootId !== execution.launchHost.bootId;
        } catch {
          continue;
        }
      }
      if (row.state === "reserved") {
        if (!launchBootRetired) {
          continue;
        }
        writeSupervisedWorkflow((db) => {
          const current = readExecution(db, row.execution_id);
          const resource = executeSqliteQueryTakeFirstSync(
            db,
            sql(db)
              .selectFrom("task_flow_command_resources")
              .select("state")
              .where("execution_id", "=", row.execution_id),
          );
          if (
            current?.launchHost?.hostId !== execution?.launchHost?.hostId ||
            current?.launchHost?.bootId !== execution?.launchHost?.bootId ||
            (resource && resource.state !== "closed")
          ) {
            return;
          }
          executeSqliteQuerySync(
            db,
            sql(db)
              .updateTable("task_flow_operation_launches")
              .set({ state: "gone", updated_at_ms: now })
              .where("execution_id", "=", row.execution_id)
              .where("state", "=", "reserved")
              .where("runner_pid", "is", null)
              .where("launcher_pid", "=", row.launcher_pid)
              .where("launcher_start_time", "=", row.launcher_start_time),
          );
        }, options);
        continue;
      }
      if (row.runner_pid === null || row.runner_start_time === null) {
        continue;
      }
      const state = inspectNodeWorkerProcessIdentity({
        pid: row.runner_pid,
        startTime: row.runner_start_time,
      });
      const resources = getSupervisedCommandResources(row.execution_id, options);
      if (!resources) {
        const previous = readSupervisedWorkflow(
          (db) =>
            executeSqliteQueryTakeFirstSync(
              db,
              sql(db)
                .selectFrom("task_flow_operation_executions as e")
                .innerJoin("task_flow_operations as o", "o.operation_id", "e.operation_id")
                .select(["e.dispatched_at_ms", "e.finished_at_ms", "o.record_json"])
                .where("e.execution_id", "=", row.execution_id),
            ),
          options,
        );
        if (
          !previous ||
          (previous.dispatched_at_ms !== null &&
            parseSupervisedOperation(JSON.parse(previous.record_json)).request.kind === "review")
        ) {
          // Old unscoped review history is not newly invented kernel evidence.
          continue;
        }
      }
      if (resources && resources.state !== "closed") {
        continue;
      }
      if (!launchBootRetired && state !== "dead" && state !== "reused") {
        try {
          const host = resources?.prebinding ? readSupervisedProcessHostIdentity() : null;
          const retiredPrebinding =
            host &&
            resources?.prebinding &&
            host.hostId === resources.prebinding.hostId &&
            host.bootId !== resources.prebinding.bootId;
          if (
            !retiredPrebinding &&
            (!resources?.identity || !isSupervisedCommandBootRetired(resources.identity))
          ) {
            continue;
          }
        } catch {
          // Wrong/unknown host evidence cannot retire a coincidentally equal PID.
          continue;
        }
      }
      writeSupervisedWorkflow(
        (db) =>
          executeSqliteQuerySync(
            db,
            sql(db)
              .updateTable("task_flow_operation_launches")
              .set({ state: "gone", updated_at_ms: now })
              .where("execution_id", "=", row.execution_id)
              .where("state", "=", "spawned")
              .where("runner_pid", "=", row.runner_pid)
              .where("runner_start_time", "=", row.runner_start_time),
          ),
        options,
      );
    } catch (error) {
      // A bad record cannot prove closure. Retain its reservation and report
      // the failure while still reconciling independent healthy owners.
      errors.push(error);
    }
  }
  // Without an exact child exit or recorded same-host boot retirement, a
  // reserved slot remains unknown, even after its launcher disappears.
  return errors;
}
