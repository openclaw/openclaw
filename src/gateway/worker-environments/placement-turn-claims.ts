import type { DatabaseSync } from "node:sqlite";
import type { ExpressionBuilder } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  isCurrentPlacementTurnClaim,
  normalizeEpoch,
  normalizeIdentity,
  required,
  resolvePlacementTurnEnvironment,
  type WorkerTurnClaimInput,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaim,
  type WorkerSessionTurnOwner,
} from "./placement-record.js";
import { find, fromRow, getRequired, query, turnClaimValues } from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import { clearWorkerTurnToolState } from "./placement-session-tool-operations.kernel.js";
import {
  publishPlacementTurnClaimState,
  publishPlacementWorkspaceJournalState,
} from "./placement-turn-authority.js";
import {
  deferTurnClaimRelease,
  deferWorkerTurnClaimClosed,
} from "./placement-turn-claim-events.js";
import {
  assertSessionWorkspaceUnreserved,
  selectActiveSessionWorkspaceReservation,
} from "./placement-workspace-reservation.kernel.js";
import {
  clearWorkerWorkspacePendingResult,
  hasCurrentWorkspaceResultClaim,
  hasAcceptedWorkerWorkspacePendingResult,
  hasWorkerWorkspacePendingResult,
  insertWorkerWorkspacePendingResult,
} from "./placement-workspace-result.js";
import {
  parseWorkerWorkspaceReconciliationPlan,
  serializeWorkerWorkspaceReconciliationPlan,
} from "./workspace-reconcile.js";
export { registerWorkerTurnClaimClosedHandler } from "./placement-turn-claim-events.js";

const workspaceJournalQuery = (db: DatabaseSync) =>
  getNodeSqliteKysely<Pick<StateDatabase, "worker_workspace_reconciliations">>(db);

export class ActiveTurnClaimError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} already has an active turn claim`);
    this.name = "ActiveTurnClaimError";
  }
}

function releaseTurnQuery(db: DatabaseSync, nowMs: number) {
  return query(db)
    .updateTable("worker_session_placements")
    .set({
      ...turnClaimValues(null),
      updated_at_ms: nowMs,
    });
}

export function clearLocalTurnClaimsInDatabase(
  db: DatabaseSync,
  path: string,
  nowMs: number,
): WorkerSessionPlacementRecord[] {
  const placements = executeSqliteQuerySync(
    db,
    releaseTurnQuery(db, nowMs).where("turn_claim_owner", "=", "local").returningAll(),
  ).rows.map(fromRow);
  for (const placement of placements) {
    publishPlacementTurnClaimState(db, placement, placement.state);
    deferTurnClaimRelease(db, path, placement.sessionId);
  }
  return placements;
}

export function createPlacementTurnClaimOps(runtime: PlacementStoreRuntime) {
  const { instanceId, path, now, write } = runtime;
  function publishTurnRelease(
    db: DatabaseSync,
    claim: WorkerSessionTurnClaim,
    statement: ReturnType<typeof releaseTurnQuery>,
    error: string,
  ): WorkerSessionPlacementRecord;
  function publishTurnRelease(
    db: DatabaseSync,
    claim: WorkerSessionTurnClaim,
    statement: ReturnType<typeof releaseTurnQuery>,
  ): WorkerSessionPlacementRecord | undefined;
  function publishTurnRelease(
    db: DatabaseSync,
    claim: WorkerSessionTurnClaim,
    statement: ReturnType<typeof releaseTurnQuery>,
    error?: string,
  ): WorkerSessionPlacementRecord | undefined {
    const row = executeSqliteQuerySync(db, statement.returningAll()).rows[0];
    if (!row) {
      if (error) {
        throw new Error(error);
      }
      return undefined;
    }
    const updated = fromRow(row);
    sessionChanges.emit({ agentId: updated.agentId, sessionKey: updated.sessionKey }, db);
    publishPlacementTurnClaimState(db, updated, updated.state);
    deferWorkerTurnClaimClosed(db, path, claim);
    return updated;
  }
  const claimTurnInDatabase = (
    db: DatabaseSync,
    input: WorkerTurnClaimInput,
    updatedAtMs: number,
    options: { allowDraining?: boolean } = {},
  ): { claim: WorkerSessionTurnClaim; placement: WorkerSessionPlacementRecord } => {
    const identity = normalizeIdentity(input);
    const claimId = required(input.claimId, "turn claim id");
    const runId = required(input.runId, "turn claim run id");
    const owner: WorkerSessionTurnOwner =
      input.owner.kind === "local"
        ? {
            kind: "local",
            ...(input.owner.environmentId === undefined
              ? {}
              : {
                  environmentId: required(input.owner.environmentId, "turn owner environment id"),
                  ownerEpoch: normalizeEpoch(input.owner.ownerEpoch ?? 0, "turn owner epoch"),
                }),
          }
        : {
            kind: "worker",
            environmentId: required(input.owner.environmentId, "turn owner environment id"),
            ownerEpoch: normalizeEpoch(input.owner.ownerEpoch, "turn owner epoch"),
          };
    const local = owner.kind === "local" && owner.environmentId === undefined;
    const claimValues = {
      turn_claim_owner: owner.kind,
      turn_claim_id: claimId,
      turn_claim_run_id: runId,
      turn_claim_owner_epoch: owner.kind === "worker" ? owner.ownerEpoch : null,
      updated_at_ms: updatedAtMs,
    };
    const placementQuery = query(db);
    const reservation = selectActiveSessionWorkspaceReservation(db, identity.sessionId);
    const admissible = (
      eb: ExpressionBuilder<
        Pick<StateDatabase, "worker_session_placements">,
        "worker_session_placements"
      >,
    ) =>
      eb.and([
        eb("agent_id", "=", identity.agentId),
        eb("session_key", "=", identity.sessionKey),
        local
          ? eb("state", "=", "local")
          : eb.and([
              owner.kind === "worker"
                ? eb.or([
                    eb("execution_mode", "=", "worker-turn"),
                    eb("execution_mode", "is", null),
                  ])
                : eb("execution_mode", "=", "remote-exec"),
              eb("state", "in", options.allowDraining ? ["active", "draining"] : ["active"]),
              eb("environment_id", "=", owner.environmentId!),
              eb("active_owner_epoch", "=", owner.ownerEpoch!),
            ]),
        eb.or([
          eb("turn_claim_owner", "is", null),
          eb.and([
            eb("turn_claim_owner", "=", owner.kind),
            eb("turn_claim_id", "=", claimId),
            eb("turn_claim_run_id", "=", runId),
            eb("turn_claim_generation", "=", eb.ref("transition_generation")),
          ]),
        ]),
      ]);
    const statement = local
      ? placementQuery
          .insertInto("worker_session_placements")
          .columns([
            "session_id",
            "agent_id",
            "session_key",
            "state",
            "turn_claim_owner",
            "turn_claim_id",
            "turn_claim_run_id",
            "turn_claim_owner_epoch",
            "updated_at_ms",
            "turn_claim_generation",
            "created_at_ms",
            "state_changed_at_ms",
          ])
          .expression(
            placementQuery
              .selectNoFrom((eb) => [
                eb.val(identity.sessionId).as("session_id"),
                eb.val(identity.agentId).as("agent_id"),
                eb.val(identity.sessionKey).as("session_key"),
                eb.val("local").as("state"),
                eb.val(claimValues.turn_claim_owner).as("turn_claim_owner"),
                eb.val(claimValues.turn_claim_id).as("turn_claim_id"),
                eb.val(claimValues.turn_claim_run_id).as("turn_claim_run_id"),
                eb.val(claimValues.turn_claim_owner_epoch).as("turn_claim_owner_epoch"),
                eb.val(updatedAtMs).as("updated_at_ms"),
                eb.val(0).as("turn_claim_generation"),
                eb.val(updatedAtMs).as("created_at_ms"),
                eb.val(updatedAtMs).as("state_changed_at_ms"),
              ])
              .where((eb) => eb.not(eb.exists(reservation))),
          )
          .onConflict((conflict) =>
            conflict
              .column("session_id")
              .doUpdateSet((eb) => ({
                ...claimValues,
                turn_claim_generation: eb.ref("transition_generation"),
              }))
              .where(admissible),
          )
      : placementQuery
          .updateTable("worker_session_placements")
          .set((eb) => ({
            ...claimValues,
            turn_claim_generation: eb.ref("transition_generation"),
          }))
          .where("session_id", "=", identity.sessionId)
          .where(admissible)
          .where((eb) => eb.not(eb.exists(reservation)));
    const row = executeSqliteQuerySync(db, statement.returningAll()).rows[0];
    if (!row) {
      // Failed admissions alone need a diagnostic read; the successful path is one write.
      assertSessionWorkspaceUnreserved(db, identity.sessionId);
      const current = find(db, identity.sessionId);
      if (
        current &&
        (current.agentId !== identity.agentId || current.sessionKey !== identity.sessionKey)
      ) {
        throw new Error(`Worker session placement identity changed for ${identity.sessionId}`);
      }
      if (current?.turnClaim) {
        throw new ActiveTurnClaimError(identity.sessionId);
      }
      if (owner.kind === "local") {
        throw new Error(
          `Local turn rejected for session ${identity.sessionId} in placement ${current?.state ?? "local"}`,
        );
      }
      throw new Error(`Worker turn rejected for session ${identity.sessionId}: stale owner`);
    }
    const placement = fromRow(row);
    publishPlacementTurnClaimState(db, placement, placement.state);
    sessionChanges.emit({ agentId: placement.agentId, sessionKey: placement.sessionKey }, db);
    return {
      placement,
      claim: {
        sessionId: placement.sessionId,
        claimId,
        runId,
        placementGeneration: placement.generation,
        owner,
      },
    };
  };
  const claimWorkspaceResult = (
    input: WorkerTurnClaimInput,
    purpose: "reclaim" | "mutation",
  ): WorkerSessionTurnClaim =>
    write((db) => {
      if (purpose === "mutation" && getRequired(db, input.sessionId).state !== "active") {
        throw new Error(
          `Session ${input.sessionId} workspace mutation requires an active placement`,
        );
      }
      const updatedAtMs = now();
      const { claim } = claimTurnInDatabase(db, input, updatedAtMs, {
        allowDraining: purpose === "reclaim",
      });
      // Mutation admission and its recovery custody must commit together: an
      // interrupted remote operation cannot leave unowned workspace changes.
      insertWorkerWorkspacePendingResult(db, claim, updatedAtMs, instanceId);
      return claim;
    });

  const releaseTurnInDatabase = (db: DatabaseSync, claim: WorkerSessionTurnClaim) => {
    const sessionId = required(claim.sessionId, "session id");
    const claimId = required(claim.claimId, "turn claim id");
    const runId = required(claim.runId, "turn claim run id");
    let statement = releaseTurnQuery(db, now())
      .where("session_id", "=", sessionId)
      .where("turn_claim_owner", "=", claim.owner.kind)
      .where("turn_claim_id", "=", claimId)
      .where("turn_claim_run_id", "=", runId)
      .where("turn_claim_generation", "=", claim.placementGeneration)
      .where((eb) =>
        eb.not(
          eb.exists(
            getNodeSqliteKysely<Pick<StateDatabase, "worker_workspace_pending_results">>(db)
              .selectFrom("worker_workspace_pending_results")
              .select("session_id")
              .where("session_id", "=", sessionId),
          ),
        ),
      );
    if (claim.owner.kind === "worker" || claim.owner.environmentId !== undefined) {
      statement = statement
        .where((eb) =>
          claim.owner.kind === "worker"
            ? eb.or([eb("execution_mode", "=", "worker-turn"), eb("execution_mode", "is", null)])
            : eb("execution_mode", "=", "remote-exec"),
        )
        .where(
          "state",
          "in",
          claim.owner.kind === "worker" ? ["active", "draining"] : ["active", "draining", "failed"],
        )
        .where("environment_id", "=", claim.owner.environmentId!)
        .where("active_owner_epoch", "=", claim.owner.ownerEpoch!);
      if (claim.owner.kind === "worker") {
        statement = statement.where("turn_claim_owner_epoch", "=", claim.owner.ownerEpoch);
      }
    } else if (claim.owner.ownerEpoch !== undefined) {
      return undefined;
    } else {
      statement = statement
        .where("state", "in", ["local", "requested", "failed"])
        .where((eb) =>
          eb.or([
            eb("execution_mode", "is", null),
            eb("execution_mode", "!=", "remote-exec"),
            eb("environment_id", "is", null),
            eb("active_owner_epoch", "is", null),
          ]),
        );
    }
    const placement = publishTurnRelease(db, claim, statement);
    if (!placement) {
      const current = find(db, sessionId);
      if (
        current &&
        isCurrentPlacementTurnClaim(current, claim) &&
        hasWorkerWorkspacePendingResult(db, sessionId)
      ) {
        throw new Error(`Session ${sessionId} has a pending cloud workspace result`);
      }
      return undefined;
    }
    // Local claims cannot authorize worker tools, so only worker claims own this cleanup.
    if (claim.owner.kind === "worker") {
      clearWorkerTurnToolState(db, { sessionId, claimId });
    }
    return placement;
  };

  return {
    claimTurn(input: WorkerTurnClaimInput) {
      return write((db) => claimTurnInDatabase(db, input, now()));
    },

    claimReclaimWorkspaceResult(input: WorkerTurnClaimInput): WorkerSessionTurnClaim {
      if (input.claimId !== input.runId || !input.claimId.startsWith("reclaim-")) {
        throw new Error(`Session ${input.sessionId} workspace result is not owned by reclaim`);
      }
      return claimWorkspaceResult(input, "reclaim");
    },

    claimWorkspaceMutationResult(
      input: Omit<WorkerTurnClaimInput, "runId">,
    ): WorkerSessionTurnClaim {
      return claimWorkspaceResult({ ...input, runId: input.claimId }, "mutation");
    },

    releaseTurn(claim: WorkerSessionTurnClaim): WorkerSessionPlacementRecord {
      const placement = write((db) => releaseTurnInDatabase(db, claim));
      if (!placement) {
        throw new Error(`Session ${claim.sessionId} turn claim changed before release`);
      }
      return placement;
    },

    releaseTurnIfOwned(claim: WorkerSessionTurnClaim): WorkerSessionPlacementRecord | undefined {
      return write((db) => releaseTurnInDatabase(db, claim));
    },

    completeWorkspaceResultAndReleaseTurn(
      claim: WorkerSessionTurnClaim,
    ): WorkerSessionPlacementRecord {
      const sessionId = required(claim.sessionId, "session id");
      const claimId = required(claim.claimId, "turn claim id");
      const runId = required(claim.runId, "turn claim run id");
      return write((db) => {
        if (!hasWorkerWorkspacePendingResult(db, sessionId)) {
          throw new Error(`Session ${sessionId} has no pending cloud workspace result`);
        }
        if (!hasAcceptedWorkerWorkspacePendingResult(db, sessionId)) {
          throw new Error(`Session ${sessionId} cloud workspace result was not accepted`);
        }
        const current = getRequired(db, sessionId);
        const environment = resolvePlacementTurnEnvironment(current, claim);
        if (!environment && !hasCurrentWorkspaceResultClaim(db, claim)) {
          throw new Error(`Session ${sessionId} workspace result owner changed before release`);
        }
        clearWorkerTurnToolState(db, { sessionId, claimId });
        const statement = releaseTurnQuery(db, now());
        clearWorkerWorkspacePendingResult(db, sessionId);
        return publishTurnRelease(
          db,
          claim,
          statement
            .where("session_id", "=", sessionId)
            .where("state", "=", current.state)
            .where("transition_generation", "=", current.generation)
            .where("turn_claim_id", current.turnClaim ? "=" : "is", current.turnClaim && claimId)
            .where("turn_claim_run_id", current.turnClaim ? "=" : "is", current.turnClaim && runId),
          `Session ${sessionId} workspace result changed during release`,
        );
      });
    },

    cancelWorkspaceResultAndReleaseTurn(
      claim: WorkerSessionTurnClaim,
      options?: { reason: "node-disconnect" },
    ): WorkerSessionPlacementRecord {
      const sessionId = required(claim.sessionId, "session id");
      const claimId = required(claim.claimId, "turn claim id");
      const runId = required(claim.runId, "turn claim run id");
      const nodeDisconnect = options?.reason === "node-disconnect";
      if (!nodeDisconnect && (claimId !== runId || !claimId.startsWith("reclaim-"))) {
        throw new Error(`Session ${sessionId} workspace result is not owned by reclaim`);
      }
      // Claim and recovery fence disappear together; either surviving half blocks the next attempt.
      return write((db) => {
        const current = getRequired(db, sessionId);
        const environment = resolvePlacementTurnEnvironment(current, claim);
        const pending = executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<Pick<StateDatabase, "worker_workspace_pending_results">>(db)
            .selectFrom("worker_workspace_pending_results")
            .selectAll()
            .where("session_id", "=", sessionId),
        ).rows[0];
        if (
          !environment ||
          !pending ||
          pending.environment_id !== environment.environmentId ||
          pending.owner_epoch !== environment.ownerEpoch ||
          pending.placement_generation !== claim.placementGeneration ||
          pending.claim_id !== claimId ||
          pending.run_id !== runId ||
          pending.workspace_accepted_at_ms !== null ||
          (nodeDisconnect &&
            (current.state !== "active" ||
              current.executionMode !== "remote-exec" ||
              claim.owner.kind !== "local" ||
              pending.gateway_instance_id !== instanceId ||
              pending.recovery_requested_at_ms !== null ||
              pending.staged_result_ref !== null ||
              executeSqliteQuerySync(
                db,
                workspaceJournalQuery(db)
                  .selectFrom("worker_workspace_reconciliations")
                  .select("session_id")
                  .where("session_id", "=", sessionId),
              ).rows.length > 0))
        ) {
          throw new Error(
            `Session ${sessionId} workspace result owner changed before cancellation`,
          );
        }
        clearWorkerTurnToolState(db, { sessionId, claimId });
        clearWorkerWorkspacePendingResult(db, sessionId);
        return publishTurnRelease(
          db,
          claim,
          releaseTurnQuery(db, now())
            .where("session_id", "=", sessionId)
            .where("state", "=", current.state)
            .where("transition_generation", "=", current.generation)
            .where("turn_claim_id", "=", claimId)
            .where("turn_claim_run_id", "=", runId),
          `Session ${sessionId} workspace result changed during cancellation`,
        );
      });
    },

    updateWorkspaceBaseManifest(input: {
      claim: WorkerSessionTurnClaim;
      manifestRef: string;
    }): WorkerSessionPlacementRecord {
      const sessionId = required(input.claim.sessionId, "session id");
      const claimId = required(input.claim.claimId, "turn claim id");
      const runId = required(input.claim.runId, "turn claim run id");
      const manifestRef = required(input.manifestRef, "workspace base manifest ref");
      if (!/^sha256:[a-f0-9]{64}$/u.test(manifestRef)) {
        throw new Error("Worker workspace base manifest reference is invalid");
      }
      const placementGeneration = input.claim.placementGeneration;
      return write((db) => {
        const current = getRequired(db, sessionId);
        const environment = resolvePlacementTurnEnvironment(current, input.claim);
        if (!environment && !hasCurrentWorkspaceResultClaim(db, input.claim)) {
          throw new Error(`Cannot advance stale worker workspace for session ${sessionId}`);
        }
        const environmentId = environment?.environmentId ?? current.environmentId!;
        const ownerEpoch = environment?.ownerEpoch ?? current.activeOwnerEpoch!;
        const reconciliation = executeSqliteQuerySync(
          db,
          workspaceJournalQuery(db)
            .selectFrom("worker_workspace_reconciliations")
            .selectAll()
            .where("session_id", "=", sessionId),
        ).rows[0];
        const reconciliationPlan = reconciliation
          ? parseWorkerWorkspaceReconciliationPlan(reconciliation.plan_json)
          : undefined;
        if (
          reconciliation &&
          reconciliation.base_manifest_ref !== current.workspaceBaseManifestRef &&
          reconciliationPlan?.appliedManifestRef !== current.workspaceBaseManifestRef
        ) {
          throw new Error(`Worker workspace journal owner is stale for session ${sessionId}`);
        }
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_session_placements")
            .set({ workspace_base_manifest_ref: manifestRef, updated_at_ms: now() })
            .where("session_id", "=", sessionId)
            .where("state", "=", current.state)
            .where("transition_generation", "=", current.generation)
            .where("environment_id", "=", environmentId)
            .where("active_owner_epoch", "=", ownerEpoch)
            .where((eb) =>
              eb.and(
                turnClaimValues(
                  current.turnClaim && {
                    ...current.turnClaim,
                    claimId,
                    runId,
                    generation: placementGeneration,
                  },
                ),
              ),
            ),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Worker session workspace ${sessionId} changed during reconciliation`);
        }
        if (reconciliation) {
          const markedPlan = serializeWorkerWorkspaceReconciliationPlan({
            ...reconciliationPlan!,
            appliedManifestRef: manifestRef,
            basePack: reconciliation.base_pack,
          });
          const marked = executeSqliteQuerySync(
            db,
            workspaceJournalQuery(db)
              .updateTable("worker_workspace_reconciliations")
              .set({ plan_json: markedPlan })
              .where("session_id", "=", sessionId)
              .where("base_manifest_ref", "=", reconciliation.base_manifest_ref),
          );
          if (marked.numAffectedRows !== 1n) {
            throw new Error(`Worker workspace journal changed for session ${sessionId}`);
          }
          publishPlacementWorkspaceJournalState(db, sessionId, true);
        }
        const updated = getRequired(db, sessionId);
        publishPlacementTurnClaimState(db, updated, current.state);
        sessionChanges.emit({ agentId: current.agentId, sessionKey: current.sessionKey }, db);
        return updated;
      });
    },
  };
}
