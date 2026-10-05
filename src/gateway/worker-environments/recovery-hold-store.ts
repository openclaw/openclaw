import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  isWorkerRecoveryDisposalSettled,
  type WorkerEnvironmentRecoveryHold,
  type WorkerRecoveryCheckpoint,
} from "./environment-record.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import { fromRow } from "./placement-row-codec.js";
import { hasWorkerEnvironmentSessionAttachment } from "./session-attachment-store.js";
import { revokeCredential, updateWorkerEnvironmentRecord } from "./store-mutations.js";
import { findCredential, findWorkerEnvironment, json } from "./store-row-codec.js";
import { collectFailureDiagnostic } from "./worker-recovery-diagnostic.js";

export { retainPreparedWorkerEnvironment } from "./prepared-recovery-hold-store.js";

const query = (db: DatabaseSync) =>
  getNodeSqliteKysely<
    Pick<
      DB,
      | "worker_environments"
      | "worker_environment_recovery_holds"
      | "worker_session_placements"
      | "worker_workspace_pending_results"
      | "worker_workspace_reconciliations"
      | "worker_session_placement_moves"
      | "session_repository_workspaces"
    >
  >(db);

export type RetainedWorkerRecoveryAcceptance = WorkerRecoveryCheckpoint & {
  environmentId: string;
  sessionId: string;
  placementGeneration: number;
  /** Physical cleanup cannot grant logical continuation authority. Never persisted. */
  disposalOnly?: true;
};

export function acceptRetainedWorkerRecovery(
  db: DatabaseSync,
  input: RetainedWorkerRecoveryAcceptance,
  nowMs: number,
): Extract<WorkerSessionPlacementRecord, { state: "failed" | "reclaimed" }> {
  const environment = findWorkerEnvironment(db, input.environmentId);
  const hold = environment?.recoveryHold;
  const placement = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_session_placements")
      .selectAll()
      .where("session_id", "=", input.sessionId),
  );
  if (
    !hold ||
    hold.kind === "prepared" ||
    !["requested", "held", "disposal-pending"].includes(hold.phase) ||
    !hold.diagnostic ||
    !environment ||
    environment.sharedHost !== false ||
    environment.ownerEpoch !== hold.ownerEpoch ||
    environment.leaseId !== hold.leaseId ||
    hold.sessionId !== input.sessionId ||
    hold.placementGeneration !== input.placementGeneration ||
    !placement ||
    placement.state !== "failed" ||
    placement.transition_generation !== input.placementGeneration ||
    placement.environment_id !== input.environmentId ||
    placement.active_owner_epoch !== hold.ownerEpoch ||
    placement.agent_id !== hold.agentId ||
    placement.session_key !== hold.sessionKey ||
    placement.execution_mode !== hold.executionMode ||
    placement.turn_claim_id !== null ||
    !placement.workspace_base_manifest_ref ||
    !placement.remote_workspace_dir ||
    !placement.worker_bundle_hash
  ) {
    throw new Error("Retained worker placement changed before checkpoint acceptance");
  }
  for (const table of [
    "worker_workspace_pending_results",
    "worker_workspace_reconciliations",
    "worker_session_placement_moves",
  ] as const) {
    if (
      executeSqliteQueryTakeFirstSync(
        db,
        query(db).selectFrom(table).select("session_id").where("session_id", "=", input.sessionId),
      )
    ) {
      throw new Error("Unresolved worker results prevent retained-source recovery");
    }
  }
  const workspace = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("session_repository_workspaces")
      .selectAll()
      .where("workspace_id", "=", input.workspaceId),
  );
  if (
    !workspace ||
    workspace.agent_id !== hold.agentId ||
    workspace.session_key !== hold.sessionKey ||
    workspace.revision !== input.expectedWorkspaceRevision ||
    workspace.checkpoint_ref !== input.previousCheckpointRef ||
    !/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(input.checkpointRef) ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.manifestHash) ||
    (input.remoteHeadCommit === undefined
      ? input.disposalOnly !== true ||
        input.checkpointRef !== input.previousCheckpointRef ||
        input.manifestHash !== workspace.manifest_hash
      : !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(input.remoteHeadCommit))
  ) {
    throw new Error("Retained worker repository changed before recovery acceptance");
  }
  const compute = hold.receipt?.resources.filter((resource) => resource.kind === "vm") ?? [];
  const physicallyReleased = isWorkerRecoveryDisposalSettled(environment);
  const confirmedAbsent =
    hold.receipt?.status === "held" &&
    hold.receipt.leaseId === hold.leaseId &&
    compute.length > 0 &&
    compute.every((resource) => resource.state === "absent");
  const pending = hold.disposalCheckpoint;
  // Settled accepted-only custody can yield to freshly verified recovery; a staged
  // remote reconciliation keeps its exact tuple throughout disposal and cutover.
  const verifiedAfterDisposal =
    pending?.remoteHeadCommit === undefined &&
    pending !== undefined &&
    input.disposalOnly !== true &&
    physicallyReleased &&
    pending.workspaceId === workspace.workspace_id &&
    pending.expectedWorkspaceRevision === workspace.revision &&
    pending.previousCheckpointRef === workspace.checkpoint_ref &&
    pending.checkpointRef === workspace.checkpoint_ref &&
    pending.manifestHash === workspace.manifest_hash;
  if (
    pending &&
    !verifiedAfterDisposal &&
    (pending.workspaceId !== input.workspaceId ||
      pending.expectedWorkspaceRevision !== input.expectedWorkspaceRevision ||
      pending.previousCheckpointRef !== input.previousCheckpointRef ||
      pending.checkpointRef !== input.checkpointRef ||
      pending.manifestHash !== input.manifestHash ||
      pending.remoteHeadCommit !== input.remoteHeadCommit)
  ) {
    throw new Error("Staged worker checkpoint custody changed during disposal");
  }
  if (input.disposalOnly === true || (!physicallyReleased && !confirmedAbsent)) {
    if (!hold.disposalCheckpoint) {
      const {
        environmentId: _environmentId,
        sessionId: _sessionId,
        placementGeneration: _generation,
        disposalOnly: _disposalOnly,
        ...checkpoint
      } = input;
      executeSqliteQuerySync(
        db,
        query(db)
          .updateTable("worker_environment_recovery_holds")
          .set({
            hold_json: json({ ...hold, phase: "disposal-pending", disposalCheckpoint: checkpoint }),
          })
          .where("environment_id", "=", input.environmentId),
      );
    }
    const pendingPlacement = fromRow(placement);
    if (pendingPlacement.state !== "failed") {
      throw new Error("Worker disposal lost its failed placement");
    }
    return pendingPlacement;
  }
  const acceptedRevision = workspace.revision + 1;
  executeSqliteQuerySync(
    db,
    query(db)
      .updateTable("session_repository_workspaces")
      .set({
        checkpoint_ref: input.checkpointRef,
        manifest_hash: input.manifestHash,
        revision: acceptedRevision,
        updated_at_ms: nowMs,
      })
      .where("workspace_id", "=", input.workspaceId)
      .where("revision", "=", workspace.revision),
  );
  executeSqliteQuerySync(
    db,
    query(db)
      .updateTable("worker_environment_recovery_holds")
      .set({
        hold_json: json({
          ...hold,
          phase: "reconciled",
          checkpointRef: input.checkpointRef,
          previousCheckpointRef: input.previousCheckpointRef,
          remoteHeadCommit: input.remoteHeadCommit,
          reconciledAtMs: nowMs,
          workspaceId: input.workspaceId,
          acceptedWorkspaceRevision: acceptedRevision,
          manifestHash: input.manifestHash,
          disposalCheckpoint: undefined,
        }),
      })
      .where("environment_id", "=", input.environmentId),
  );
  executeSqliteQuerySync(
    db,
    query(db)
      .updateTable("worker_session_placements")
      .set({
        state: "reclaimed",
        transition_generation: placement.transition_generation + 1,
        workspace_base_manifest_ref: input.manifestHash,
        recovery_error: null,
        terminal_reason: null,
        terminal_at_ms: null,
        updated_at_ms: nowMs,
        state_changed_at_ms: nowMs,
      })
      .where("session_id", "=", input.sessionId)
      .where("transition_generation", "=", input.placementGeneration),
  );
  const accepted = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_session_placements")
      .selectAll()
      .where("session_id", "=", input.sessionId),
  );
  if (!accepted) {
    throw new Error("Recovered worker placement disappeared");
  }
  const reclaimed = fromRow(accepted);
  if (reclaimed.state !== "reclaimed") {
    throw new Error("Retained-source recovery did not produce a reclaimed placement");
  }
  return reclaimed;
}

export function retainFailedWorkerEnvironment(
  db: DatabaseSync,
  hold: WorkerEnvironmentRecoveryHold & { capacity: number },
) {
  const environment = findWorkerEnvironment(db, hold.environmentId);
  const placement = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_session_placements")
      .selectAll()
      .where("session_id", "=", hold.sessionId),
  );
  if (
    !environment ||
    !placement ||
    placement.state !== "failed" ||
    placement.transition_generation !== hold.placementGeneration ||
    placement.environment_id !== hold.environmentId ||
    placement.active_owner_epoch !== hold.ownerEpoch ||
    placement.session_key !== hold.sessionKey ||
    placement.agent_id !== hold.agentId ||
    placement.turn_claim_id !== null ||
    environment.ownerEpoch !== hold.ownerEpoch ||
    environment.leaseId !== hold.leaseId ||
    (hold.receipt && hold.receipt.leaseId !== hold.leaseId) ||
    environment.sharedHost !== false ||
    environment.attachedSessionIds.some((sessionId) => sessionId !== hold.sessionId) ||
    hasWorkerEnvironmentSessionAttachment(db, hold.environmentId) ||
    executeSqliteQueryTakeFirstSync(
      db,
      query(db)
        .selectFrom("worker_session_placements")
        .select("session_id")
        .where("environment_id", "=", hold.environmentId)
        .where("session_id", "!=", hold.sessionId),
    )
  ) {
    throw new Error("Failed worker owner changed before retaining its resources");
  }
  const existing = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_environment_recovery_holds")
      .selectAll()
      .where("session_id", "=", hold.sessionId),
  );
  if (existing) {
    if (existing.environment_id !== hold.environmentId) {
      throw new Error(
        "This session already has an unresolved retained worker; salvage it before another replacement",
      );
    }
    if (environment.recoveryHold?.phase !== "requested" || !hold.receipt || hold.phase !== "held") {
      return environment;
    }
    const { capacity: _capacity, ...recorded } = hold;
    executeSqliteQuerySync(
      db,
      query(db)
        .updateTable("worker_environment_recovery_holds")
        .set({
          hold_json: json({
            ...recorded,
            diagnostic: environment.recoveryHold.diagnostic,
            cleanup: environment.recoveryHold.cleanup,
          }),
        })
        .where("environment_id", "=", hold.environmentId),
    );
    return updateWorkerEnvironmentRecord(db, hold.environmentId, environment.state, {
      updated_at_ms: hold.createdAtMs,
      last_error:
        environment.lastError ??
        `Retained for session recovery; lease ${hold.leaseId}, disk and companion resources remain held. Unaccepted edits require salvage.`,
    });
  }
  const count = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_environment_recovery_holds")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("session_id", "is not", null),
  );
  if (
    !Number.isSafeInteger(hold.capacity) ||
    hold.capacity < 1 ||
    (count?.count ?? 0) >= hold.capacity
  ) {
    throw new Error(
      "Retained worker capacity is full; salvage a retained source before another replacement",
    );
  }
  for (const table of [
    "worker_workspace_pending_results",
    "worker_workspace_reconciliations",
    "worker_session_placement_moves",
  ] as const) {
    if (
      executeSqliteQueryTakeFirstSync(
        db,
        query(db).selectFrom(table).select("session_id").where("session_id", "=", hold.sessionId),
      )
    ) {
      throw new Error(
        "Failed worker workspace results must settle before replacement; retained resources remain available",
      );
    }
  }
  if (hold.phase !== "requested" || hold.receipt) {
    throw new Error("Retained worker custody must be reserved before provider confirmation");
  }
  const { capacity: _capacity, ...recorded } = hold;
  executeSqliteQuerySync(
    db,
    query(db)
      .insertInto("worker_environment_recovery_holds")
      .values({
        environment_id: hold.environmentId,
        session_id: hold.sessionId,
        hold_json: json({
          ...recorded,
          cleanup: undefined,
          diagnostic: collectFailureDiagnostic(
            "failed-placement",
            placement.recovery_error,
            hold.createdAtMs,
          ),
        }),
      }),
  );
  revokeCredential(db, hold.environmentId);
  return updateWorkerEnvironmentRecord(db, hold.environmentId, environment.state, {
    state: "orphaned",
    destroy_requested_at_ms: environment.destroyRequestedAtMs ?? hold.createdAtMs,
    teardown_terminal_state: environment.teardownTerminalState ?? "destroyed",
    updated_at_ms: hold.createdAtMs,
    state_changed_at_ms: hold.createdAtMs,
    attached_session_ids_json: "[]",
    last_error:
      environment.lastError ??
      `Retaining lease ${hold.leaseId} for session recovery; provider hold confirmation is pending. Unaccepted edits require salvage.`,
  });
}

/** requestDestroy's held-worker branch; no caller-supplied disposition can authorize it. */
export function requestRetainedWorkerDisposal(
  db: DatabaseSync,
  environmentId: string,
  nowMs: number,
  providerRelease?: { leaseId: string; ownerEpoch: number },
) {
  const environment = findWorkerEnvironment(db, environmentId);
  const hold = environment?.recoveryHold;
  const vms = hold?.receipt?.resources.filter((resource) => resource.kind === "vm") ?? [];
  if (
    !environment ||
    !hold ||
    !hold.diagnostic ||
    hold.cleanup?.settledAtMs !== undefined ||
    hold.diagnostic.cause !== "unverified" ||
    !Number.isSafeInteger(hold.diagnostic.collectedAtMs) ||
    hold.diagnostic.collectedAtMs < 0 ||
    (hold.diagnostic.failureHash !== null &&
      !/^[a-f0-9]{64}$/u.test(hold.diagnostic.failureHash)) ||
    environment.sharedHost !== false ||
    environment.ownerEpoch !== hold.ownerEpoch ||
    environment.leaseId !== hold.leaseId ||
    environment.destroyRequestedAtMs === null ||
    environment.attachedSessionIds.length !== 0 ||
    hasWorkerEnvironmentSessionAttachment(db, environmentId) ||
    findCredential(db, environmentId) ||
    !["orphaned", "destroying"].includes(environment.state) ||
    (hold.receipt !== undefined &&
      (hold.receipt.status !== "held" ||
        hold.receipt.leaseId !== hold.leaseId ||
        vms.length === 0 ||
        hold.receipt.resources.some(
          (resource) =>
            (resource.state !== "absent" && resource.state !== "retained") ||
            (resource.state === "retained" && !resource.immutableId),
        )))
  ) {
    throw new Error(
      "Held worker disposal requires collected diagnostics and exact fenced resource custody",
    );
  }
  const placements = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("worker_session_placements")
      .selectAll()
      .where("environment_id", "=", environmentId),
  ).rows;
  if (hold.kind === "prepared") {
    if (
      (hold.phase !== "requested" && hold.phase !== "held") ||
      hold.diagnostic.origin !== "unused-prepared-worker" ||
      environment.preparation?.key !== hold.preparationKey ||
      environment.preparation.purpose !== "reserve" ||
      environment.preparation.consumedAtMs !== null ||
      placements.length !== 0
    ) {
      throw new Error("Prepared worker disposal custody changed");
    }
  } else {
    const pending = hold.disposalCheckpoint;
    const current = executeSqliteQueryTakeFirstSync(
      db,
      query(db)
        .selectFrom("worker_session_placements")
        .selectAll()
        .where("session_id", "=", hold.sessionId),
    );
    const workspaceId = pending?.workspaceId ?? hold.workspaceId;
    const workspace =
      workspaceId &&
      executeSqliteQueryTakeFirstSync(
        db,
        query(db)
          .selectFrom("session_repository_workspaces")
          .selectAll()
          .where("workspace_id", "=", workspaceId),
      );
    if (
      hold.phase !== (pending ? "disposal-pending" : "reconciled") ||
      hold.diagnostic.origin !== "failed-placement" ||
      !current ||
      current.session_key !== hold.sessionKey ||
      current.agent_id !== hold.agentId ||
      (pending
        ? current.state !== "failed" ||
          current.environment_id !== environmentId ||
          current.transition_generation !== hold.placementGeneration ||
          current.active_owner_epoch !== hold.ownerEpoch ||
          current.turn_claim_id !== null
        : current.transition_generation <= hold.placementGeneration) ||
      placements.some(
        (placement) =>
          placement.session_id !== hold.sessionId ||
          placement.state !== (pending ? "failed" : "reclaimed") ||
          placement.turn_claim_id !== null ||
          placement.transition_generation !== hold.placementGeneration + (pending ? 0 : 1) ||
          placement.active_owner_epoch !== hold.ownerEpoch,
      ) ||
      !workspace ||
      workspace.agent_id !== hold.agentId ||
      workspace.session_key !== hold.sessionKey ||
      !workspace.checkpoint_ref ||
      (pending
        ? workspace.revision !== pending.expectedWorkspaceRevision ||
          workspace.checkpoint_ref !== pending.previousCheckpointRef
        : hold.acceptedWorkspaceRevision === undefined ||
          workspace.revision < hold.acceptedWorkspaceRevision ||
          !hold.checkpointRef ||
          !hold.manifestHash ||
          (workspace.revision === hold.acceptedWorkspaceRevision &&
            (workspace.checkpoint_ref !== hold.checkpointRef ||
              workspace.manifest_hash !== hold.manifestHash))) ||
      (!pending &&
        hold.cleanup?.providerReleasedAtMs === undefined &&
        vms.some((resource) => resource.state !== "absent"))
    ) {
      throw new Error(
        "Accepted checkpoint or current placement changed before held worker disposal",
      );
    }
    for (const table of [
      "worker_workspace_pending_results",
      "worker_workspace_reconciliations",
      "worker_session_placement_moves",
    ] as const) {
      if (
        executeSqliteQueryTakeFirstSync(
          db,
          query(db).selectFrom(table).select("session_id").where("session_id", "=", hold.sessionId),
        )
      ) {
        throw new Error("Unresolved worker results prevent held worker disposal");
      }
    }
  }
  const cleanup = hold.cleanup ?? { requestedAtMs: nowMs };
  if (providerRelease) {
    if (
      environment.state !== "destroying" ||
      !hold.cleanup ||
      providerRelease.leaseId !== hold.leaseId ||
      providerRelease.ownerEpoch !== hold.ownerEpoch
    ) {
      throw new Error("Held worker provider release identity changed");
    }
    cleanup.providerReleasedAtMs ??= nowMs;
  }
  executeSqliteQuerySync(
    db,
    query(db)
      .updateTable("worker_environment_recovery_holds")
      .set({ hold_json: json({ ...hold, cleanup }) })
      .where("environment_id", "=", environmentId),
  );
  return updateWorkerEnvironmentRecord(db, environmentId, environment.state, {
    state: "destroying",
    state_changed_at_ms: environment.state === "destroying" ? environment.stateChangedAtMs : nowMs,
    updated_at_ms: nowMs,
    teardown_terminal_state: "destroyed",
  });
}

/** Called only by the canonical proven-destroy terminal transaction. Keep the RCA receipt. */
export function settleRetainedWorkerDisposal(
  db: DatabaseSync,
  environmentId: string,
  nowMs: number,
) {
  const hold = findWorkerEnvironment(db, environmentId)?.recoveryHold;
  if (
    !hold?.cleanup ||
    hold.cleanup.providerReleasedAtMs === undefined ||
    hold.cleanup.settledAtMs !== undefined
  ) {
    throw new Error("Held worker disposal was not admitted");
  }
  executeSqliteQuerySync(
    db,
    query(db)
      .updateTable("worker_environment_recovery_holds")
      .set({
        session_id: null,
        hold_json: json({ ...hold, cleanup: { ...hold.cleanup, settledAtMs: nowMs } }),
      })
      .where("environment_id", "=", environmentId),
  );
}
