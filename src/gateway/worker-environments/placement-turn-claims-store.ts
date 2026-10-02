import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assertSessionEntryCurrentAdmission } from "../../config/sessions/session-entry-current-admission.js";
import type { SessionEntryCurrentFacts } from "../../config/sessions/session-entry-current.types.js";
import { isSqliteLockError } from "../../infra/sqlite-error-diagnostics.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { isCurrentPlacementTurnClaim, type WorkerSessionTurnClaim } from "./placement-record.js";
import {
  stagePlacementTurnClaimWorkerPublication,
  stagePlacementWorkspaceResultWorkerPublication,
} from "./placement-turn-authority.js";
import { prepareWorkerTurnClaimClosed } from "./placement-turn-claim-events.js";
import { ActiveTurnClaimError, type createPlacementTurnClaimOps } from "./placement-turn-claims.js";
import type {
  PlacementTurnClaimCurrentCheck,
  PlacementTurnClaimReceipt,
} from "./placement-turn-claims.types.js";
import type { PlacementTurnClaimWorkerOperations } from "./placement-turn-claims.worker-contract.js";
import { createPlacementWorkerMutation } from "./placement-worker-mutation.js";
import { AcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";

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
    current?: PlacementTurnClaimCurrentCheck,
  ): Promise<PlacementTurnClaimReceipt> {
    const entryCheck = current?.sessionEntry;
    const capturedEntryCheck = entryCheck
      ? {
          source: { ...entryCheck.source },
          assertCurrent: (facts: SessionEntryCurrentFacts | undefined) =>
            entryCheck.assertCurrent(facts),
        }
      : undefined;
    const command = { ...input };
    const { sessionId, claimId, runId, owner: requestedOwner } = input.input.claim;
    const { kind, environmentId, ownerEpoch } = requestedOwner;
    const owner: typeof requestedOwner =
      kind === "local" ? { kind, environmentId, ownerEpoch } : { kind, environmentId, ownerEpoch };
    // Host callers may carry authority callbacks; only claim data crosses the worker boundary.
    const claim = { sessionId, claimId, runId, owner };
    if (command.type === "placementTurns.claim") {
      const { agentId, sessionKey } = command.input.claim;
      command.input = { ...command.input, claim: { ...claim, agentId, sessionKey } };
    } else {
      const { placementGeneration } = command.input.claim;
      command.input = { ...command.input, claim: { ...claim, placementGeneration } };
    }
    if (
      command.type === "placementTurns.recordStagedResult" ||
      command.type === "placementTurns.updateWorkspaceBaseManifest"
    ) {
      command.input = { ...command.input, sessionEntryCurrentSource: capturedEntryCheck?.source };
    }
    const close =
      command.type === "placementTurns.release" || command.type === "placementTurns.releaseIfOwned"
        ? prepareWorkerTurnClaimClosed(runtime.path, command.input.claim)
        : undefined;
    let reportedContention = false;
    for (;;) {
      let prepared: PlacementTurnClaimReceipt | undefined;
      let published = false;
      const mutation = createPlacementWorkerMutation({
        context,
        label: "Placement claim",
        nativeLocation: runtime.path,
        assertCurrent,
        admissionFacts(request) {
          if (request.stage !== "transaction" && request.stage !== "commit") {
            return request.facts;
          }
          const admitted = assertSessionEntryCurrentAdmission(request, capturedEntryCheck);
          if (current) {
            if (!isReceipt(admitted.facts)) {
              throw new Error("Placement admission has no current placement facts");
            }
            current.assertPlacementCurrent(admitted.facts.placement);
          }
          return admitted.facts;
        },
        readReceipt: (facts) => (isReceipt(facts) ? facts : undefined),
        stageCommit(facts) {
          if (!isReceipt(facts)) {
            throw new Error("Placement claim commit has no receipt");
          }
          prepared = facts;
          if (
            command.type === "placementTurns.recordStagedResult" ||
            command.type === "placementTurns.updateWorkspaceBaseManifest"
          ) {
            if (facts.placement?.sessionId !== command.input.claim.sessionId) {
              throw new Error("Staged workspace result receipt has a different owner");
            }
            return stagePlacementWorkspaceResultWorkerPublication(
              context.admission.identity,
              facts.placement.sessionId,
            );
          }
          return facts.placement
            ? stagePlacementTurnClaimWorkerPublication(context.admission.identity, facts.placement)
            : undefined;
        },
        publish(receipt) {
          if (published) {
            return;
          }
          published = true;
          if (receipt.placement) {
            close?.();
            sessionChanges.emit({
              agentId: receipt.placement.agentId,
              sessionKey: receipt.placement.sessionKey,
            });
          }
        },
        async recoverUnknown(error, publication) {
          if (
            command.type === "placementTurns.handoffRuntimeRefreshResult" ||
            command.type === "placementTurns.recordStagedResult" ||
            command.type === "placementTurns.updateWorkspaceBaseManifest"
          ) {
            // An uncertain result write requires fresh recovery authority; never replay it.
            publication?.invalidate();
            if (command.type === "placementTurns.updateWorkspaceBaseManifest") {
              // An unobserved commit cannot authorize an inverse filesystem apply.
              throw new AcceptedWorkspacePublicationIndeterminateError(
                "commit",
                error,
                new Error("Workspace journal commit settlement is unavailable"),
              );
            }
            return undefined;
          }
          if (command.type === "placementTurns.recoverWorkspace") {
            // An unchanged claim does not prove its result fence committed. Recovery
            // rereads pending results on the next pass; never release an uncertain owner.
            publication?.rollback();
            return undefined;
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
              return prepared;
            }
          }
          publication?.rollback();
          return undefined;
        },
      });
      try {
        return await mutation.run((scope) => scope.execute(command));
      } catch (error) {
        if (
          command.type === "placementTurns.releaseIfOwned" &&
          !mutation.transactionGranted &&
          !mutation.commitGranted &&
          mutation.settlement?.kind !== "unknown" &&
          isSqliteLockError(error)
        ) {
          // The worker never admitted a commit. Keep this exact cleanup owner alive;
          // SQLite waits in the worker before every new transaction attempt.
          // Never replay startup, a claim, an uncertain write, or a replaced database.
          context.admission.assertCurrent();
          if (!reportedContention) {
            reportedContention = true;
            log.warn("Turn claim release is waiting for the state database", {
              sessionId: command.input.claim.sessionId,
              runId: command.input.claim.runId,
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
    async updateWorkspaceBaseManifest(
      input: Parameters<Claims["updateWorkspaceBaseManifest"]>[0],
      assertCurrent?: () => void,
      current?: PlacementTurnClaimCurrentCheck,
    ) {
      const receipt = await execute(
        {
          type: "placementTurns.updateWorkspaceBaseManifest",
          input: { ...input, nowMs: runtime.now?.() },
        },
        assertCurrent,
        current,
      );
      if (!receipt.placement) {
        throw new Error("Workspace journal commit receipt is missing its placement");
      }
      return receipt.placement;
    },
    async recordStagedWorkspaceResult(
      claim: WorkerSessionTurnClaim,
      stagedResultRef: string,
      repositoryWorkspaceId?: string,
      assertCurrent?: () => void,
      current?: PlacementTurnClaimCurrentCheck,
    ): Promise<void> {
      await execute(
        {
          type: "placementTurns.recordStagedResult",
          input: { claim, stagedResultRef, repositoryWorkspaceId },
        },
        assertCurrent,
        current,
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
      {
        claim,
        expectedGeneration,
        gatewayInstanceId,
      }: Omit<
        PlacementTurnClaimWorkerOperations["placementTurns.handoffRuntimeRefreshResult"]["input"],
        "nowMs"
      >,
      assertCurrent?: () => void,
    ) {
      const receipt = await execute(
        {
          type: "placementTurns.handoffRuntimeRefreshResult",
          input: {
            claim,
            expectedGeneration,
            gatewayInstanceId,
            nowMs: runtime.now?.() ?? Date.now(),
          },
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
