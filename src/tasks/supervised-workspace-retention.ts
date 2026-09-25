import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isMissingPathError } from "../infra/errno.js";
import { removePathWithinRoot } from "../infra/fs-safe-remove.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
} from "../node-host/node-worker-process-identity.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { assertSupervisedOperationInTransaction } from "./supervised-operation.store.js";
import type { SupervisedOperationExecution } from "./supervised-operation.types.js";
import { decodeTaskRow } from "./supervised-task.persistence.js";
import { assertSupervisedAttemptInTransaction } from "./supervised-task.store.js";
import type { SupervisedTask } from "./supervised-task.types.js";
import {
  readSupervisedWorkflow,
  writeSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";
import { readSupervisedWorkflowContractInTransaction } from "./supervised-workflow.store.js";
import { supervisedWorkspaceVersionPath } from "./supervised-workspace-path.js";

const sql = (db: DatabaseSync) => getNodeSqliteKysely<DB>(db);
const ARTIFACT_BYTES = 64 * 1024 * 1024;
export type SupervisedArtifactOwner =
  | { kind: "attempt"; task: SupervisedTask }
  | { kind: "operation"; execution: SupervisedOperationExecution };

/** SQL reserves every private directory before mkdir/copy. These are retained
 * artifact budgets, not a claim of a kernel filesystem quota on live writers. */
export function reserveSupervisedWorkspace(
  owner: SupervisedArtifactOwner,
  kind: "draft" | "version",
  now: number,
  options: Options = {},
) {
  return writeSupervisedWorkflow(
    (db) => reserveSupervisedWorkspaceInTransaction(db, owner, kind, now),
    options,
  );
}

/** Resource custody can reserve its export in the same transaction as its plan. */
export function reserveSupervisedWorkspaceInTransaction(
  db: DatabaseSync,
  owner: SupervisedArtifactOwner,
  kind: "draft" | "version",
  now: number,
  allowWorkflowlessDraft = false,
) {
  const processIdentity = requireNodeWorkerProcessIdentity(process.pid);
  const identity =
    owner.kind === "attempt"
      ? (assertSupervisedAttemptInTransaction(db, owner.task, now),
        {
          flowId: owner.task.flowId,
          episode: owner.task.episode,
          id: owner.task.attempt!.id,
        })
      : (() => {
          const op = assertSupervisedOperationInTransaction(db, owner.execution, now);
          return { flowId: op.flowId, episode: op.episode, id: owner.execution.executionId };
        })();
  const contract = readSupervisedWorkflowContractInTransaction(
    db,
    identity.flowId,
    identity.episode,
  );
  if (!contract && !(allowWorkflowlessDraft && owner.kind === "attempt" && kind === "draft")) {
    throw new Error("Artifact allocation requires an accepted workflow");
  }
  const usage = (flowId?: string) => {
    let query = sql(db)
      .selectFrom("task_flow_workspace_allocations")
      .select(({ fn }) => [
        fn.sum<number>("reserved_bytes").as("bytes"),
        fn.countAll<number>().as("count"),
      ])
      .where("state", "!=", "deleted");
    if (flowId) {
      query = query.where("flow_id", "=", flowId);
    }
    return executeSqliteQueryTakeFirstSync(db, query)!;
  };
  const local = usage(identity.flowId),
    global = usage();
  if (
    (local.bytes ?? 0) + ARTIFACT_BYTES > 512 * 1024 * 1024 ||
    local.count >= 512 ||
    (global.bytes ?? 0) + ARTIFACT_BYTES > 4 * 1024 * 1024 * 1024 ||
    global.count >= 4096
  ) {
    throw new Error("Retained task artifact capacity exhausted; no new workspace was created");
  }
  const allocationId = randomUUID();
  executeSqliteQuerySync(
    db,
    sql(db)
      .insertInto("task_flow_workspace_allocations")
      .values({
        allocation_id: allocationId,
        flow_id: identity.flowId,
        episode: identity.episode,
        owner_kind: owner.kind,
        owner_id: identity.id,
        owner_pid: processIdentity.pid,
        owner_start_time: processIdentity.startTime,
        kind,
        state: "reserved",
        reserved_bytes: ARTIFACT_BYTES,
        retention_ms: (contract?.contract.retentionDays ?? 1) * 86_400_000,
        created_at_ms: now,
        updated_at_ms: now,
      }),
  );
  return allocationId;
}

export function retainSupervisedWorkspaceInTransaction(
  db: DatabaseSync,
  allocationId: string,
  flowId: string,
  episode: number,
  bytes: number,
  now: number,
) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > ARTIFACT_BYTES) {
    throw new Error("Invalid retained artifact byte count");
  }
  const updated = executeSqliteQuerySync(
    db,
    sql(db)
      .updateTable("task_flow_workspace_allocations")
      .set({ state: "retained", reserved_bytes: bytes, updated_at_ms: now })
      .where("allocation_id", "=", allocationId)
      .where("flow_id", "=", flowId)
      .where("episode", "=", episode)
      .where("state", "=", "reserved")
      .where("kind", "=", "version"),
  );
  if (updated.numAffectedRows !== 1n) {
    throw new Error("Artifact lacks its exact live allocation reservation");
  }
}

/** Acceptance grants discard permission only to the exact copied scratch
 * allocation. Writer release is independent: copying does not join a writer. */
export function markSupervisedWorkspaceDiscardableInTransaction(
  db: DatabaseSync,
  acceptedVersion: string,
  allocationId: string,
  now: number,
) {
  const accepted = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("task_flow_workspace_allocations")
      .selectAll()
      .where("allocation_id", "=", acceptedVersion)
      .where("kind", "=", "version")
      .where("state", "=", "retained"),
  );
  if (!accepted) {
    throw new Error("Scratch discard requires an accepted immutable workspace");
  }
  const updated = executeSqliteQuerySync(
    db,
    sql(db)
      .updateTable("task_flow_workspace_allocations")
      .set({ discardable_at_ms: now })
      .where("allocation_id", "=", allocationId)
      .where("flow_id", "=", accepted.flow_id)
      .where("episode", "=", accepted.episode)
      .where("owner_kind", "=", accepted.owner_kind)
      .where("owner_id", "=", accepted.owner_id)
      .where("owner_pid", "=", accepted.owner_pid)
      .where("owner_start_time", "=", accepted.owner_start_time)
      .where("kind", "=", "draft")
      .where("state", "=", "reserved"),
  );
  if (updated.numAffectedRows !== 1n) {
    throw new Error("Accepted workspace does not own the exact scratch allocation");
  }
}

/** Called only after the owning runtime has joined its writer, or a command's
 * kernel scope is closed. Promise settlement and lease expiry alone are not
 * proof. Frozen versions retain their independent acceptance references. */
export function releaseSupervisedWorkspaceOwner(
  kind: SupervisedArtifactOwner["kind"],
  id: string,
  now: number,
  options: Options = {},
) {
  const identity = requireNodeWorkerProcessIdentity(process.pid);
  writeSupervisedWorkflow(
    (db) =>
      executeSqliteQuerySync(
        db,
        sql(db)
          .updateTable("task_flow_workspace_allocations")
          .set({ state: "released", updated_at_ms: now })
          .where("owner_kind", "=", kind)
          .where("owner_id", "=", id)
          .where("owner_pid", "=", identity.pid)
          .where("owner_start_time", "=", identity.startTime)
          .where("state", "=", "reserved")
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom("task_flow_command_resources as resource")
                  .select("resource.execution_id")
                  .where("task_flow_workspace_allocations.owner_kind", "=", "operation")
                  .whereRef(
                    "resource.execution_id",
                    "=",
                    "task_flow_workspace_allocations.owner_id",
                  )
                  .where("resource.state", "!=", "closed"),
              ),
            ),
          )
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom("task_flow_attempt_resources as r")
                  .select("r.resource_id")
                  .where("task_flow_workspace_allocations.owner_kind", "=", "attempt")
                  .whereRef("r.attempt_id", "=", "task_flow_workspace_allocations.owner_id")
                  .where("r.state", "!=", "closed"),
              ),
            ),
          ),
      ),
    options,
  );
}

function canRetire(
  db: DatabaseSync,
  flowId: string,
  now: number,
  retentionMs: number,
  discardableScratch = false,
): boolean {
  const latest = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("task_flow_episodes")
      .selectAll()
      .where("flow_id", "=", flowId)
      .orderBy("episode", "desc")
      .limit(1),
  );
  let task;
  try {
    task = latest ? decodeTaskRow(latest) : undefined;
  } catch {
    return false;
  }
  if (
    !latest ||
    !task ||
    (discardableScratch
      ? task.phase === "input_required" || task.endpoint?.effects === "unknown"
      : task.updatedAt + retentionMs > now ||
        !["succeeded", "partial", "failed", "cancelled"].includes(latest.phase))
  ) {
    return false;
  }
  const attemptResource = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("task_flow_attempt_resources")
      .select("resource_id")
      .where("flow_id", "=", flowId)
      .where("state", "!=", "closed")
      .limit(1),
  );
  if (attemptResource) {
    return false;
  }
  // Input endpoints, quarantine, pending effects/delivery and live/unknown OS
  // process identities hold evidence even after an ordinary retention deadline.
  const fault = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("task_flow_recovery")
      .select("flow_id")
      .where("flow_id", "=", flowId)
      .where("fault_json", "is not", null),
  );
  const pending = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("task_flow_operations")
      .select("operation_id")
      .where("flow_id", "=", flowId)
      .where(
        "state",
        "in",
        discardableScratch
          ? ["reconciling", "input_required"]
          : ["queued", "running", "reconciling", "input_required"],
      ),
  );
  // Healthy concurrent operations and delivery use immutable versions, not a
  // joined writer's scratch. Forensic/uncertain work still holds its evidence.
  if (discardableScratch) {
    return !fault && !pending;
  }
  const process = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("task_flow_operation_launches as l")
      .innerJoin("task_flow_operation_executions as e", "e.execution_id", "l.execution_id")
      .innerJoin("task_flow_operations as o", "o.operation_id", "e.operation_id")
      .select("l.execution_id")
      .where("o.flow_id", "=", flowId)
      .where("l.state", "in", ["reserved", "spawned"]),
  );
  const delivery = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("task_flow_notifications")
      .select("notification_id")
      .where("flow_id", "=", flowId)
      .where("state", "in", ["pending", "queued", "unknown"]),
  );
  return !fault && !pending && !process && !delivery;
}

/** A deletion claim is durable before IO. Reopening retries only that same
 * private UUID; original workspaces and unrelated directories are never swept. */
export async function retireSupervisedWorkspaces(
  now: number,
  options: Options = {},
  canContinue: () => boolean = () => true,
) {
  const rows =
    readSupervisedWorkflow(
      (db) =>
        tableExists(db, "task_flow_workspace_allocations")
          ? executeSqliteQuerySync(
              db,
              sql(db)
                .selectFrom("task_flow_workspace_allocations")
                .selectAll()
                .where("state", "!=", "deleted")
                .where((eb) =>
                  eb.or([
                    eb("state", "=", "deleting"),
                    eb.and([
                      eb("kind", "=", "draft"),
                      eb("state", "=", "released"),
                      eb("discardable_at_ms", "is not", null),
                    ]),
                    eb(eb("updated_at_ms", "+", eb.ref("retention_ms")), "<=", now),
                  ]),
                )
                .orderBy("updated_at_ms")
                .limit(4096),
            ).rows
          : [],
      options,
    ) ?? [];
  // Admission caps nondeleted allocations at 4096; scan past held evidence so
  // it cannot permanently starve a later completed task. Bound IO separately.
  let removed = 0;
  const failures: unknown[] = [];
  for (const row of rows) {
    if (removed >= 64 || !canContinue()) {
      break;
    }
    if (row.state === "reserved") {
      const identity = inspectNodeWorkerProcessIdentity({
        pid: row.owner_pid,
        startTime: row.owner_start_time,
      });
      if (identity !== "dead" && identity !== "reused") {
        continue;
      }
    }
    const claimed = writeSupervisedWorkflow((db) => {
      const discardableScratch =
        row.kind === "draft" &&
        row.discardable_at_ms !== null &&
        (row.state === "released" || row.state === "deleting");
      if (!canRetire(db, row.flow_id, now, row.retention_ms, discardableScratch)) {
        return false;
      }
      return (
        executeSqliteQuerySync(
          db,
          sql(db)
            .updateTable("task_flow_workspace_allocations")
            .set({ state: "deleting" })
            .where("allocation_id", "=", row.allocation_id)
            .where("state", "=", row.state)
            .where("updated_at_ms", "=", row.updated_at_ms)
            .where(
              "discardable_at_ms",
              row.discardable_at_ms === null ? "is" : "=",
              row.discardable_at_ms,
            ),
        ).numAffectedRows === 1n
      );
    }, options);
    if (!claimed) {
      continue;
    }
    const directory = supervisedWorkspaceVersionPath(row.allocation_id, options);
    const root = path.dirname(directory);
    // Do not follow a replaced artifact-root alias into another filesystem tree.
    try {
      await removePathWithinRoot({
        rootDir: root,
        relativePath: row.allocation_id,
        recursive: true,
        force: true,
      });
    } catch (error) {
      if (!isMissingPathError(error)) {
        failures.push(error);
        continue;
      }
    }
    writeSupervisedWorkflow(
      (db) =>
        executeSqliteQuerySync(
          db,
          sql(db)
            .updateTable("task_flow_workspace_allocations")
            .set({ state: "deleted", reserved_bytes: 0, updated_at_ms: now })
            .where("allocation_id", "=", row.allocation_id)
            .where("state", "=", "deleting"),
        ),
      options,
    );
    removed += 1;
  }
  if (failures.length) {
    throw new AggregateError(failures, "Some task artifacts require cleanup reconciliation");
  }
  return removed;
}

/** The worker owns this bounded housekeeping loop, but cleanup never borrows
 * an attempt lease as evidence of physical process extinction. */
export function startSupervisedWorkspaceRetention(
  options: Options,
  onError: (error: unknown) => void,
) {
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) {
      return;
    }
    running = true;
    void retireSupervisedWorkspaces(Date.now(), options, () => !stopped)
      .catch(onError)
      .finally(() => {
        running = false;
      });
  }, 60_000);
  timer.unref();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
