import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isSqliteLockError } from "../../infra/sqlite-error-diagnostics.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import {
  isCurrentPlacementTurnClaim,
  type WorkerSessionTurnClaim,
  type WorkerSessionTurnOwner,
} from "./placement-record.js";
import {
  stagePlacementTurnClaimWorkerPublication,
  stagePlacementWorkspaceResultWorkerPublication,
} from "./placement-turn-authority.js";
import { prepareWorkerTurnClaimClosed } from "./placement-turn-claim-events.js";
import { ActiveTurnClaimError, type createPlacementTurnClaimOps } from "./placement-turn-claims.js";
import type {
  PlacementTurnClaimReceipt,
  PlacementTurnClaimWorkerOperations,
} from "./placement-turn-claims.worker-contract.js";

const log = createSubsystemLogger("gateway/placement");

type Claims = ReturnType<typeof createPlacementTurnClaimOps>;

function isReceipt(value: unknown): value is PlacementTurnClaimReceipt {
  return (
    isRecord(value) &&
    (value.placement === undefined ||
      (isRecord(value.placement) &&
        typeof value.placement.sessionId === "string" &&
        typeof value.placement.agentId === "string" &&
        typeof value.placement.sessionKey === "string")) &&
    (value.claim === undefined ||
      (isRecord(value.claim) && typeof value.claim.claimId === "string"))
  );
}

export function createPlacementTurnClaimWorkerOps(runtime: {
  path: string;
  instanceId: string;
  now?: () => number;
}) {
  const context = captureOpenClawStateWorkerContext({ path: runtime.path });
  async function execute(
    input: SqliteWorkerCommand<PlacementTurnClaimWorkerOperations>,
    assertCurrent?: () => void,
  ): Promise<PlacementTurnClaimReceipt> {
    const requested = input.input.claim;
    const owner: WorkerSessionTurnOwner =
      requested.owner.kind === "local"
        ? {
            kind: "local",
            environmentId: requested.owner.environmentId,
            ownerEpoch: requested.owner.ownerEpoch,
          }
        : {
            kind: "worker",
            environmentId: requested.owner.environmentId,
            ownerEpoch: requested.owner.ownerEpoch,
          };
    const claim = {
      sessionId: requested.sessionId,
      claimId: requested.claimId,
      runId: requested.runId,
      owner,
    };
    const command: SqliteWorkerCommand<PlacementTurnClaimWorkerOperations> =
      input.type === "placementTurns.claim"
        ? {
            type: input.type,
            input: {
              nowMs: input.input.nowMs,
              claim: {
                ...claim,
                agentId: input.input.claim.agentId,
                sessionKey: input.input.claim.sessionKey,
              },
            },
          }
        : input.type === "placementTurns.recordStagedResult"
          ? {
              type: input.type,
              input: {
                claim: { ...claim, placementGeneration: input.input.claim.placementGeneration },
                stagedResultRef: input.input.stagedResultRef,
                repositoryWorkspaceId: input.input.repositoryWorkspaceId,
              },
            }
          : input.type === "placementTurns.recoverWorkspace"
            ? {
                type: input.type,
                input: {
                  nowMs: input.input.nowMs,
                  gatewayInstanceId: input.input.gatewayInstanceId,
                  claim: { ...claim, placementGeneration: input.input.claim.placementGeneration },
                },
              }
            : input.type === "placementTurns.handoffRuntimeRefreshResult"
              ? {
                  type: input.type,
                  input: {
                    nowMs: input.input.nowMs,
                    claim: { ...claim, placementGeneration: input.input.claim.placementGeneration },
                    expectedGeneration: input.input.expectedGeneration,
                    gatewayInstanceId: input.input.gatewayInstanceId,
                  },
                }
              : {
                  type: input.type,
                  input: {
                    nowMs: input.input.nowMs,
                    claim: { ...claim, placementGeneration: input.input.claim.placementGeneration },
                  },
                };
    const close =
      command.type === "placementTurns.release" || command.type === "placementTurns.releaseIfOwned"
        ? prepareWorkerTurnClaimClosed(runtime.path, command.input.claim)
        : undefined;
    let reportedContention = false;
    for (;;) {
      let admission: SqliteWorkerOperationAdmission | undefined;
      let publication: ReturnType<typeof stagePlacementTurnClaimWorkerPublication> | undefined;
      let entered = false;
      let granted = false;
      let prepared: PlacementTurnClaimReceipt | undefined;
      let published = false;
      const check = () => {
        context.admission.assertCurrent();
        assertCurrent?.();
      };
      const publish = (receipt: PlacementTurnClaimReceipt) => {
        if (!published) {
          published = true;
          publication?.commit();
          if (receipt.placement) {
            close?.();
            sessionChanges.emit({
              agentId: receipt.placement.agentId,
              sessionKey: receipt.placement.sessionKey,
            });
          }
        }
        return receipt;
      };
      try {
        return await runOpenClawStateWorkerOperation(
          context,
          async (scope) => publish(await scope.execute(command)),
          {
            assertCurrent: check,
            createAdmission: () => {
              admission = createSqliteWorkerOperationAdmission((request, grant) => {
                check();
                if (request.stage === "commit") {
                  if (!isReceipt(request.facts)) {
                    throw new Error("Placement claim commit has no receipt");
                  }
                  prepared = request.facts;
                  if (command.type === "placementTurns.recordStagedResult") {
                    if (request.facts.placement?.sessionId !== command.input.claim.sessionId) {
                      throw new Error("Staged workspace result receipt has a different owner");
                    }
                    publication = stagePlacementWorkspaceResultWorkerPublication(
                      context.admission.identity,
                      request.facts.placement.sessionId,
                    );
                  } else if (request.facts.placement) {
                    publication = stagePlacementTurnClaimWorkerPublication(
                      context.admission.identity,
                      request.facts.placement,
                    );
                  }
                }
                if (!grant()) {
                  publication?.rollback();
                  throw new Error("Placement claim admission expired");
                }
                entered ||= request.stage === "transaction";
                granted ||= request.stage === "commit";
              });
              return { nativeLocations: [runtime.path], admission };
            },
          },
        );
      } catch (error) {
        const committed = admission?.committed ?? admission?.settlement?.committed;
        if (committed && isReceipt(committed.facts)) {
          // A committed claim must reach its caller so ordinary settlement can release it.
          return publish(committed.facts);
        }
        if (!granted || admission?.settlement?.kind === "completed") {
          publication?.rollback();
        } else if (
          command.type === "placementTurns.handoffRuntimeRefreshResult" ||
          command.type === "placementTurns.recordStagedResult"
        ) {
          // An uncertain result write requires fresh recovery authority; never replay it.
          publication?.invalidate();
        } else {
          if (command.type === "placementTurns.recoverWorkspace") {
            // An unchanged claim does not prove its result fence committed. Recovery
            // rereads pending results on the next pass; never release an uncertain owner.
            publication?.rollback();
            throw error;
          }
          // Native settlement precedes readback. Never replay an uncertain claim or release.
          const reply = await (async () => {
            try {
              context.admission.assertCurrent();
              return await executeExistingOpenClawStateRead(
                { path: runtime.path },
                {
                  type: "workers.placementProjection",
                  sessionIds: [command.input.claim.sessionId],
                  conflictBindings: [],
                },
                { current: true },
              );
            } catch (readError) {
              if (command.type === "placementTurns.claim" && prepared?.claim) {
                try {
                  await execute({
                    type: "placementTurns.releaseIfOwned",
                    input: { claim: prepared.claim, nowMs: runtime.now?.() },
                  });
                  publication?.rollback();
                } catch (cleanupError) {
                  throw new AggregateError(
                    [error, readError, cleanupError],
                    "Placement turn claim custody could not be settled; restart recovery is required",
                    { cause: cleanupError },
                  );
                }
              }
              throw new AggregateError(
                [error, readError],
                "Placement turn outcome readback failed",
                { cause: readError },
              );
            }
          })();
          context.admission.assertCurrent();
          if (!reply?.ok || reply.type !== "workers.placementProjection") {
            throw error;
          }
          const placement = reply.result.projection.placements.get(command.input.claim.sessionId);
          if (
            command.type === "placementTurns.claim"
              ? placement &&
                prepared?.claim &&
                isCurrentPlacementTurnClaim(placement, prepared.claim)
              : !placement || !isCurrentPlacementTurnClaim(placement, command.input.claim)
          ) {
            if (prepared) {
              return publish(prepared);
            }
          }
          publication?.rollback();
        }
        if (
          command.type === "placementTurns.releaseIfOwned" &&
          !entered &&
          !granted &&
          admission?.settlement?.kind !== "unknown" &&
          isSqliteLockError(error)
        ) {
          // The worker never admitted a commit. Keep this exact cleanup owner alive;
          // SQLite waits in the worker before every new transaction attempt.
          // Never replay startup, a claim, an uncertain write, or a replaced database.
          context.admission.assertCurrent();
          if (!reportedContention) {
            reportedContention = true;
            log.warn("Turn claim release is waiting for the state database", {
              sessionId: claim.sessionId,
              runId: claim.runId,
              error,
            });
          }
          continue;
        }
        if (error instanceof Error && error.name === "ActiveTurnClaimError") {
          throw new ActiveTurnClaimError(command.input.claim.sessionId);
        }
        throw error;
      }
    }
  }
  return {
    async recordStagedWorkspaceResult(
      claim: WorkerSessionTurnClaim,
      stagedResultRef: string,
      repositoryWorkspaceId?: string,
      assertCurrent?: () => void,
    ): Promise<void> {
      await execute(
        {
          type: "placementTurns.recordStagedResult",
          input: { claim, stagedResultRef, repositoryWorkspaceId },
        },
        assertCurrent,
      );
    },
    async retainInterruptedTurnWorkspace(
      claim: Parameters<Claims["releaseTurn"]>[0],
      assertCurrent: () => void,
    ) {
      await execute(
        {
          type: "placementTurns.recoverWorkspace",
          input: { claim, gatewayInstanceId: runtime.instanceId, nowMs: runtime.now?.() },
        },
        assertCurrent,
      );
    },
    async handoffRuntimeRefreshResult(
      input: Omit<
        PlacementTurnClaimWorkerOperations["placementTurns.handoffRuntimeRefreshResult"]["input"],
        "nowMs"
      >,
      assertCurrent?: () => void,
    ) {
      const receipt = await execute(
        {
          type: "placementTurns.handoffRuntimeRefreshResult",
          input: { ...input, nowMs: runtime.now?.() ?? Date.now() },
        },
        assertCurrent,
      );
      if (!receipt.placement) {
        throw new Error("Worker runtime refresh handoff receipt is missing its placement");
      }
      return receipt.placement;
    },
    async claimTurn(input: Parameters<Claims["claimTurn"]>[0], assertCurrent?: () => void) {
      const receipt = await execute(
        { type: "placementTurns.claim", input: { claim: input, nowMs: runtime.now?.() } },
        assertCurrent,
      );
      if (!receipt.claim) {
        throw new Error("Placement turn claim receipt is missing its claim");
      }
      return receipt.claim;
    },
    async releaseTurn(claim: Parameters<Claims["releaseTurn"]>[0], assertCurrent?: () => void) {
      const receipt = await execute(
        { type: "placementTurns.release", input: { claim, nowMs: runtime.now?.() } },
        assertCurrent,
      );
      if (!receipt.placement) {
        throw new Error("Placement turn release receipt is missing its placement");
      }
      return receipt.placement;
    },
    async releaseTurnIfOwned(claim: Parameters<Claims["releaseTurn"]>[0]) {
      await execute({
        type: "placementTurns.releaseIfOwned",
        input: { claim, nowMs: runtime.now?.() },
      });
    },
  };
}
