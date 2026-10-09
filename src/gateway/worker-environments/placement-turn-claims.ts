import type { DatabaseSync } from "node:sqlite";
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
import {
  ensureLocal,
  find,
  fromRow,
  getRequired,
  query,
  turnClaimValues,
} from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import {
  assertNoRunningWorkerSessionToolOperations,
  clearWorkerTurnToolState,
} from "./placement-session-tool-operations.kernel.js";
import { parseWorkerSessionPlacementState } from "./placement-state.js";
import {
  publishPlacementTurnClaimCleared,
  publishPlacementTurnClaimState,
} from "./placement-turn-authority.js";
import {
  deferTurnClaimRelease,
  deferWorkerTurnClaimClosed,
  removeTurnClaimReleaseWaiter,
  waitersFor,
} from "./placement-turn-claim-events.js";
import { assertSessionWorkspaceUnreserved } from "./placement-workspace-reservation.kernel.js";
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

export function createPlacementTurnClaimOps(runtime: PlacementStoreRuntime) {
  const { instanceId, path, now, read, write } = runtime;
  const publishTurnRelease = (
    db: DatabaseSync,
    current: WorkerSessionPlacementRecord,
    claim: WorkerSessionTurnClaim,
    statement: ReturnType<typeof releaseTurnQuery>,
    error: string,
  ): WorkerSessionPlacementRecord => {
    const row = executeSqliteQuerySync(db, statement.returningAll()).rows[0];
    if (!row) {
      throw new Error(error);
    }
    sessionChanges.emit({ agentId: current.agentId, sessionKey: current.sessionKey }, db);
    const updated = fromRow(row);
    publishPlacementTurnClaimState(db, updated, current.state);
    deferWorkerTurnClaimClosed(db, path, claim);
    return updated;
  };
  const claimTurnInDatabase = (
    db: DatabaseSync,
    input: WorkerTurnClaimInput,
    updatedAtMs: number,
    options: { allowDraining?: boolean } = {},
  ): WorkerSessionTurnClaim => {
    const identity = normalizeIdentity(input);
    assertSessionWorkspaceUnreserved(db, identity.sessionId);
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
    const current = ensureLocal(db, identity, updatedAtMs);
    if (current.turnClaim) {
      throw new ActiveTurnClaimError(identity.sessionId);
    }
    if (owner.kind === "local") {
      const localPlacement = current.state === "local" && owner.environmentId === undefined;
      const remotePlacement =
        current.executionMode === "remote-exec" &&
        (current.state === "active" || (options.allowDraining && current.state === "draining")) &&
        owner.environmentId === current.environmentId &&
        owner.ownerEpoch === current.activeOwnerEpoch;
      if (!localPlacement && !remotePlacement) {
        throw new Error(
          `Local turn rejected for session ${identity.sessionId} in placement ${current.state}`,
        );
      }
    } else if (
      current.executionMode !== "worker-turn" ||
      (current.state !== "active" && !(options.allowDraining && current.state === "draining")) ||
      current.environmentId !== owner.environmentId ||
      current.activeOwnerEpoch !== owner.ownerEpoch
    ) {
      throw new Error(`Worker turn rejected for session ${identity.sessionId}: stale owner`);
    }
    const result = executeSqliteQuerySync(
      db,
      query(db)
        .updateTable("worker_session_placements")
        .set({
          turn_claim_owner: owner.kind,
          turn_claim_id: claimId,
          turn_claim_run_id: runId,
          turn_claim_generation: current.generation,
          turn_claim_owner_epoch: owner.kind === "worker" ? owner.ownerEpoch : null,
          updated_at_ms: updatedAtMs,
        })
        .where("session_id", "=", current.sessionId)
        .where("state", "=", current.state)
        .where("transition_generation", "=", current.generation)
        .where("turn_claim_owner", "is", null),
    );
    if (result.numAffectedRows !== 1n) {
      throw new Error(`Session ${identity.sessionId} placement changed during turn admission`);
    }
    publishPlacementTurnClaimState(db, getRequired(db, identity.sessionId), current.state);
    sessionChanges.emit({ agentId: current.agentId, sessionKey: current.sessionKey }, db);
    return {
      sessionId: current.sessionId,
      claimId,
      runId,
      placementGeneration: current.generation,
      owner,
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
      const claim = claimTurnInDatabase(db, input, updatedAtMs, {
        allowDraining: purpose === "reclaim",
      });
      // Mutation admission and its recovery custody must commit together: an
      // interrupted remote operation cannot leave unowned workspace changes.
      insertWorkerWorkspacePendingResult(db, claim, updatedAtMs, instanceId);
      return claim;
    });

  return {
    claimTurn(input: WorkerTurnClaimInput): WorkerSessionTurnClaim {
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
      const sessionId = required(claim.sessionId, "session id");
      const claimId = required(claim.claimId, "turn claim id");
      const runId = required(claim.runId, "turn claim run id");
      return write((db) => {
        const current = getRequired(db, sessionId);
        if (hasWorkerWorkspacePendingResult(db, sessionId)) {
          throw new Error(`Session ${sessionId} has a pending cloud workspace result`);
        }
        if (!isCurrentPlacementTurnClaim(current, claim)) {
          throw new Error(`Session ${sessionId} turn claim changed before release`);
        }
        assertNoRunningWorkerSessionToolOperations(db, { sessionId, claimId });
        clearWorkerTurnToolState(db, { sessionId, claimId });
        return publishTurnRelease(
          db,
          current,
          claim,
          releaseTurnQuery(db, now())
            .where("session_id", "=", sessionId)
            .where("turn_claim_id", "=", claimId)
            .where("turn_claim_run_id", "=", runId)
            .where("turn_claim_generation", "=", claim.placementGeneration),
          `Session ${sessionId} turn claim changed during release`,
        );
      });
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
        assertNoRunningWorkerSessionToolOperations(db, { sessionId, claimId });
        clearWorkerTurnToolState(db, { sessionId, claimId });
        const statement = releaseTurnQuery(db, now());
        clearWorkerWorkspacePendingResult(db, sessionId);
        return publishTurnRelease(
          db,
          current,
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
        assertNoRunningWorkerSessionToolOperations(db, { sessionId, claimId });
        clearWorkerTurnToolState(db, { sessionId, claimId });
        clearWorkerWorkspacePendingResult(db, sessionId);
        return publishTurnRelease(
          db,
          current,
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

    clearLocalTurnClaimsAfterRestart(this: void): number {
      return write((db) => {
        const placements = executeSqliteQuerySync(
          db,
          query(db)
            .selectFrom("worker_session_placements")
            .select(["session_id", "state"])
            .where("turn_claim_owner", "=", "local"),
        ).rows;
        const result = executeSqliteQuerySync(
          db,
          releaseTurnQuery(db, now()).where("turn_claim_owner", "=", "local"),
        );
        if (result.numAffectedRows !== BigInt(placements.length)) {
          throw new Error("Local turn claims changed during restart recovery");
        }
        for (const { session_id: sessionId, state } of placements) {
          publishPlacementTurnClaimCleared(db, sessionId, parseWorkerSessionPlacementState(state));
          deferTurnClaimRelease(db, path, sessionId);
        }
        return placements.length;
      });
    },

    async waitForTurnClaimRelease(
      this: void,
      sessionIdInput: string,
      waitOptions: { timeoutMs?: number; signal?: AbortSignal },
    ): Promise<void> {
      const sessionId = required(sessionIdInput, "session id");
      if (
        waitOptions.timeoutMs !== undefined &&
        (!Number.isSafeInteger(waitOptions.timeoutMs) || waitOptions.timeoutMs < 0)
      ) {
        throw new Error("Worker session turn claim wait timeout must be a non-negative integer");
      }
      if (!find(read(), sessionId)?.turnClaim) {
        return;
      }
      if (waitOptions.signal?.aborted) {
        throw new Error(`Turn claim wait aborted for session ${sessionId}`);
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const waiters = waitersFor(path, sessionId);
        const finish = (error?: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer) {
            clearTimeout(timer);
          }
          waitOptions.signal?.removeEventListener("abort", onAbort);
          removeTurnClaimReleaseWaiter(path, sessionId, onRelease);
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };
        const onRelease = (error?: Error) => finish(error);
        const onAbort = () => finish(new Error(`Turn claim wait aborted for session ${sessionId}`));
        const timer =
          waitOptions.timeoutMs === undefined
            ? undefined
            : setTimeout(
                () =>
                  finish(
                    new Error(`Timed out waiting for session ${sessionId} turn claim release`),
                  ),
                waitOptions.timeoutMs,
              );
        waiters.add(onRelease);
        waitOptions.signal?.addEventListener("abort", onAbort, { once: true });
        // Register first, then reread. This closes the release-between-check-and-wait race.
        if (!find(read(), sessionId)?.turnClaim) {
          finish();
        } else if (waitOptions.signal?.aborted) {
          onAbort();
        }
      });
    },

    validateTurnClaim(this: void, claim: WorkerSessionTurnClaim): boolean {
      const current = find(read(), required(claim.sessionId, "session id"));
      return current ? isCurrentPlacementTurnClaim(current, claim) : false;
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
        }
        sessionChanges.emit({ agentId: current.agentId, sessionKey: current.sessionKey }, db);
        return getRequired(db, sessionId);
      });
    },
  };
}
