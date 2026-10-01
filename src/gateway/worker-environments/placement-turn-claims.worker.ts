import { requestSessionEntryCurrentAdmission } from "../../config/sessions/session-entry-current-admission.worker.js";
import type { SessionEntryCurrentSource } from "../../config/sessions/session-entry-current.types.js";
import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
} from "../../state/worker-operation-registry.js";
import type { WorkerSessionTurnClaim, WorkerTurnClaimInput } from "./placement-record.js";
import { find, getRequired } from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import { createPlacementTurnClaimOps } from "./placement-turn-claims.js";
import type { PlacementTurnClaimReceipt } from "./placement-turn-claims.types.js";
import {
  createPlacementWorkspaceResultOps,
  recordStagedWorkerWorkspaceResult,
} from "./placement-workspace-result.js";

type ClaimInput = { claim: WorkerSessionTurnClaim; nowMs?: number };

function operation<
  Input extends {
    claim: { sessionId: string };
    nowMs?: number;
    gatewayInstanceId?: string;
    sessionEntryCurrentSource?: SessionEntryCurrentSource;
  },
>(
  type: string,
  execute: (runtime: PlacementStoreRuntime, input: Input) => PlacementTurnClaimReceipt,
  guardedWorkspaceWrite = false,
) {
  return (input: Input, { open }: WorkerOperationContext): PlacementTurnClaimReceipt => {
    const database = open();
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const source = guardedWorkspaceWrite ? input.sessionEntryCurrentSource : undefined;
        const admit = (stage: "transaction" | "commit", facts: unknown) =>
          requestSessionEntryCurrentAdmission(source, { stage, facts }, { lookup: "logical" });
        admit(
          "transaction",
          guardedWorkspaceWrite ? { placement: find(db, input.claim.sessionId) } : undefined,
        );
        const receipt = execute(
          {
            path: database.path,
            instanceId: input.gatewayInstanceId ?? "",
            now: () => input.nowMs ?? Date.now(),
            read: () => db,
            write: (write) => write(db),
          },
          input,
        );
        admit("commit", receipt);
        deferSqliteWorkerCommitReceipt(db, receipt);
        return receipt;
      },
      { database },
      { operationLabel: type },
    );
  };
}

export const placementTurnClaimOperations = {
  "placementTurns.claim": operation(
    "placementTurns.claim",
    (runtime, input: { claim: WorkerTurnClaimInput; nowMs?: number }) => {
      const claim = createPlacementTurnClaimOps(runtime).claimTurn(input.claim);
      return { claim, placement: getRequired(runtime.read(), claim.sessionId) };
    },
  ),
  "placementTurns.updateWorkspaceBaseManifest": operation(
    "placementTurns.updateWorkspaceBaseManifest",
    (
      runtime,
      input: ClaimInput & {
        manifestRef: string;
        sessionEntryCurrentSource?: SessionEntryCurrentSource;
      },
    ) => ({ placement: createPlacementTurnClaimOps(runtime).updateWorkspaceBaseManifest(input) }),
    true,
  ),
  "placementTurns.recordStagedResult": operation(
    "placementTurns.recordStagedResult",
    (
      runtime,
      input: ClaimInput & {
        stagedResultRef: string;
        repositoryWorkspaceId?: string;
        sessionEntryCurrentSource?: SessionEntryCurrentSource;
      },
    ) => {
      const db = runtime.read();
      recordStagedWorkerWorkspaceResult(
        db,
        input.claim,
        input.stagedResultRef,
        input.repositoryWorkspaceId,
      );
      return { placement: getRequired(db, input.claim.sessionId) };
    },
    true,
  ),
  "placementTurns.recoverWorkspace": operation(
    "placementTurns.recoverWorkspace",
    (runtime, input: ClaimInput & { gatewayInstanceId: string }) => {
      const results = createPlacementWorkspaceResultOps(runtime);
      results.markWorkspaceResultPending(input.claim);
      results.handoffWorkspaceResultRecovery(input.claim);
      return { placement: getRequired(runtime.read(), input.claim.sessionId) };
    },
  ),
  "placementTurns.handoffRuntimeRefreshResult": operation(
    "placementTurns.handoffRuntimeRefreshResult",
    (
      runtime,
      input: ClaimInput & { expectedGeneration: number; gatewayInstanceId: string; nowMs: number },
    ) => {
      const placement = getRequired(runtime.read(), input.claim.sessionId);
      if (
        placement.state !== "active" ||
        placement.generation !== input.expectedGeneration ||
        input.claim.owner.kind !== "worker"
      ) {
        throw new Error("Worker runtime refresh lost its workspace result owner");
      }
      createPlacementWorkspaceResultOps(runtime).handoffWorkspaceResultRecovery(input.claim);
      return { placement };
    },
  ),
  "placementTurns.releaseIfOwned": operation(
    "placementTurns.releaseIfOwned",
    (runtime, input: ClaimInput) => {
      const claims = createPlacementTurnClaimOps(runtime);
      return claims.validateTurnClaim(input.claim)
        ? { placement: claims.releaseTurn(input.claim) }
        : {};
    },
  ),
  "placementTurns.release": operation("placementTurns.release", (runtime, input: ClaimInput) => ({
    placement: createPlacementTurnClaimOps(runtime).releaseTurn(input.claim),
  })),
} satisfies WorkerOperationHandlers;
