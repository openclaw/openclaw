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
import type { WorkerSessionPlacementState } from "./placement-state.js";
import {
  stagePlacementTurnClaimWorkerPublication,
  stagePlacementWorkspaceResultWorkerPublication,
} from "./placement-turn-authority.js";
import { prepareWorkerTurnClaimClosed } from "./placement-turn-claim-events.js";
import { ActiveTurnClaimError, type createPlacementTurnClaimOps } from "./placement-turn-claims.js";
import type {
  PlacementAckCursorInput,
  PlacementTurnClaimCurrentCheck,
  PlacementTurnClaimReceipt,
} from "./placement-turn-claims.types.js";
import type { PlacementTurnClaimWorkerOperations } from "./placement-turn-claims.worker-contract.js";
import { createPlacementWorkerMutation } from "./placement-worker-mutation.js";
import type { WorkerWorkspacePendingResult } from "./placement-workspace-result.types.js";
import { reserveWorkerEnvironmentNativePublication } from "./store-native-publication.js";
import { boundedWorkerError } from "./worker-error.js";
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
      (isRecord(value.claim) && typeof value.claim.claimId === "string")) &&
    (value.closedClaim === undefined ||
      (isRecord(value.closedClaim) && typeof value.closedClaim.claimId === "string")) &&
    (value.environmentActivation === undefined ||
      (isRecord(value.environmentActivation) &&
        typeof value.environmentActivation.environmentId === "string" &&
        typeof value.environmentActivation.lastActivatedAtMs === "number"))
  );
}

function requirePlacement(receipt: PlacementTurnClaimReceipt, operation: string) {
  if (!receipt.placement) {
    throw new Error(`${operation} receipt is missing its placement`);
  }
  return receipt.placement;
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
    beforePublish?: (claim: WorkerSessionTurnClaim) => void,
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
    const sessionId =
      "claim" in input.input
        ? input.input.claim.sessionId
        : "pending" in input.input
          ? input.input.pending.sessionId
          : input.input.sessionId;
    if ("claim" in command.input) {
      const { claimId, runId, owner: requestedOwner } = command.input.claim;
      const { kind, environmentId, ownerEpoch } = requestedOwner;
      const owner: typeof requestedOwner =
        kind === "local"
          ? { kind, environmentId, ownerEpoch }
          : { kind, environmentId, ownerEpoch };
      // Host callers may carry authority callbacks; only claim data crosses the worker boundary.
      const claim = { sessionId, claimId, runId, owner };
      if (
        command.type === "placementTurns.claim" ||
        command.type === "placementTurns.claimReclaimResult" ||
        command.type === "placementTurns.claimMutationResult"
      ) {
        const { agentId, sessionKey } = command.input.claim;
        command.input = { ...command.input, claim: { ...claim, agentId, sessionKey } };
      } else {
        const { placementGeneration } = command.input.claim;
        command.input = { ...command.input, claim: { ...claim, placementGeneration } };
      }
    } else {
      command.input = structuredClone(command.input);
    }
    if (
      command.type === "placementTurns.recordStagedResult" ||
      command.type === "placementTurns.updateWorkspaceBaseManifest" ||
      command.type === "placementTurns.claimMutationResult" ||
      command.type === "placementTurns.acceptResult" ||
      command.type === "placementTurns.completeResult"
    ) {
      command.input = { ...command.input, sessionEntryCurrentSource: capturedEntryCheck?.source };
    }
    let close =
      command.type === "placementTurns.release" ||
      command.type === "placementTurns.releaseIfOwned" ||
      command.type === "placementTurns.completeResult" ||
      command.type === "placementTurns.cancelResult"
        ? prepareWorkerTurnClaimClosed(runtime.path, command.input.claim)
        : undefined;
    let reportedContention = false;
    for (;;) {
      let prepared: PlacementTurnClaimReceipt | undefined;
      let previousState: WorkerSessionPlacementState | null | undefined;
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
          if (!isReceipt(admitted.facts)) {
            throw new Error("Placement admission has no current placement facts");
          }
          if (request.stage === "transaction") {
            previousState = admitted.facts.placement ? admitted.facts.placement.state : null;
          }
          current?.assertPlacementCurrent(admitted.facts.placement, admitted.facts.placementMove);
          return admitted.facts;
        },
        readReceipt: (facts) => (isReceipt(facts) ? facts : undefined),
        stageCommit(facts) {
          if (!isReceipt(facts)) {
            throw new Error("Placement claim commit has no receipt");
          }
          prepared = facts;
          if (command.type === "placementTurns.releaseIfOwned" && !facts.placement) {
            return undefined;
          }
          if (facts.claim) {
            beforePublish?.(facts.claim);
          }
          const workspaceOnly =
            command.type === "placementTurns.updateAckCursors" ||
            command.type === "placementTurns.recordStagedResult" ||
            command.type === "placementTurns.updateWorkspaceBaseManifest" ||
            command.type === "placementTurns.markResultPending" ||
            command.type === "placementTurns.acceptResult" ||
            command.type === "placementTurns.handoffResult" ||
            command.type === "placementTurns.abandonResult";
          if (facts.placement && facts.placement.sessionId !== sessionId) {
            throw new Error("Workspace result receipt has a different owner");
          }
          if (facts.closedClaim) {
            if (facts.closedClaim.sessionId !== sessionId) {
              throw new Error("Placement closure receipt has a different owner");
            }
            close = prepareWorkerTurnClaimClosed(runtime.path, facts.closedClaim);
          }
          const resultFacts =
            facts.placement && facts.workspaceResult !== undefined
              ? { placement: facts.placement, pendingResult: facts.workspaceResult ?? undefined }
              : undefined;
          const activation = facts.environmentActivation;
          if (
            activation &&
            (facts.placement?.state !== "active" ||
              facts.placement.environmentId !== activation.environmentId)
          ) {
            throw new Error("Placement activation receipt has a different environment owner");
          }
          const publication =
            facts.placement && !workspaceOnly
              ? stagePlacementTurnClaimWorkerPublication(
                  context.admission.identity,
                  facts.placement,
                  resultFacts,
                  previousState,
                )
              : stagePlacementWorkspaceResultWorkerPublication(
                  context.admission.identity,
                  sessionId,
                  resultFacts,
                );
          if (!activation) {
            return publication;
          }
          const publishEnvironment = reserveWorkerEnvironmentNativePublication(
            context.admission.identity,
          );
          return {
            ...publication,
            commit() {
              publishEnvironment?.(activation.environmentId, {
                lastActivatedAtMs: activation.lastActivatedAtMs,
              });
              publication.commit();
            },
          };
        },
        publish(receipt) {
          if (published) {
            return;
          }
          published = true;
          if (receipt.placement) {
            close?.();
            if (receipt.environmentActivation) {
              sessionChanges.emit({ all: true, scope: "worker-environments" });
            }
            const notifySession =
              command.type !== "placementTurns.transition" &&
              command.type !== "placementTurns.startReconcile" &&
              command.type !== "placementTurns.fail" &&
              (command.type !== "placementTurns.startDrain" ||
                command.input.workspaceBaseManifestRef !== undefined);
            if (notifySession) {
              sessionChanges.emit({
                agentId: receipt.placement.agentId,
                sessionKey: receipt.placement.sessionKey,
              });
            }
          }
        },
        async recoverUnknown(error, publication) {
          if (
            command.type !== "placementTurns.claim" &&
            command.type !== "placementTurns.release" &&
            command.type !== "placementTurns.releaseIfOwned"
          ) {
            publication?.invalidate();
            throw new AcceptedWorkspacePublicationIndeterminateError(
              "commit",
              error,
              new Error("Workspace result settlement is unavailable"),
            );
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
          throw new ActiveTurnClaimError(sessionId);
        }
        throw error;
      }
    }
  }
  return {
    async completeUnreadyRepositoryTurn(claim: WorkerSessionTurnClaim, assertCurrent: () => void) {
      const receipt = await execute(
        {
          type: "placementTurns.completeUnreadyRepositoryTurn",
          input: { claim, nowMs: runtime.now?.() },
        },
        assertCurrent,
      );
      return receipt.placement?.workspaceBaseManifestRef === null;
    },
    async settleRepository(
      input: Omit<
        PlacementTurnClaimWorkerOperations["placementTurns.settleRepository"]["input"],
        "nowMs"
      >,
      assertCurrent: () => void,
    ) {
      const receipt = await execute(
        { type: "placementTurns.settleRepository", input: { ...input, nowMs: runtime.now?.() } },
        assertCurrent,
      );
      return requirePlacement(receipt, "Repository readiness");
    },
    async transition(
      input: Omit<
        PlacementTurnClaimWorkerOperations["placementTurns.transition"]["input"],
        "nowMs"
      >,
      assertCurrent?: () => void,
    ) {
      const receipt = await execute(
        { type: "placementTurns.transition", input: { ...input, nowMs: runtime.now?.() } },
        assertCurrent,
      );
      return requirePlacement(receipt, "Placement transition");
    },
    async startDrain(
      input: Omit<
        PlacementTurnClaimWorkerOperations["placementTurns.startDrain"]["input"],
        "nowMs"
      >,
      assertCurrent?: () => void,
    ) {
      const receipt = await execute(
        { type: "placementTurns.startDrain", input: { ...input, nowMs: runtime.now?.() } },
        assertCurrent,
      );
      return requirePlacement(receipt, "Placement drain");
    },
    async startReconcile(
      input: Omit<
        PlacementTurnClaimWorkerOperations["placementTurns.startReconcile"]["input"],
        "nowMs"
      >,
      assertCurrent?: () => void,
    ) {
      const receipt = await execute(
        { type: "placementTurns.startReconcile", input: { ...input, nowMs: runtime.now?.() } },
        assertCurrent,
      );
      return requirePlacement(receipt, "Placement reconciliation");
    },
    async fail(
      input: Omit<PlacementTurnClaimWorkerOperations["placementTurns.fail"]["input"], "nowMs">,
      assertCurrent?: () => void,
    ) {
      const receipt = await execute(
        { type: "placementTurns.fail", input: { ...input, nowMs: runtime.now?.() } },
        assertCurrent,
      );
      return requirePlacement(receipt, "Placement failure");
    },
    async failWorkspaceResultAndReleaseTurn(
      pending: WorkerWorkspacePendingResult,
      error: unknown,
      assertCurrent?: () => void,
    ) {
      const receipt = await execute(
        {
          type: "placementTurns.failResult",
          input: { pending, recoveryError: boundedWorkerError(error), nowMs: runtime.now?.() },
        },
        assertCurrent,
      );
      return requirePlacement(receipt, "Workspace result failure");
    },
    async claimReclaimWorkspaceResult(
      input: Parameters<Claims["claimReclaimWorkspaceResult"]>[0],
      beforePublish?: (claim: WorkerSessionTurnClaim) => void,
      assertCurrent?: () => void,
    ) {
      const receipt = await execute(
        {
          type: "placementTurns.claimReclaimResult",
          input: { claim: input, gatewayInstanceId: runtime.instanceId, nowMs: runtime.now?.() },
        },
        assertCurrent,
        undefined,
        beforePublish,
      );
      if (!receipt.claim) {
        throw new Error("Workspace result claim receipt is missing its claim");
      }
      return receipt.claim;
    },
    async claimWorkspaceMutationResult(
      input: Parameters<Claims["claimWorkspaceMutationResult"]>[0],
      assertCurrent?: () => void,
      current?: PlacementTurnClaimCurrentCheck,
    ) {
      const receipt = await execute(
        {
          type: "placementTurns.claimMutationResult",
          input: {
            claim: { ...input, runId: input.claimId },
            gatewayInstanceId: runtime.instanceId,
            nowMs: runtime.now?.(),
          },
        },
        assertCurrent,
        current,
      );
      if (!receipt.claim) {
        throw new Error("Workspace result claim receipt is missing its claim");
      }
      return receipt.claim;
    },
    async markWorkspaceResultPending(claim: WorkerSessionTurnClaim, assertCurrent?: () => void) {
      await execute(
        {
          type: "placementTurns.markResultPending",
          input: { claim, gatewayInstanceId: runtime.instanceId, nowMs: runtime.now?.() },
        },
        assertCurrent,
      );
    },
    async acceptWorkspaceResult(
      claim: WorkerSessionTurnClaim,
      assertCurrent?: () => void,
      current?: PlacementTurnClaimCurrentCheck,
    ) {
      await execute(
        { type: "placementTurns.acceptResult", input: { claim, nowMs: runtime.now?.() } },
        assertCurrent,
        current,
      );
    },
    async handoffWorkspaceResultRecovery(
      claim: WorkerSessionTurnClaim,
      assertCurrent?: () => void,
    ) {
      await execute(
        {
          type: "placementTurns.handoffResult",
          input: { claim, gatewayInstanceId: runtime.instanceId, nowMs: runtime.now?.() },
        },
        assertCurrent,
      );
    },
    async abandonWorkspaceResult(
      pending: WorkerWorkspacePendingResult,
      assertCurrent?: () => void,
    ) {
      await execute({ type: "placementTurns.abandonResult", input: { pending } }, assertCurrent);
    },
    async startWorkspaceResultDrain(claim: WorkerSessionTurnClaim, assertCurrent?: () => void) {
      const receipt = await execute(
        { type: "placementTurns.drainResult", input: { claim, nowMs: runtime.now?.() } },
        assertCurrent,
      );
      return requirePlacement(receipt, "Workspace result drain");
    },
    async completeWorkspaceResultAndReleaseTurn(
      claim: WorkerSessionTurnClaim,
      assertCurrent?: () => void,
      current?: PlacementTurnClaimCurrentCheck,
    ) {
      const receipt = await execute(
        { type: "placementTurns.completeResult", input: { claim, nowMs: runtime.now?.() } },
        assertCurrent,
        current,
      );
      return requirePlacement(receipt, "Workspace result completion");
    },
    async cancelWorkspaceResultAndReleaseTurn(
      claim: WorkerSessionTurnClaim,
      options?: { reason: "node-disconnect" },
      assertCurrent?: () => void,
    ) {
      const receipt = await execute(
        {
          type: "placementTurns.cancelResult",
          input: {
            claim,
            reason: options?.reason,
            gatewayInstanceId: runtime.instanceId,
            nowMs: runtime.now?.(),
          },
        },
        assertCurrent,
      );
      return requirePlacement(receipt, "Workspace result cancellation");
    },
    async updateAckCursors(input: PlacementAckCursorInput, assertCurrent?: () => void) {
      const receipt = await execute(
        {
          type: "placementTurns.updateAckCursors",
          input: { ...input, gatewayInstanceId: runtime.instanceId, nowMs: runtime.now?.() },
        },
        assertCurrent,
        {
          assertPlacementCurrent(placement) {
            if (!placement || !isCurrentPlacementTurnClaim(placement, input.claim)) {
              throw new Error(`Cannot ACK stale worker turn for session ${input.claim.sessionId}`);
            }
          },
        },
      );
      return requirePlacement(receipt, "Worker ACK");
    },
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
      return requirePlacement(receipt, "Workspace journal commit");
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
      return requirePlacement(receipt, "Worker runtime refresh handoff");
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
      return requirePlacement(receipt, "Placement turn release");
    },
    async releaseTurnIfOwned(claim: Parameters<Claims["releaseTurn"]>[0]) {
      await execute({
        type: "placementTurns.releaseIfOwned",
        input: { claim, nowMs: runtime.now?.() },
      });
    },
  };
}
