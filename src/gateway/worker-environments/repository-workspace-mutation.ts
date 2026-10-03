import { randomUUID } from "node:crypto";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { captureSessionEntryCurrentRead } from "../../config/sessions/session-entry-current-runtime.js";
import type { SessionEntryCurrentFacts } from "../../config/sessions/session-entry-current.types.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import { isCurrentActiveWorkerEnvironment } from "./placement-dispatch-failure.js";
import {
  placementTurnOwner,
  type WorkerSessionPlacementIdentity,
  type WorkerSessionPlacementRecord,
} from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import type { PlacementTurnClaimCurrentCheck } from "./placement-turn-claims.types.js";
import type { WorkerEnvironmentService } from "./service.js";
import {
  createWorkerWorkspaceReconcileRequest,
  type WorkerSessionWorkspace,
} from "./session-workspace.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import type { WorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import {
  createWorkspaceResultJournal,
  settleStagedWorkspaceResult,
} from "./workspace-result-settlement.js";
import { workerWorkspaceResultRef } from "./workspace-result-staging.js";

export function createRepositoryWorkspaceMutationService(options: {
  placements: WorkerSessionPlacementStore;
  environments: Pick<WorkerEnvironmentService, "get" | "startTunnel">;
  workspaceOperations: WorkerWorkspaceOperationCoordinator;
  resolveWorkspace: (identity: WorkerSessionPlacementIdentity) => Promise<WorkerSessionWorkspace>;
}) {
  const { placements, environments } = options;
  return {
    async mutate<T>(
      params: WorkerSessionPlacementIdentity & {
        assertCurrent: () => void;
        assertEntryCurrent?: (entry: SessionEntryCurrentFacts | undefined) => void;
        mutate: (assertCurrent: () => void) => Promise<{ changed: boolean; value: T }>;
      },
    ): Promise<T> {
      params.assertCurrent();
      const placement = placements.get(params.sessionId);
      if (placement?.state !== "active") {
        throw new Error("Repository workspace editing requires an active cloud placement");
      }
      return await options.workspaceOperations.run(placement.environmentId, async () => {
        params.assertCurrent();
        const workspace = await options.resolveWorkspace(params);
        if (workspace.kind !== "repository") {
          throw new Error("Session no longer owns a cloud repository workspace");
        }
        const environment = environments.get(placement.environmentId);
        if (!isCurrentActiveWorkerEnvironment(placement, environment)) {
          throw new Error("Repository workspace environment is no longer current");
        }
        const storePath = resolveSessionStorePathForScope(params);
        const scope = {
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          storePath,
        };
        const assertEntryCurrent = (entry: SessionEntryCurrentFacts | undefined) => {
          params.assertEntryCurrent?.(entry);
          if (
            entry?.sessionId !== params.sessionId ||
            entry.repositoryWorkspaceId !== workspace.repository.workspaceId ||
            workspace.repository.agentId !== params.agentId ||
            workspace.repository.sessionKey !== params.sessionKey
          ) {
            throw new Error("Repository workspace edit lost its exact session placement owner");
          }
        };
        const currentEntry = await withSessionEntryReadOnlyInWorker(
          scope,
          params.assertCurrent,
          async (read, owner) => {
            if (!read.ok) {
              throw toErrorObject(read.error, "Repository workspace session read failed");
            }
            assertEntryCurrent(read.value);
            return captureSessionEntryCurrentRead(scope, owner);
          },
        );
        const assertPlacementCurrent = (current: WorkerSessionPlacementRecord | undefined) => {
          const currentEnvironment = environments.get(placement.environmentId);
          if (
            current?.state !== "active" ||
            current.agentId !== params.agentId ||
            current.sessionKey !== params.sessionKey ||
            current.generation !== placement.generation ||
            current.environmentId !== placement.environmentId ||
            current.activeOwnerEpoch !== placement.activeOwnerEpoch ||
            current.remoteWorkspaceDir !== placement.remoteWorkspaceDir ||
            !isCurrentActiveWorkerEnvironment(current, currentEnvironment) ||
            currentEnvironment?.leaseId !== environment?.leaseId
          ) {
            throw new Error("Repository workspace edit lost its exact session placement owner");
          }
        };
        const assertWorkerCurrent = () => {
          params.assertCurrent();
          currentEntry.assertSourceCurrent();
          // Native entries have a commit projection; FILE rows come from the worker's grant.
          if (currentEntry.kind !== "file") {
            assertEntryCurrent(currentEntry.readCurrent());
          }
        };
        const currentCheck: PlacementTurnClaimCurrentCheck = {
          ...(currentEntry.kind === "file"
            ? { sessionEntry: { source: currentEntry.source, assertCurrent: assertEntryCurrent } }
            : {}),
          assertPlacementCurrent,
        };
        const assertOwner = () => {
          assertWorkerCurrent();
          assertEntryCurrent(loadSessionEntryReadOnly(scope));
          assertPlacementCurrent(placements.get(params.sessionId));
        };
        assertOwner();
        const claim = await placements.claimWorkspaceMutationResult(
          {
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            agentId: params.agentId,
            claimId: `workspace-mutation-${randomUUID()}`,
            owner: placementTurnOwner(placement),
          },
          assertWorkerCurrent,
          currentCheck,
        );
        const assertCurrent = () => {
          assertOwner();
          if (!placements.validateWorkspaceResultClaim(claim)) {
            throw new Error("Repository workspace edit lost its result custody");
          }
        };
        try {
          assertCurrent();
          const result = await params.mutate(assertCurrent);
          assertCurrent();
          if (!result.changed) {
            await placements.acceptWorkspaceResult(claim, assertWorkerCurrent, currentCheck);
            await placements.completeWorkspaceResultAndReleaseTurn(
              claim,
              assertWorkerCurrent,
              currentCheck,
            );
            return result.value;
          }
          const tunnel = await environments.startTunnel({
            environmentId: placement.environmentId,
            ownerEpoch: placement.activeOwnerEpoch,
          });
          assertCurrent();
          if (
            tunnel.environmentId !== placement.environmentId ||
            tunnel.ownerEpoch !== placement.activeOwnerEpoch
          ) {
            throw new Error("Repository workspace capture tunnel owner changed");
          }
          const quiescence = await tunnel.quiesceWorkspace(placement.remoteWorkspaceDir);
          let resumed = false;
          try {
            assertCurrent();
            const stagedResultRef = workerWorkspaceResultRef(claim.claimId);
            const journal = createWorkspaceResultJournal({
              placement,
              placements,
              turnClaim: claim,
              assertCurrent: assertWorkerCurrent,
              current: currentCheck,
            });
            const reconciliation = await tunnel.reconcileWorkspace(
              createWorkerWorkspaceReconcileRequest({
                workspace,
                remoteWorkspaceDir: placement.remoteWorkspaceDir,
                baseManifestRef: placement.workspaceBaseManifestRef,
                journal: journal.adapter,
                stagedResult: {
                  ref: stagedResultRef,
                  record: (ref) =>
                    placements.recordStagedWorkspaceResult(
                      claim,
                      ref,
                      workspace.repository.workspaceId,
                      assertWorkerCurrent,
                      currentCheck,
                    ),
                },
                assertCurrent,
              }),
            );
            await verifyReconciledWorkspaceFinal(reconciliation, quiescence);
            assertCurrent();
            if (!journal.wasAccepted()) {
              throw new Error("Repository workspace edit was not durably accepted");
            }
            await placements.acceptWorkspaceResult(claim, assertWorkerCurrent, currentCheck);
            await settleStagedWorkspaceResult({
              assertCurrent,
              placements,
              turnClaim: claim,
              workspace,
              stagedResultRef,
              conflictRetained: false,
              complete: () =>
                placements.completeWorkspaceResultAndReleaseTurn(
                  claim,
                  assertWorkerCurrent,
                  currentCheck,
                ),
              beforeComplete: async () => {
                await quiescence.resume();
                resumed = true;
                assertCurrent();
              },
            });
            return result.value;
          } finally {
            if (!resumed) {
              await quiescence.resume();
            }
          }
        } catch (error) {
          // The remote write may have completed before transport or capture failed.
          // Retain its custody so ordinary result recovery can capture it safely.
          if (placements.validateWorkspaceResultClaim(claim)) {
            await placements.handoffWorkspaceResultRecovery(claim);
          }
          throw error;
        }
      });
    },
  };
}
