import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type {
  DB as StateDatabase,
  WorkerSessionPlacements,
} from "../../state/openclaw-state-db.generated.js";
import {
  assertRecordShape,
  nextGeneration,
  normalizeEpoch,
  normalizeNonNegativeInteger,
  normalizeWorkerPlacementExecutionMode,
  nullableRequired,
  required,
  type PersistedTurnClaim,
  type WorkerSessionPlacementChangeSnapshot,
  type WorkerSessionPlacementIdentity,
  type WorkerSessionPlacementRecord,
  type WorkerSessionPlacementTransitionPatch,
} from "./placement-record.js";
import {
  parseWorkerSessionPlacementState,
  type WorkerSessionPlacementState,
} from "./placement-state.js";
import { publishPlacementTurnClaimState } from "./placement-turn-authority.js";
import { publishWorkerEnvironmentNativeMutation } from "./store-native-publication.js";

type PlacementRow = Selectable<WorkerSessionPlacements>;
type PlacementDatabase = Pick<
  StateDatabase,
  | "worker_environments"
  | "worker_session_placements"
  | "worker_session_tool_operations"
  | "worker_turn_tool_authorities"
>;

export const query = (db: DatabaseSync) => getNodeSqliteKysely<PlacementDatabase>(db);

function parseTurnClaim(row: PlacementRow): PersistedTurnClaim | null {
  if (row.turn_claim_owner === null) {
    return null;
  }
  const claimId = required(row.turn_claim_id ?? "", "turn claim id");
  const runId = required(row.turn_claim_run_id ?? "", "turn claim run id");
  const generation = row.turn_claim_generation;
  if (generation === null || !Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Worker session placement turn claim generation is invalid");
  }
  if (row.turn_claim_owner === "local") {
    if (row.turn_claim_owner_epoch !== null) {
      throw new Error("Local turn claim cannot retain a worker owner epoch");
    }
    return { owner: "local", claimId, runId, generation, ownerEpoch: null };
  }
  if (row.turn_claim_owner === "worker") {
    return {
      owner: "worker",
      claimId,
      runId,
      generation,
      ownerEpoch: normalizeEpoch(row.turn_claim_owner_epoch ?? 0, "turn claim owner epoch"),
    };
  }
  throw new Error(`Invalid worker session turn claim owner: ${row.turn_claim_owner}`);
}

export function fromRow(row: PlacementRow): WorkerSessionPlacementRecord {
  const state = parseWorkerSessionPlacementState(row.state);
  const executionMode = normalizeWorkerPlacementExecutionMode(row.execution_mode);
  const parsed = {
    environmentId: nullableRequired(row.environment_id, "environment id"),
    activeOwnerEpoch:
      row.active_owner_epoch === null
        ? null
        : normalizeEpoch(row.active_owner_epoch, "active owner epoch"),
    workspaceBaseManifestRef: nullableRequired(
      row.workspace_base_manifest_ref,
      "workspace base manifest ref",
    ),
    remoteWorkspaceDir: nullableRequired(row.remote_workspace_dir, "remote workspace directory"),
    workerBundleHash: nullableRequired(row.worker_bundle_hash, "worker bundle hash"),
    lastTranscriptAckCursor: normalizeNonNegativeInteger(
      row.last_transcript_ack_cursor,
      "transcript ACK cursor",
    ),
    lastLiveEventAckCursor: normalizeNonNegativeInteger(
      row.last_live_event_ack_cursor,
      "live ACK cursor",
    ),
    terminalReason: nullableRequired(row.terminal_reason, "terminal reason"),
    terminalAtMs: normalizeNonNegativeInteger(row.terminal_at_ms, "terminal timestamp"),
  };
  const recoveryError = nullableRequired(row.recovery_error, "recovery error");
  const turnClaim = parseTurnClaim(row);
  const record = {
    sessionId: row.session_id,
    agentId: row.agent_id,
    sessionKey: row.session_key,
    executionMode,
    generation: row.transition_generation,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    stateChangedAtMs: row.state_changed_at_ms,
    state,
    turnClaim,
    ...parsed,
    recoveryError,
  };
  assertRecordShape(record);
  return record;
}

export function find(
  db: DatabaseSync,
  sessionId: string,
): WorkerSessionPlacementRecord | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_session_placements")
      .selectAll()
      .where("session_id", "=", sessionId),
  );
  return row ? fromRow(row) : undefined;
}

export function readWorkerPlacementsForReconcileInDatabase(
  db: DatabaseSync,
  sessionKey?: string,
): WorkerSessionPlacementRecord[] {
  let select = query(db)
    .selectFrom("worker_session_placements")
    .selectAll()
    .where("state", "not in", ["local", "reclaimed"]);
  if (sessionKey !== undefined) {
    select = select.where("session_key", "=", sessionKey);
  }
  return executeSqliteQuerySync(db, select.orderBy("updated_at_ms").orderBy("session_id")).rows.map(
    fromRow,
  );
}

export function readWorkerPlacementChangeSnapshotInDatabase(
  db: DatabaseSync,
  profileIds?: readonly string[],
): WorkerSessionPlacementChangeSnapshot[] {
  if (profileIds?.length === 0) {
    return [];
  }
  let select = query(db)
    .selectFrom("worker_session_placements")
    .selectAll("worker_session_placements");
  if (profileIds) {
    select = select
      .innerJoin(
        "worker_environments",
        "worker_environments.environment_id",
        "worker_session_placements.environment_id",
      )
      .where("worker_environments.profile_id", "in", profileIds)
      // Match the instance correlation used by readWorkerPlacementIdentity, including
      // terminal provenance and pre-epoch dispatch states.
      .where((eb) =>
        eb.or([
          eb(
            "worker_session_placements.active_owner_epoch",
            "=",
            eb.ref("worker_environments.owner_epoch"),
          ),
          eb.and([
            eb("worker_session_placements.active_owner_epoch", "is", null),
            eb("worker_session_placements.state", "in", ["provisioning", "syncing", "starting"]),
          ]),
        ]),
      );
  }
  return executeSqliteQuerySync(
    db,
    select.orderBy("worker_session_placements.session_id"),
  ).rows.map((row) => {
    const { sessionId, state, generation, updatedAtMs, sessionKey, agentId } = fromRow(row);
    return {
      sessionId,
      state,
      generation,
      updatedAtMs,
      sessionKey,
      agentId,
    };
  });
}

export function getRequired(db: DatabaseSync, sessionId: string): WorkerSessionPlacementRecord {
  const record = find(db, sessionId);
  if (!record) {
    throw new Error(`Unknown worker session placement: ${sessionId}`);
  }
  return record;
}

export function ensureLocal(
  db: DatabaseSync,
  identity: WorkerSessionPlacementIdentity,
  nowMs: number,
): WorkerSessionPlacementRecord {
  const current = find(db, identity.sessionId);
  if (current) {
    if (current.agentId !== identity.agentId || current.sessionKey !== identity.sessionKey) {
      throw new Error(`Worker session placement identity changed for ${identity.sessionId}`);
    }
    return current;
  }
  executeSqliteQuerySync(
    db,
    query(db).insertInto("worker_session_placements").values({
      session_id: identity.sessionId,
      agent_id: identity.agentId,
      session_key: identity.sessionKey,
      execution_mode: null,
      state: "local",
      environment_id: null,
      transition_generation: 0,
      active_owner_epoch: null,
      workspace_base_manifest_ref: null,
      remote_workspace_dir: null,
      worker_bundle_hash: null,
      last_transcript_ack_cursor: null,
      last_live_event_ack_cursor: null,
      recovery_error: null,
      terminal_reason: null,
      terminal_at_ms: null,
      turn_claim_owner: null,
      turn_claim_id: null,
      turn_claim_run_id: null,
      turn_claim_generation: null,
      turn_claim_owner_epoch: null,
      created_at_ms: nowMs,
      updated_at_ms: nowMs,
      state_changed_at_ms: nowMs,
    }),
  );
  const record = getRequired(db, identity.sessionId);
  publishPlacementTurnClaimState(db, record);
  return record;
}

export function transitionValues(
  current: WorkerSessionPlacementRecord,
  to: WorkerSessionPlacementRecord["state"],
  patch: WorkerSessionPlacementTransitionPatch,
  nowMs: number,
): PlacementRow {
  const clearsWorkerMetadata = to === "local" || to === "requested";
  const text = (value: string | null | undefined, previous: string | null, field: string) =>
    clearsWorkerMetadata ? null : value === undefined ? previous : nullableRequired(value, field);
  const cursor = (value: number | null | undefined, previous: number | null, field: string) =>
    clearsWorkerMetadata
      ? null
      : value === undefined
        ? previous
        : normalizeNonNegativeInteger(value, field);
  const environmentId = text(patch.environmentId, current.environmentId, "environment id");
  const activeOwnerEpoch =
    clearsWorkerMetadata || to === "provisioning" || to === "syncing" || to === "starting"
      ? null
      : patch.activeOwnerEpoch === undefined
        ? current.activeOwnerEpoch
        : patch.activeOwnerEpoch === null
          ? null
          : normalizeEpoch(patch.activeOwnerEpoch, "active owner epoch");
  const generation = nextGeneration(current.generation);
  const values: PlacementRow = {
    session_id: current.sessionId,
    agent_id: current.agentId,
    session_key: current.sessionKey,
    execution_mode: current.executionMode,
    state: to,
    environment_id: environmentId,
    transition_generation: generation,
    active_owner_epoch: activeOwnerEpoch,
    workspace_base_manifest_ref: text(
      patch.workspaceBaseManifestRef,
      current.workspaceBaseManifestRef,
      "workspace base manifest ref",
    ),
    remote_workspace_dir: text(
      patch.remoteWorkspaceDir,
      current.remoteWorkspaceDir,
      "remote workspace directory",
    ),
    worker_bundle_hash: text(
      patch.workerBundleHash,
      current.workerBundleHash,
      "worker bundle hash",
    ),
    last_transcript_ack_cursor: cursor(
      patch.lastTranscriptAckCursor,
      current.lastTranscriptAckCursor,
      "transcript ACK cursor",
    ),
    last_live_event_ack_cursor: cursor(
      patch.lastLiveEventAckCursor,
      current.lastLiveEventAckCursor,
      "live ACK cursor",
    ),
    recovery_error: text(patch.recoveryError, current.recoveryError, "recovery error"),
    terminal_reason:
      to === "failed"
        ? patch.terminalReason === undefined
          ? current.terminalReason
          : nullableRequired(patch.terminalReason, "terminal reason")
        : null,
    terminal_at_ms: to === "reclaimed" || to === "failed" ? (current.terminalAtMs ?? nowMs) : null,
    turn_claim_owner: null,
    turn_claim_id: null,
    turn_claim_run_id: null,
    turn_claim_generation: null,
    turn_claim_owner_epoch: null,
    created_at_ms: current.createdAtMs,
    updated_at_ms: nowMs,
    state_changed_at_ms: nowMs,
  };
  assertRecordShape({
    state: to,
    executionMode: current.executionMode,
    environmentId,
    activeOwnerEpoch,
    workspaceBaseManifestRef: values.workspace_base_manifest_ref,
    remoteWorkspaceDir: values.remote_workspace_dir,
    workerBundleHash: values.worker_bundle_hash,
    lastTranscriptAckCursor: values.last_transcript_ack_cursor,
    lastLiveEventAckCursor: values.last_live_event_ack_cursor,
    recoveryError: values.recovery_error,
    terminalReason: values.terminal_reason,
    terminalAtMs: values.terminal_at_ms,
    turnClaim: null,
  });
  return values;
}

export function updateTransition(
  db: DatabaseSync,
  current: WorkerSessionPlacementRecord,
  to: WorkerSessionPlacementState,
  patch: WorkerSessionPlacementTransitionPatch,
  nowMs: number,
  onEnvironmentActivated?: (environmentId: string, lastActivatedAtMs: number) => void,
): WorkerSessionPlacementRecord {
  const values = transitionValues(current, to, patch, nowMs);
  const result = executeSqliteQuerySync(
    db,
    query(db)
      .updateTable("worker_session_placements")
      .set(values)
      .where("session_id", "=", current.sessionId)
      .where("state", "=", current.state)
      .where("transition_generation", "=", current.generation)
      .where("turn_claim_owner", "is", null),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error(`Worker session placement ${current.sessionId} changed during transition`);
  }
  const updated = getRequired(db, current.sessionId);
  if (updated.state === "active") {
    // Activation and demand are one commit. Teardown may run before refill observes
    // the placement, so cleanup timestamps cannot stand in for successful demand.
    const activated = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<Pick<StateDatabase, "worker_environments">>(db)
        .updateTable("worker_environments")
        .set((eb) => ({
          last_activated_at_ms: eb
            .case()
            .when("last_activated_at_ms", ">", nowMs)
            .then(eb.ref("last_activated_at_ms"))
            .else(nowMs)
            .end(),
        }))
        .where("environment_id", "=", updated.environmentId)
        .where("state", "=", "attached")
        .where("destroy_requested_at_ms", "is", null)
        .where("owner_epoch", "=", updated.activeOwnerEpoch)
        .where("attached_session_ids_json", "=", JSON.stringify([updated.sessionId]))
        .returning("last_activated_at_ms"),
    );
    const lastActivatedAtMs = activated.rows[0]?.last_activated_at_ms;
    if (activated.rows.length !== 1 || lastActivatedAtMs == null) {
      throw new Error(
        `Worker session placement ${current.sessionId} lost its attached environment`,
      );
    }
    publishWorkerEnvironmentNativeMutation(db, updated.environmentId!, {
      lastActivatedAtMs,
    });
    onEnvironmentActivated?.(updated.environmentId!, lastActivatedAtMs);
  }
  publishPlacementTurnClaimState(db, updated);
  return updated;
}
