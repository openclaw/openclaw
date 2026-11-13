import { isDeepStrictEqual } from "node:util";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { sameWorkerResourceReceipt } from "../../plugins/worker-resource-receipt.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { assertRepositoryWorkspaceDiskIdentity } from "../../state/session-repository-workspaces.authority.js";
import { restoreSessionRepositoryWorkspaceDiskInDatabase } from "../../state/session-repository-workspaces.kernel.js";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import type { WorkerEnvironmentRecord } from "./environment-record.js";
import {
  isForceAbandonedWorkerPlacement,
  nextGeneration,
  type WorkerSessionPlacementRecord,
} from "./placement-record.js";
import { find as findPlacement, turnClaimValues } from "./placement-row-codec.js";
import { hasWorkerEnvironmentSessionAttachment } from "./session-attachment-store.js";
import { revokeCredential, updateRow } from "./store-mutations.js";
import { findWorkerEnvironment, json, listRows } from "./store-row-codec.js";
import { createWorkerEnvironmentStoreKernel } from "./store.kernel.js";

/** Parsed current-schema facts from one sealed source; never credentials or pairing records. */
export type RetainedWorkerOwnerRecoverySource = {
  environment: WorkerEnvironmentRecord;
  placement: Extract<WorkerSessionPlacementRecord, { state: "active" }>;
  workspace: SessionRepositoryWorkspaceRecord;
  /** Read for this session from the same sealed source, not from the destination. */
  hasPendingWorkspaceResult: boolean;
  hasPlacementMove: boolean;
  hasRunningToolOperation: boolean;
};

export type RetainedWorkerOwnerRecoveryInput = {
  source: RetainedWorkerOwnerRecoverySource;
  expected: {
    environment: WorkerEnvironmentRecord | null;
    placement: WorkerSessionPlacementRecord | null;
    workspace: SessionRepositoryWorkspaceRecord | null;
  };
  assertCurrent: () => void;
};

function assertNoUnsettledWork(
  db: EngineConnection,
  placement: RetainedWorkerOwnerRecoverySource["placement"],
) {
  const query = getNodeSqliteKysely<DB>(db);
  const pending = executeSqliteQueryTakeFirstSync(
    db,
    query
      .selectFrom("worker_workspace_pending_results")
      .select("session_id")
      .where("session_id", "=", placement.sessionId),
  );
  const move = executeSqliteQueryTakeFirstSync(
    db,
    query
      .selectFrom("worker_session_placement_moves")
      .select("session_id")
      .where("session_id", "=", placement.sessionId),
  );
  const operation = executeSqliteQueryTakeFirstSync(
    db,
    query
      .selectFrom("worker_session_tool_operations")
      .select("source_session_id")
      .where("source_session_id", "=", placement.sessionId)
      .where("status", "=", "running"),
  );
  const otherPlacement = executeSqliteQueryTakeFirstSync(
    db,
    query
      .selectFrom("worker_session_placements")
      .select("session_id")
      .where("session_id", "!=", placement.sessionId)
      .where((eb) =>
        eb.or([
          eb("environment_id", "=", placement.environmentId),
          eb.and([
            eb("agent_id", "=", placement.agentId),
            eb("session_key", "=", placement.sessionKey),
          ]),
        ]),
      ),
  );
  if (
    pending ||
    move ||
    operation ||
    otherPlacement ||
    hasWorkerEnvironmentSessionAttachment(db, placement.environmentId)
  ) {
    throw new Error("Retained owner recovery conflicts with unsettled work or another placement");
  }
}

/**
 * Offline repair only: caller owns exclusive custody, the existing shared-state transaction,
 * source sealing and session identity admission. Recheck assertCurrent before committing.
 * Node/build IDs are historical identity facts, not restored device authorization. Only the
 * ordinary retained wake path can admit a currently paired node and a new worker credential.
 */
export function restoreRetainedWorkerOwnerInDatabase(
  database: OpenClawStateDatabase,
  input: RetainedWorkerOwnerRecoveryInput,
  nowMs: number,
): {
  environmentId: string;
  ownerEpoch: number;
  placementGeneration: number;
  workspaceId: string;
  workspaceRevision: number;
} {
  const db = database.db;
  if (!db.isTransaction) {
    throw new Error("Retained owner recovery requires its offline shared-state transaction");
  }
  input.assertCurrent();
  const { environment: source, placement, workspace } = input.source;
  if (
    !workspace.diskAuthority ||
    !workspace.baseCommit ||
    !workspace.baseManifestHash ||
    source.state !== "attached" ||
    !source.retention ||
    !source.resourceReceipt ||
    source.destroyRequestedAtMs !== null ||
    source.teardownTerminalState !== null ||
    source.sharedHost !== false ||
    !source.nodeDeviceId ||
    source.sshEndpoint ||
    !source.bootstrapReceipt ||
    source.preparation !== null ||
    placement.turnClaim !== null ||
    input.source.hasPendingWorkspaceResult ||
    input.source.hasPlacementMove ||
    input.source.hasRunningToolOperation ||
    source.attachedSessionIds.length !== 1 ||
    source.attachedSessionIds[0] !== placement.sessionId ||
    placement.environmentId !== source.environmentId ||
    placement.activeOwnerEpoch !== source.ownerEpoch ||
    placement.agentId !== workspace.agentId ||
    placement.sessionKey !== workspace.sessionKey ||
    placement.workerBundleHash !== source.bootstrapReceipt.bundleHash
  ) {
    throw new Error("Sealed source has no quiescent retained repository owner");
  }
  assertRepositoryWorkspaceDiskIdentity(workspace.diskAuthority, source);
  const current = findWorkerEnvironment(db, source.environmentId);
  const currentPlacement = findPlacement(db, placement.sessionId);
  if (
    !isDeepStrictEqual(current ?? null, input.expected.environment) ||
    !isDeepStrictEqual(currentPlacement ?? null, input.expected.placement)
  ) {
    throw new Error("Retained owner recovery selection changed");
  }
  if (
    current &&
    (current.providerId !== source.providerId ||
      current.profileId !== source.profileId ||
      current.provisionOperationId !== source.provisionOperationId ||
      current.ownerEpoch !== source.ownerEpoch ||
      current.leaseId !== source.leaseId ||
      !current.resourceReceipt ||
      !sameWorkerResourceReceipt(current.resourceReceipt, source.resourceReceipt) ||
      !isDeepStrictEqual(current.profileSnapshot, source.profileSnapshot) ||
      !isDeepStrictEqual(current.retention?.policy, source.retention.policy) ||
      !isDeepStrictEqual(current.bootstrapReceipt, source.bootstrapReceipt) ||
      current.nodeDeviceId !== source.nodeDeviceId ||
      current.sharedHost !== false ||
      current.destroyRequestedAtMs !== null ||
      current.teardownTerminalState !== null ||
      current.preparation !== null ||
      !["attached", "ready", "idle", "orphaned"].includes(current.state) ||
      current.attachedSessionIds.some((id) => id !== placement.sessionId))
  ) {
    throw new Error("Retained owner recovery would overwrite a different resource owner");
  }
  if (
    currentPlacement &&
    (currentPlacement.agentId !== placement.agentId ||
      currentPlacement.sessionKey !== placement.sessionKey ||
      currentPlacement.environmentId !== source.environmentId ||
      currentPlacement.activeOwnerEpoch !== source.ownerEpoch ||
      currentPlacement.remoteWorkspaceDir !== placement.remoteWorkspaceDir ||
      currentPlacement.workspaceBaseManifestRef !== placement.workspaceBaseManifestRef ||
      currentPlacement.workerBundleHash !== placement.workerBundleHash ||
      currentPlacement.executionMode !== placement.executionMode ||
      currentPlacement.turnClaim ||
      isForceAbandonedWorkerPlacement(currentPlacement) ||
      !["active", "failed"].includes(currentPlacement.state))
  ) {
    throw new Error("Retained owner recovery would overwrite a placement or unfinished turn");
  }
  const kernel = createWorkerEnvironmentStoreKernel(database, () => nowMs);
  assertNoUnsettledWork(db, placement);
  if (
    listRows(db).some(
      (other) =>
        other.environmentId !== source.environmentId &&
        ((other.providerId === source.providerId &&
          (other.leaseId === source.leaseId ||
            other.provisionOperationId === source.provisionOperationId)) ||
          other.nodeDeviceId === source.nodeDeviceId ||
          other.attachedSessionIds.includes(placement.sessionId)),
    )
  ) {
    throw new Error("Retained owner recovery conflicts with another environment owner");
  }
  // The epoch names the retained node's workspace directory. A fresh placement generation,
  // absent credentials and closed runtime admission fence every previous turn claim.
  const generation = nextGeneration(
    Math.max(placement.generation, currentPlacement?.generation ?? 0),
  );
  if (!current) {
    kernel.createIntent({
      environmentId: source.environmentId,
      providerId: source.providerId,
      profileId: source.profileId,
      profileSnapshot: source.profileSnapshot,
      provisionOperationId: source.provisionOperationId,
      retention: source.retention.policy,
    });
  }
  const retention = { ...(current?.retention ?? source.retention), runtimeReady: false };
  input.assertCurrent();
  updateRow(db, source.environmentId, current?.state ?? "requested", {
    state: "attached",
    lease_id: source.leaseId,
    resource_receipt_json: json(source.resourceReceipt),
    retention_json: json(retention),
    owner_epoch: source.ownerEpoch,
    node_setup_id: null,
    node_device_id: source.nodeDeviceId,
    shared_host: 0,
    ssh_host: null,
    ssh_port: null,
    ssh_user: null,
    ssh_host_key: null,
    ssh_key_ref_json: null,
    desktop_json: null,
    bootstrap_bundle_hash: source.bootstrapReceipt.bundleHash,
    bootstrap_openclaw_version: source.bootstrapReceipt.openclawVersion,
    bootstrap_protocol_features_json: json(source.bootstrapReceipt.protocolFeatures),
    bootstrap_install_kind: source.bootstrapReceipt.installKind ?? null,
    attached_session_ids_json: json([placement.sessionId]),
    teardown_terminal_state: null,
    destroy_requested_at_ms: null,
    idle_since_at_ms: null,
    last_error: null,
    created_at_ms: current?.createdAtMs ?? source.createdAtMs,
    updated_at_ms: nowMs,
    state_changed_at_ms: nowMs,
  });
  revokeCredential(db, source.environmentId);
  const query = getNodeSqliteKysely<DB>(db);
  const values = {
    session_id: placement.sessionId,
    agent_id: placement.agentId,
    session_key: placement.sessionKey,
    execution_mode: placement.executionMode,
    state: "active",
    environment_id: source.environmentId,
    transition_generation: generation,
    active_owner_epoch: source.ownerEpoch,
    workspace_base_manifest_ref: placement.workspaceBaseManifestRef,
    remote_workspace_dir: placement.remoteWorkspaceDir,
    worker_bundle_hash: source.bootstrapReceipt.bundleHash,
    last_transcript_ack_cursor: (currentPlacement ?? placement).lastTranscriptAckCursor,
    last_live_event_ack_cursor: (currentPlacement ?? placement).lastLiveEventAckCursor,
    recovery_error: null,
    terminal_reason: null,
    terminal_at_ms: null,
    ...turnClaimValues(null),
    created_at_ms: currentPlacement?.createdAtMs ?? placement.createdAtMs,
    updated_at_ms: nowMs,
    state_changed_at_ms: nowMs,
  };
  if (currentPlacement) {
    executeSqliteQuerySync(
      db,
      query
        .updateTable("worker_session_placements")
        .set(values)
        .where("session_id", "=", placement.sessionId),
    );
  } else {
    executeSqliteQuerySync(db, query.insertInto("worker_session_placements").values(values));
  }
  const restoredWorkspace = restoreSessionRepositoryWorkspaceDiskInDatabase(
    db,
    {
      source: workspace,
      expectedCurrent: input.expected.workspace,
    },
    nowMs,
  ).workspace!;
  input.assertCurrent();
  return {
    environmentId: source.environmentId,
    ownerEpoch: source.ownerEpoch,
    placementGeneration: generation,
    workspaceId: workspace.workspaceId,
    workspaceRevision: restoredWorkspace.revision,
  };
}
