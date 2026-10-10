import type { DatabaseSync } from "node:sqlite";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import type { NodeWorkerSupervisorIdentity } from "../worker/node-supervisor-protocol.js";
import type {
  NodeWorkerLaunchClaim,
  NodeWorkerLaunchClaimResult,
  NodeWorkerLaunchObservation,
  NodeWorkerLaunchObservedSupervisorState,
} from "./node-worker-journal.types.js";
import {
  isNodeWorkerTerminalState,
  nodeWorkerLaunchReceiptFromRow,
  validateNodeWorkerContainerIdentity,
  validateNodeWorkerPlanHash,
  validateNodeWorkerProcessIdentity,
  type NodeWorkerCleanupBinding,
  type NodeWorkerCleanupMode,
  type NodeWorkerContainerIdentity,
  type NodeWorkerLaunchReceipt,
  type NodeWorkerLaunchRow,
  type NodeWorkerTerminalState,
} from "./node-worker-launch-receipt.js";
import type { NodeWorkerProcessIdentity } from "./node-worker-process-identity.js";

type NodeWorkerLaunchDatabase = Pick<
  OpenClawStateDatabase,
  | "node_worker_launch_cleanup"
  | "node_worker_launch_process_scopes"
  | "node_worker_launch_containers"
  | "node_worker_launches"
  | "node_worker_turns"
>;

type LaunchSchema = ReturnType<typeof getAdmittedSqliteSchemaFacts>;
type LaunchTable = keyof NodeWorkerLaunchDatabase;
type LaunchIdentity = Pick<NodeWorkerLaunchReceipt, "launchId" | "planHash">;

const NODE_WORKER_LAUNCH_SCHEMA_END = "\n  WHERE completed_at_ms IS NOT NULL;";
const initializedDatabases = new WeakSet<DatabaseSync>();
const TERMINAL_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const TERMINAL_PRUNE_BATCH_LIMIT = 256;

function ensureNodeWorkerLaunchSchema(
  database: DatabaseSync,
  table: Exclude<keyof NodeWorkerLaunchDatabase, "node_worker_turns">,
): void {
  // sqlite-allow-raw -- Canonical feature-local additive DDL only.
  database.exec(
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table, {
      endMarker: table === "node_worker_launches" ? NODE_WORKER_LAUNCH_SCHEMA_END : undefined,
    }),
  );
}

function query(database: DatabaseSync) {
  return getNodeSqliteKysely<NodeWorkerLaunchDatabase>(database);
}

function hasLaunchTable(database: DatabaseSync, schema: LaunchSchema, table: LaunchTable): boolean {
  // Unadmitted/authorizer-controlled connections cannot retain schema facts.
  return schema ? schema.tables.has(table) : tableExists(database, table);
}

function selectLaunchRows(database: DatabaseSync, schema: LaunchSchema) {
  return query(database)
    .selectFrom("node_worker_launches")
    .selectAll("node_worker_launches")
    .$if(hasLaunchTable(database, schema, "node_worker_launch_containers"), (selection) =>
      selection
        .leftJoin(
          "node_worker_launch_containers",
          "node_worker_launch_containers.launch_id",
          "node_worker_launches.launch_id",
        )
        .select("node_worker_launch_containers.container_json"),
    )
    .$if(hasLaunchTable(database, schema, "node_worker_launch_cleanup"), (selection) =>
      selection
        .leftJoin(
          "node_worker_launch_cleanup",
          "node_worker_launch_cleanup.launch_id",
          "node_worker_launches.launch_id",
        )
        .select([
          "node_worker_launch_cleanup.cleanup_mode",
          "node_worker_launch_cleanup.lineage_settled",
        ]),
    )
    .$if(hasLaunchTable(database, schema, "node_worker_launch_process_scopes"), (selection) =>
      selection
        .leftJoin(
          "node_worker_launch_process_scopes",
          "node_worker_launch_process_scopes.launch_id",
          "node_worker_launches.launch_id",
        )
        .select([
          "node_worker_launch_process_scopes.scope_kind",
          "node_worker_launch_process_scopes.descendants_reaped",
        ]),
    );
}

function readRow(database: DatabaseSync, launchId: string, schema: LaunchSchema) {
  return executeSqliteQueryTakeFirstSync(
    database,
    selectLaunchRows(database, schema).where("node_worker_launches.launch_id", "=", launchId),
  );
}

function readNonterminalCount(database: DatabaseSync): number {
  return (
    executeSqliteQueryTakeFirstSync(
      database,
      query(database)
        .selectFrom("node_worker_launches")
        .select((expression) => expression.fn.countAll<number>().as("count"))
        .where("state", "in", ["pending", "running"]),
    )?.count ?? 0
  );
}

function readNonterminalRows(database: DatabaseSync, schema: LaunchSchema) {
  return executeSqliteQuerySync(
    database,
    selectLaunchRows(database, schema)
      .where("node_worker_launches.state", "in", ["pending", "running"])
      .orderBy("node_worker_launches.launch_id", "asc"),
  ).rows;
}

function pruneTerminalRows(params: {
  database: DatabaseSync;
  schema: LaunchSchema;
  cutoffMs: number;
  limit: number;
  excludeLaunchId?: string;
}): number {
  let candidates = query(params.database)
    .selectFrom("node_worker_launches")
    .select("launch_id")
    .where("state", "in", ["completed", "failed", "interrupted", "cancelled"])
    .where("completed_at_ms", "<=", params.cutoffMs)
    .orderBy("completed_at_ms", "asc")
    .orderBy("launch_id", "asc")
    .limit(params.limit);
  if (params.excludeLaunchId) {
    candidates = candidates.where("launch_id", "!=", params.excludeLaunchId);
  }
  const launchIds = executeSqliteQuerySync(params.database, candidates).rows.map(
    (row) => row.launch_id,
  );
  if (launchIds.length === 0) {
    return 0;
  }
  if (hasLaunchTable(params.database, params.schema, "node_worker_launch_containers")) {
    executeSqliteQuerySync(
      params.database,
      query(params.database)
        .deleteFrom("node_worker_launch_containers")
        .where("launch_id", "in", launchIds),
    );
  }
  const result = executeSqliteQuerySync(
    params.database,
    query(params.database)
      .deleteFrom("node_worker_launches")
      .where("launch_id", "in", launchIds)
      .where("state", "in", ["completed", "failed", "interrupted", "cancelled"])
      .where("completed_at_ms", "<=", params.cutoffMs),
  );
  return Number(result.numAffectedRows ?? 0n);
}

/** Read the authoritative physical owner within an already-open journal transaction. */
export function readNodeWorkerLaunchReceipt(
  database: DatabaseSync,
  launchId: string,
): NodeWorkerLaunchReceipt | undefined {
  const schema = getAdmittedSqliteSchemaFacts(database);
  if (!hasLaunchTable(database, schema, "node_worker_launches")) {
    return undefined;
  }
  const row = readRow(database, launchId, schema);
  return row ? nodeWorkerLaunchReceiptFromRow(row) : undefined;
}

/** Physical extinction closes unfinished turns, never a result already recorded by the worker. */
export function settleNodeWorkerActiveTurns(
  database: DatabaseSync,
  owner: NodeWorkerLaunchReceipt,
  schema?: LaunchSchema,
): void {
  if (
    owner.state === "pending" ||
    owner.state === "running" ||
    !hasLaunchTable(database, schema ?? getAdmittedSqliteSchemaFacts(database), "node_worker_turns")
  ) {
    return;
  }
  executeSqliteQuerySync(
    database,
    query(database)
      .updateTable("node_worker_turns")
      .set((expression) => {
        const completedAt = expression.fn<number>("max", [
          "created_at_ms",
          "updated_at_ms",
          expression.val(owner.updatedAtMs),
        ]);
        return {
          state: owner.state === "completed" ? "interrupted" : owner.state,
          result_json: null,
          error_text: owner.errorText ?? "node worker stopped before its turn completed",
          completed_at_ms: completedAt,
          updated_at_ms: completedAt,
        };
      })
      .where("owner_launch_id", "=", owner.launchId)
      .where("state", "=", "running"),
  );
}

function validateIdentifier(value: string, label: string): void {
  if (!value || value.trim() !== value || value.length > 256 || value.includes("\0")) {
    throw new Error(`${label} must be a bounded non-empty identifier`);
  }
}

function validateTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("node worker launch timestamp must be a non-negative safe integer");
  }
}

function validatePruneLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("node worker launch prune limit must be between 1 and 1000");
  }
}

function requireMatchingRow(
  database: DatabaseSync,
  identity: LaunchIdentity,
  schema: LaunchSchema,
): NodeWorkerLaunchRow {
  const { launchId, planHash } = identity;
  const row = readRow(database, launchId, schema);
  if (!row) {
    throw new Error(`node worker launch ${launchId} does not exist`);
  }
  if (row.plan_hash !== planHash) {
    throw new Error(`node worker launch ${launchId} was replayed with a different plan`);
  }
  return row;
}

function rowHasSupervisor(row: NodeWorkerLaunchRow, identity: NodeWorkerProcessIdentity): boolean {
  return row.supervisor_pid === identity.pid && row.supervisor_start_time === identity.startTime;
}

function rowHasWorker(
  row: NodeWorkerLaunchRow,
  identity: NodeWorkerProcessIdentity | null,
): boolean {
  return identity === null
    ? row.worker_pid === null && row.worker_start_time === null
    : row.worker_pid === identity.pid && row.worker_start_time === identity.startTime;
}

function sameObservedOwner(
  current: NodeWorkerLaunchRow,
  observed: NodeWorkerLaunchObservation,
): boolean {
  return (
    current.state === observed.state &&
    current.supervisor_pid === observed.supervisor_pid &&
    current.supervisor_start_time === observed.supervisor_start_time &&
    current.worker_pid === observed.worker_pid &&
    current.worker_start_time === observed.worker_start_time
  );
}

function rowMatchesImmutableIdentity(
  row: NodeWorkerLaunchRow,
  expected: NodeWorkerSupervisorIdentity,
): boolean {
  return (
    row.launch_id === expected.launchId &&
    row.plan_hash === expected.planHash &&
    row.environment_id === expected.environmentId &&
    row.session_id === expected.sessionId &&
    row.owner_epoch === expected.ownerEpoch &&
    row.placement_generation === expected.placementGeneration &&
    row.run_id === expected.runId
  );
}

function finishOwnedRow(
  database: DatabaseSync,
  current: NodeWorkerLaunchRow,
  params: Omit<Parameters<NodeWorkerLaunchKernel["finish"]>[0], "launchId" | "planHash" | "nowMs">,
  nowMs: number,
  expected?: NodeWorkerSupervisorIdentity,
): NodeWorkerLaunchRow | undefined {
  if (
    isNodeWorkerTerminalState(current.state) ||
    !rowHasSupervisor(current, params.supervisor) ||
    !rowHasWorker(current, params.worker)
  ) {
    return undefined;
  }
  const completedAtMs = Math.max(nowMs, current.created_at_ms, current.updated_at_ms);
  let update = query(database)
    .updateTable("node_worker_launches")
    .set({
      state: params.state,
      result_json: params.state === "completed" ? (params.resultJson ?? null) : null,
      error_text: params.state === "completed" ? null : (params.errorText ?? null),
      completed_at_ms: completedAtMs,
      updated_at_ms: completedAtMs,
    })
    .where("launch_id", "=", current.launch_id)
    .where("plan_hash", "=", current.plan_hash);
  if (expected) {
    update = update
      .where("environment_id", "=", expected.environmentId)
      .where("session_id", "=", expected.sessionId)
      .where("owner_epoch", "=", expected.ownerEpoch)
      .where("placement_generation", "=", expected.placementGeneration)
      .where("run_id", "=", expected.runId);
  }
  update = update
    .where("state", "in", ["pending", "running"])
    .where("supervisor_pid", "=", params.supervisor.pid)
    .where("supervisor_start_time", "=", params.supervisor.startTime);
  update = params.worker
    ? update
        .where("worker_pid", "=", params.worker.pid)
        .where("worker_start_time", "=", params.worker.startTime)
    : update.where("worker_pid", "is", null).where("worker_start_time", "is", null);
  const updated = executeSqliteQueryTakeFirstSync(
    database,
    update.returning(["state", "result_json", "error_text", "completed_at_ms", "updated_at_ms"]),
  );
  // Settlement changes only these launch fields; companion metadata shares this transaction.
  return updated ? { ...current, ...updated } : undefined;
}

/** Connection-bound launch journal; every operation retains its original write transaction. */
export class NodeWorkerLaunchKernel {
  constructor(
    private readonly databaseOptions: OpenClawStateDatabaseOptions & {
      database: NonNullable<OpenClawStateDatabaseOptions["database"]>;
    },
  ) {}

  private write<T>(
    operationLabel: string,
    operation: (database: DatabaseSync, schema: LaunchSchema, path: string) => T,
  ): T {
    let initializedDatabase: DatabaseSync | undefined;
    const result = runOpenClawStateWriteTransaction(
      ({ db, path }) => {
        requestSqliteWorkerOperationAdmission({
          stage: "transaction",
          facts: { kind: "node-worker-journal" },
        });
        if (!initializedDatabases.has(db)) {
          ensureNodeWorkerLaunchSchema(db, "node_worker_launches");
          initializedDatabase = db;
        }
        // Carry admitted facts only through this transaction, never across operations.
        // A first-use companion writer refreshes them after its local DDL.
        return operation(db, getAdmittedSqliteSchemaFacts(db), path);
      },
      this.databaseOptions,
      { operationLabel },
    );
    if (initializedDatabase) {
      initializedDatabases.add(initializedDatabase);
    }
    return result;
  }

  claimObservation(
    claim: NodeWorkerLaunchClaim,
    supervisor: NodeWorkerProcessIdentity,
    capacity: number,
    nowMs = Date.now(),
  ): NodeWorkerLaunchObservation | undefined {
    validateIdentifier(claim.launchId, "node worker launch id");
    validateNodeWorkerPlanHash(claim.planHash);
    validateTimestamp(nowMs);
    validateNodeWorkerProcessIdentity(supervisor);
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("node worker capacity must be a positive safe integer");
    }

    return this.write("node-worker-launch.claim-inspect", (database, schema) => {
      const observed = readRow(database, claim.launchId, schema);
      if (!observed) {
        return undefined;
      }
      return {
        plan_hash: observed.plan_hash,
        state: observed.state,
        supervisor_pid: observed.supervisor_pid,
        supervisor_start_time: observed.supervisor_start_time,
        worker_pid: observed.worker_pid,
        worker_start_time: observed.worker_start_time,
      };
    });
  }

  claim(
    claim: NodeWorkerLaunchClaim,
    supervisor: NodeWorkerProcessIdentity,
    capacity: number,
    nowMs: number,
    observed: NodeWorkerLaunchObservation | undefined,
    observedSupervisorState: NodeWorkerLaunchObservedSupervisorState | undefined,
  ): NodeWorkerLaunchClaimResult {
    return this.write("node-worker-launch.claim", (database, schema) => {
      const finalize = (result: NodeWorkerLaunchClaimResult): NodeWorkerLaunchClaimResult => {
        // Preserve the exact replay fence while this launch is being resolved;
        // unrelated receipts age out in the same transaction as admission.
        pruneTerminalRows({
          database,
          schema,
          cutoffMs: Math.max(0, nowMs - TERMINAL_RECEIPT_RETENTION_MS),
          limit: TERMINAL_PRUNE_BATCH_LIMIT,
          excludeLaunchId: claim.launchId,
        });
        return result;
      };
      let current = readRow(database, claim.launchId, schema);
      let action: "start" | "replay" | "recover" = "replay";
      if (!current) {
        // The pending row is the physical slot reservation. Count and insert stay
        // in one transaction so concurrent supervisors cannot over-admit.
        const nonterminalCount = readNonterminalCount(database);
        if (nonterminalCount >= capacity) {
          return finalize({ action: "at-capacity", nonterminalCount });
        }
        executeSqliteQuerySync(
          database,
          query(database).insertInto("node_worker_launches").values({
            launch_id: claim.launchId,
            plan_hash: claim.planHash,
            gateway_namespace: claim.gatewayNamespace,
            environment_id: claim.environmentId,
            session_id: claim.sessionId,
            owner_epoch: claim.ownerEpoch,
            placement_generation: claim.placementGeneration,
            run_id: claim.runId,
            state: "pending",
            supervisor_pid: supervisor.pid,
            supervisor_start_time: supervisor.startTime,
            worker_pid: null,
            worker_start_time: null,
            result_json: null,
            error_text: null,
            completed_at_ms: null,
            created_at_ms: nowMs,
            updated_at_ms: nowMs,
          }),
        );
        current = requireMatchingRow(database, claim, schema);
        action = "start";
      } else if (current.plan_hash !== claim.planHash) {
        throw new Error(`node worker launch ${claim.launchId} was replayed with a different plan`);
      } else if (
        observed &&
        sameObservedOwner(current, observed) &&
        (observedSupervisorState === "dead" || observedSupervisorState === "reused")
      ) {
        if (current.state === "pending") {
          const updatedAtMs = Math.max(nowMs, current.created_at_ms, current.updated_at_ms);
          executeSqliteQuerySync(
            database,
            query(database)
              .updateTable("node_worker_launches")
              .set({
                supervisor_pid: supervisor.pid,
                supervisor_start_time: supervisor.startTime,
                updated_at_ms: updatedAtMs,
              })
              .where("launch_id", "=", claim.launchId)
              .where("plan_hash", "=", claim.planHash)
              .where("state", "=", "pending")
              .where("supervisor_pid", "=", observed.supervisor_pid)
              .where("supervisor_start_time", "=", observed.supervisor_start_time)
              .where("worker_pid", "is", null)
              .where("worker_start_time", "is", null),
          );
          current = requireMatchingRow(database, claim, schema);
          action = rowHasSupervisor(current, supervisor) ? "start" : "replay";
        } else if (current.state === "running") {
          action = "recover";
        }
      }
      return finalize({
        action,
        receipt: nodeWorkerLaunchReceiptFromRow(current),
        nonterminalCount: readNonterminalCount(database),
      });
    });
  }

  listNonterminal(): NodeWorkerLaunchReceipt[] {
    return this.write("node-worker-launch.list-nonterminal", (database, schema) =>
      readNonterminalRows(database, schema).map(nodeWorkerLaunchReceiptFromRow),
    );
  }

  nonterminalCount(): number {
    return this.write("node-worker-launch.count-nonterminal", readNonterminalCount);
  }

  pruneExpiredTerminal(params: { nowMs?: number; limit?: number } = {}): number {
    const nowMs = params.nowMs ?? Date.now();
    const limit = params.limit ?? TERMINAL_PRUNE_BATCH_LIMIT;
    validateTimestamp(nowMs);
    validatePruneLimit(limit);
    return this.write("node-worker-launch.prune-terminal", (database, schema) =>
      pruneTerminalRows({
        database,
        schema,
        cutoffMs: Math.max(0, nowMs - TERMINAL_RECEIPT_RETENTION_MS),
        limit,
      }),
    );
  }

  get(launchId: string): NodeWorkerLaunchReceipt | undefined {
    validateIdentifier(launchId, "node worker launch id");
    return this.write("node-worker-launch.get", (database, schema) => {
      const row = readRow(database, launchId, schema);
      return row ? nodeWorkerLaunchReceiptFromRow(row) : undefined;
    });
  }

  getMatching(expected: NodeWorkerSupervisorIdentity): NodeWorkerLaunchReceipt | undefined {
    validateIdentifier(expected.launchId, "node worker launch id");
    validateNodeWorkerPlanHash(expected.planHash);
    return this.write("node-worker-launch.get-matching", (database, schema) => {
      const row = readRow(database, expected.launchId, schema);
      return row && rowMatchesImmutableIdentity(row, expected)
        ? nodeWorkerLaunchReceiptFromRow(row)
        : undefined;
    });
  }

  cleanupBinding(
    params: Pick<NodeWorkerCleanupBinding, "launchId" | "planHash" | "supervisor">,
  ): NodeWorkerCleanupBinding {
    return this.write("node-worker-launch.cleanup-binding", (database, schema, databasePath) => {
      const current = requireMatchingRow(database, params, schema);
      if (
        isNodeWorkerTerminalState(current.state) ||
        !rowHasSupervisor(current, params.supervisor)
      ) {
        throw new Error("node worker cleanup binding no longer owns its launch");
      }
      return {
        databasePath,
        externallySupervised: isGatewayExternallySupervised(this.databaseOptions.env),
        launchId: params.launchId,
        planHash: params.planHash,
        supervisor: { ...params.supervisor },
      };
    });
  }

  finishCancelled(params: {
    expected: NodeWorkerSupervisorIdentity;
    supervisor: NodeWorkerProcessIdentity;
    worker: NodeWorkerProcessIdentity | null;
    nowMs?: number;
  }): NodeWorkerLaunchReceipt | undefined {
    const nowMs = params.nowMs ?? Date.now();
    validateTimestamp(nowMs);
    validateNodeWorkerProcessIdentity(params.supervisor);
    if (params.worker) {
      validateNodeWorkerProcessIdentity(params.worker);
    }
    return this.write("node-worker-launch.finish-cancelled", (database, schema) => {
      const current = readRow(database, params.expected.launchId, schema);
      if (!current || !rowMatchesImmutableIdentity(current, params.expected)) {
        return undefined;
      }
      const updated = finishOwnedRow(
        database,
        current,
        {
          supervisor: params.supervisor,
          worker: params.worker,
          state: "cancelled",
          errorText: "node worker launch cancelled",
        },
        nowMs,
        params.expected,
      );
      const settled = updated ?? current;
      if (!rowMatchesImmutableIdentity(settled, params.expected)) {
        return undefined;
      }
      const receipt = nodeWorkerLaunchReceiptFromRow(settled);
      settleNodeWorkerActiveTurns(database, receipt, schema);
      return receipt;
    });
  }

  markRunning(params: {
    launchId: string;
    planHash: string;
    supervisor: NodeWorkerProcessIdentity;
    worker: NodeWorkerProcessIdentity;
    cleanupMode: NodeWorkerCleanupMode | null;
    container?: NodeWorkerContainerIdentity;
    nowMs?: number;
  }): NodeWorkerLaunchReceipt {
    const nowMs = params.nowMs ?? Date.now();
    validateTimestamp(nowMs);
    validateNodeWorkerProcessIdentity(params.supervisor);
    validateNodeWorkerProcessIdentity(params.worker);
    if (params.container) {
      validateNodeWorkerContainerIdentity(params.container);
    }
    return this.write("node-worker-launch.mark-running", (database, schema) => {
      const current = requireMatchingRow(database, params, schema);
      if (isNodeWorkerTerminalState(current.state) || current.state === "running") {
        return nodeWorkerLaunchReceiptFromRow(current);
      }
      if (!rowHasSupervisor(current, params.supervisor) || !rowHasWorker(current, null)) {
        return nodeWorkerLaunchReceiptFromRow(current);
      }
      if (params.container) {
        ensureNodeWorkerLaunchSchema(database, "node_worker_launch_containers");
        executeSqliteQuerySync(
          database,
          query(database)
            .insertInto("node_worker_launch_containers")
            .values({
              launch_id: params.launchId,
              container_json: JSON.stringify({
                engine: params.container.engine,
                containerId: params.container.containerId,
                engineTarget: params.container.engineTarget,
              }),
            }),
        );
      }
      if (params.cleanupMode !== null) {
        ensureNodeWorkerLaunchSchema(database, "node_worker_launch_cleanup");
        executeSqliteQuerySync(
          database,
          query(database)
            .insertInto("node_worker_launch_cleanup")
            .values({
              launch_id: params.launchId,
              cleanup_mode:
                params.cleanupMode === "linux-subreaper" ? "owned-anchor" : params.cleanupMode,
              lineage_settled: null,
            }),
        );
      }
      if (params.cleanupMode === "linux-subreaper") {
        ensureNodeWorkerLaunchSchema(database, "node_worker_launch_process_scopes");
        executeSqliteQuerySync(
          database,
          query(database).insertInto("node_worker_launch_process_scopes").values({
            launch_id: params.launchId,
            scope_kind: "linux-subreaper",
            descendants_reaped: null,
          }),
        );
      }
      const updatedAtMs = Math.max(nowMs, current.created_at_ms, current.updated_at_ms);
      executeSqliteQuerySync(
        database,
        query(database)
          .updateTable("node_worker_launches")
          .set({
            state: "running",
            worker_pid: params.worker.pid,
            worker_start_time: params.worker.startTime,
            updated_at_ms: updatedAtMs,
          })
          .where("launch_id", "=", params.launchId)
          .where("plan_hash", "=", params.planHash)
          .where("state", "=", "pending")
          .where("supervisor_pid", "=", params.supervisor.pid)
          .where("supervisor_start_time", "=", params.supervisor.startTime)
          .where("worker_pid", "is", null)
          .where("worker_start_time", "is", null),
      );
      return nodeWorkerLaunchReceiptFromRow(
        requireMatchingRow(database, params, getAdmittedSqliteSchemaFacts(database)),
      );
    });
  }

  finish(params: {
    launchId: string;
    planHash: string;
    supervisor: NodeWorkerProcessIdentity;
    worker: NodeWorkerProcessIdentity | null;
    state: NodeWorkerTerminalState;
    resultJson?: string;
    errorText?: string;
    nowMs?: number;
  }): NodeWorkerLaunchReceipt {
    const nowMs = params.nowMs ?? Date.now();
    validateTimestamp(nowMs);
    validateNodeWorkerProcessIdentity(params.supervisor);
    if (params.worker) {
      validateNodeWorkerProcessIdentity(params.worker);
    }
    return this.write("node-worker-launch.finish", (database, schema) => {
      const current = requireMatchingRow(database, params, schema);
      const updated = finishOwnedRow(database, current, params, nowMs);
      const receipt = nodeWorkerLaunchReceiptFromRow(updated ?? current);
      settleNodeWorkerActiveTurns(database, receipt, schema);
      return receipt;
    });
  }
}
