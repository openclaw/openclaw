import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { jsonArrayFrom } from "kysely/helpers/sqlite";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { parseSqliteTableDefinition } from "../../infra/sqlite-schema-contract-assembly.js";
import {
  getAdmittedSqliteSchemaFacts,
  type SqliteSchemaFacts,
} from "../../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import { workerInferenceMetadata } from "./inference-placement.js";
import {
  workerPlacementMoveFromRow,
  type WorkerPlacementMoveIntent,
} from "./placement-move-intent.js";
import type {
  WorkerEnvironmentPlacementFacts,
  WorkerPlacementConflictBinding,
  WorkerPlacementRecoveryCandidate,
  WorkerSessionPlacementProjection,
  WorkerSessionPlacementReadResult,
} from "./placement-read-projection.types.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import { fromRow } from "./placement-row-codec.js";
import { parseWorkerSessionPlacementState } from "./placement-state.js";
import { isCurrentJournalOwner } from "./placement-workspace-journal.js";
import {
  isWorkerWorkspaceResultReconciling,
  matchesWorkspaceResultClaim,
} from "./placement-workspace-result-owner.js";
import { pendingResultFromRow } from "./placement-workspace-result.js";
import type { WorkerWorkspacePendingResult } from "./placement-workspace-result.types.js";
import { decodeWorkerEnvironmentRow } from "./store-row-codec.js";

export function readWorkerPlacementEnvironmentOwnerInDatabase(
  db: DatabaseSync,
  environmentId: string,
): WorkerSessionPlacementRecord | undefined {
  const rows = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<StateDatabase>(db)
      .selectFrom("worker_session_placements")
      .selectAll()
      .where("environment_id", "=", environmentId)
      .limit(2),
  ).rows;
  if (rows.length > 1) {
    throw new Error(`Worker environment ${environmentId} has multiple placement owners`);
  }
  return rows[0] ? fromRow(rows[0]) : undefined;
}

type ProjectionSchema = {
  repositoryWorkspace: boolean;
  moves?: { machineClass: boolean; os: boolean; abandonSource: boolean };
};

const projectionSchemas = new WeakMap<SqliteSchemaFacts, ProjectionSchema>();

function readProjectionSchema(db: DatabaseSync): ProjectionSchema {
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (!schema) {
    throw new Error("Worker placement projection requires admitted schema facts");
  }
  let projectionSchema = projectionSchemas.get(schema);
  if (!projectionSchema) {
    const pendingColumns = parseSqliteTableDefinition(
      schema.tableSql.get("worker_workspace_pending_results") ?? null,
      "worker_workspace_pending_results",
    ).columns;
    const moveSql = schema.tableSql.get("worker_session_placement_moves");
    const moveColumns = moveSql
      ? parseSqliteTableDefinition(moveSql, "worker_session_placement_moves").columns
      : undefined;
    projectionSchema = {
      repositoryWorkspace: pendingColumns.has("repository_workspace_id"),
      ...(moveColumns
        ? {
            moves: {
              machineClass: moveColumns.has("target_machine_class"),
              os: moveColumns.has("target_os"),
              abandonSource: moveColumns.has("abandon_source"),
            },
          }
        : {}),
    };
    projectionSchemas.set(schema, projectionSchema);
  }
  return projectionSchema;
}

function readProjectionRows(
  db: DatabaseSync,
  sessionIds: readonly string[],
  schema: ProjectionSchema,
) {
  const query = getNodeSqliteKysely<StateDatabase>(db);
  const ids = sqliteStringSet(sessionIds);
  const placements = query
    .selectFrom("worker_session_placements")
    .select([
      "session_id",
      "agent_id",
      "session_key",
      "execution_mode",
      "state",
      "environment_id",
      "transition_generation",
      "active_owner_epoch",
      "workspace_base_manifest_ref",
      "remote_workspace_dir",
      "worker_bundle_hash",
      "last_transcript_ack_cursor",
      "last_live_event_ack_cursor",
      "recovery_error",
      "terminal_reason",
      "terminal_at_ms",
      "turn_claim_owner",
      "turn_claim_id",
      "turn_claim_run_id",
      "turn_claim_generation",
      "turn_claim_owner_epoch",
      "created_at_ms",
      "updated_at_ms",
      "state_changed_at_ms",
    ])
    .where("session_id", "in", ids)
    .$assertType<Selectable<StateDatabase["worker_session_placements"]>>();
  const pendingResults = query
    .selectFrom("worker_workspace_pending_results")
    .select([
      "session_id",
      "environment_id",
      "owner_epoch",
      "placement_generation",
      "claim_id",
      "run_id",
      "gateway_instance_id",
      "recovery_requested_at_ms",
      "workspace_accepted_at_ms",
      "staged_result_ref",
      "created_at_ms",
    ])
    .select((eb) =>
      (schema.repositoryWorkspace ? eb.ref("repository_workspace_id") : eb.val(null)).as(
        "repository_workspace_id",
      ),
    )
    .where("session_id", "in", ids)
    .$assertType<StateDatabase["worker_workspace_pending_results"]>();
  const journals = query
    .selectFrom("worker_workspace_reconciliations")
    .select(["session_id", "environment_id", "owner_epoch", "placement_generation"])
    .where("session_id", "in", ids);
  const moves = query
    .selectFrom("worker_session_placement_moves")
    .select([
      "operation_id",
      "session_id",
      "source_generation",
      "source_environment_id",
      "source_owner_epoch",
      "target_kind",
      "target_id",
      "last_error",
      "created_at_ms",
      "updated_at_ms",
    ])
    .select((eb) => [
      (schema.moves?.machineClass ? eb.ref("target_machine_class") : eb.val(null)).as(
        "target_machine_class",
      ),
      (schema.moves?.os ? eb.ref("target_os") : eb.val(null)).as("target_os"),
      (schema.moves?.abandonSource ? eb.ref("abandon_source") : eb.val(null)).as("abandon_source"),
    ])
    .where("session_id", "in", ids)
    .$assertType<Selectable<StateDatabase["worker_session_placement_moves"]>>();
  const environments = query
    .selectFrom("worker_environments")
    .select([
      "environment_id",
      "provider_id",
      "profile_id",
      "profile_snapshot_json",
      "preparation_consumed_at_ms",
      "preparation_demand_at_ms",
      "preparation_expires_at_ms",
      "preparation_key",
      "preparation_purpose",
      "provision_operation_id",
      "node_setup_id",
      "node_device_id",
      "shared_host",
      "lease_id",
      "ssh_host",
      "ssh_port",
      "ssh_user",
      "ssh_host_key",
      "ssh_key_ref_json",
      "desktop_json",
      "bootstrap_bundle_hash",
      "bootstrap_openclaw_version",
      "bootstrap_protocol_features_json",
      "bootstrap_install_kind",
      "owner_epoch",
      "teardown_terminal_state",
      "state",
      "attached_session_ids_json",
      "created_at_ms",
      "updated_at_ms",
      "state_changed_at_ms",
      "last_activated_at_ms",
      "idle_since_at_ms",
      "destroy_requested_at_ms",
      "last_error",
    ])
    .where(
      "environment_id",
      "in",
      query
        .selectFrom("worker_session_placements")
        .select("environment_id")
        .where("session_id", "in", ids)
        .where("environment_id", "is not", null),
    )
    .$assertType<Selectable<StateDatabase["worker_environments"]>>();
  // Each recovery table contributes independently, including local and terminal placements.
  // The native sync executor returns JSON text without Kysely's result plugins.
  return executeSqliteQuerySync(
    db,
    query.selectNoFrom((eb) => [
      jsonArrayFrom(placements).$castTo<string>().as("placements"),
      jsonArrayFrom(pendingResults).$castTo<string>().as("pendingResults"),
      jsonArrayFrom(journals).$castTo<string>().as("journals"),
      schema.moves ? jsonArrayFrom(moves).$castTo<string>().as("moves") : eb.val("[]").as("moves"),
      jsonArrayFrom(environments).$castTo<string>().as("environments"),
    ]),
  ).rows[0]!;
}

function reviveProjectionInteger(column: string, value: unknown): unknown {
  // These STRICT tables project INTEGER numbers; preserve native reads' refusal to round them.
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new RangeError(
      `Worker placement projection column ${column} is outside JavaScript's safe integer range`,
    );
  }
  return value;
}

export function readWorkerSessionPlacementProjectionInDatabase(
  db: DatabaseSync,
  sessionIds: readonly string[],
  conflictBindings: readonly WorkerPlacementConflictBinding[],
): WorkerSessionPlacementReadResult {
  return runSqliteDeferredTransactionSync(db, () => {
    const schema = readProjectionSchema(db);
    const placements = new Map<string, WorkerSessionPlacementRecord>();
    const moves = new Map<string, WorkerPlacementMoveIntent>();
    const pendingResults = new Map<string, WorkerWorkspacePendingResult>();
    const reconcilingSessionIds = new Set<string>();
    const workspaceRecoveryPendingSessionIds = new Set<string>();
    const workspaceJournalOwnerSessionIds = new Set<string>();
    const environments = new Map<string, WorkerEnvironmentPlacementFacts>();
    for (let offset = 0; offset < sessionIds.length; offset += 250) {
      const rows = readProjectionRows(db, sessionIds.slice(offset, offset + 250), schema);
      // SAFETY: jsonArrayFrom serializes the $assertType-checked placement selection; fromRow validates its domain shape.
      for (const row of JSON.parse(rows.placements, reviveProjectionInteger) as Selectable<
        StateDatabase["worker_session_placements"]
      >[]) {
        const placement = fromRow(row);
        placements.set(placement.sessionId, placement);
      }
      // SAFETY: jsonArrayFrom serializes the typed pending-result selection, including its nullable additive column.
      for (const row of JSON.parse(rows.pendingResults, reviveProjectionInteger) as Array<
        StateDatabase["worker_workspace_pending_results"]
      >) {
        const pending = pendingResultFromRow(row);
        pendingResults.set(pending.sessionId, pending);
        workspaceRecoveryPendingSessionIds.add(pending.sessionId);
        if (isWorkerWorkspaceResultReconciling(placements.get(pending.sessionId), pending)) {
          reconcilingSessionIds.add(pending.sessionId);
        }
      }
      // SAFETY: jsonArrayFrom emits only the four explicitly selected journal owner columns.
      for (const row of JSON.parse(rows.journals, reviveProjectionInteger) as Pick<
        StateDatabase["worker_workspace_reconciliations"],
        "session_id" | "environment_id" | "owner_epoch" | "placement_generation"
      >[]) {
        workspaceRecoveryPendingSessionIds.add(row.session_id);
        if (
          isCurrentJournalOwner(
            db,
            placements.get(row.session_id),
            {
              sessionId: row.session_id,
              environmentId: row.environment_id,
              ownerEpoch: row.owner_epoch,
              placementGeneration: row.placement_generation,
            },
            pendingResults,
          )
        ) {
          workspaceJournalOwnerSessionIds.add(row.session_id);
        }
      }
      // SAFETY: jsonArrayFrom serializes the $assertType-checked move selection (or []); workerPlacementMoveFromRow validates it.
      for (const row of JSON.parse(rows.moves, reviveProjectionInteger) as Selectable<
        StateDatabase["worker_session_placement_moves"]
      >[]) {
        const move = workerPlacementMoveFromRow(row);
        moves.set(move.sessionId, move);
      }
      // SAFETY: jsonArrayFrom serializes the $assertType-checked environment selection; decodeWorkerEnvironmentRow validates it.
      for (const row of JSON.parse(rows.environments, reviveProjectionInteger) as Selectable<
        StateDatabase["worker_environments"]
      >[]) {
        const record = decodeWorkerEnvironmentRow(row, []);
        environments.set(record.environmentId, {
          environmentId: record.environmentId,
          providerId: record.providerId,
          profileId: record.profileId,
          profileSnapshot: record.profileSnapshot,
          ...workerInferenceMetadata(record),
          state: record.state,
          leaseId: record.leaseId,
          ownerEpoch: record.ownerEpoch,
          nodeDeviceId: record.nodeDeviceId,
          attachedSessionIds: record.attachedSessionIds,
        });
      }
    }
    const projection: WorkerSessionPlacementProjection = {
      placements,
      moves,
      pendingResults,
      workspaceJournalOwnerSessionIds,
      workspaceResultReconcilingSessionIds: reconcilingSessionIds,
      workspaceRecoveryPendingSessionIds,
      environments,
    };
    const conflictSessionIds = new Set<string>();
    for (const binding of conflictBindings) {
      const record = placements.get(binding.placement.sessionId);
      const pending = pendingResults.get(binding.placement.sessionId);
      // Host-only conflict payloads belong to the captured placement or its retained result claim.
      if (
        record &&
        record.environmentId === binding.placement.environmentId &&
        record.activeOwnerEpoch === binding.placement.activeOwnerEpoch &&
        (record.generation === binding.placement.generation ||
          (pending && matchesWorkspaceResultClaim(record, pending, binding.claim)))
      ) {
        conflictSessionIds.add(record.sessionId);
      }
    }
    return { projection, conflictSessionIds };
  });
}

export function readWorkerPlacementRecoveryCandidatesInDatabase(
  db: DatabaseSync,
): WorkerPlacementRecoveryCandidate[] {
  return runSqliteDeferredTransactionSync(db, () => {
    const query = getNodeSqliteKysely<StateDatabase>(db);
    const placements = new Map(
      executeSqliteQuerySync(
        db,
        query
          .selectFrom("worker_session_placements")
          .select(["session_id", "environment_id", "state"])
          .orderBy("updated_at_ms")
          .orderBy("session_id"),
      ).rows.map((row) => [
        row.session_id,
        {
          sessionId: row.session_id,
          environmentId: row.environment_id,
          state: parseWorkerSessionPlacementState(row.state),
        },
      ]),
    );
    const candidates = new Map<string, WorkerPlacementRecoveryCandidate>(
      [...placements].filter(
        ([, placement]) => placement.state !== "local" && placement.state !== "reclaimed",
      ),
    );
    const add = (sessionId: string): WorkerPlacementRecoveryCandidate => {
      const candidate = candidates.get(sessionId) ??
        placements.get(sessionId) ?? { sessionId, environmentId: null };
      candidates.set(sessionId, candidate);
      return candidate;
    };
    if (tableExists(db, "worker_session_placement_moves")) {
      for (const row of executeSqliteQuerySync(
        db,
        query
          .selectFrom("worker_session_placement_moves")
          .select(["session_id", "source_environment_id"])
          .orderBy("created_at_ms")
          .orderBy("session_id"),
      ).rows) {
        add(row.session_id).moveSourceEnvironmentId = row.source_environment_id;
      }
    }
    for (const table of [
      "worker_workspace_pending_results",
      "worker_workspace_reconciliations",
    ] as const) {
      for (const row of executeSqliteQuerySync(
        db,
        query.selectFrom(table).select("session_id").orderBy("session_id"),
      ).rows) {
        add(row.session_id);
      }
    }
    return [...candidates.values()];
  });
}
