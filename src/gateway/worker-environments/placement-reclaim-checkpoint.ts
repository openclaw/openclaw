import { isDeepStrictEqual } from "node:util";
import {
  isExactAttachedEnvironment,
  type WorkerDispatchEnvironmentService,
  type WorkerDispatchPlacement,
} from "./placement-dispatch-failure.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerWorkspacePendingResult } from "./placement-workspace-result.types.js";
import { readSessionRepositoryArtifacts } from "./session-repository-checkpoints.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import { createWorkspaceReconcileMetrics } from "./workspace-hash-memo.js";
import { captureRemoteWorkspaceManifest } from "./workspace-sync-helpers.js";

/** Adopt current accepted state for an interrupted reclaim, never infer its old commit receipt. */
export async function prepareAcceptedReclaimCheckpoint(params: {
  placement: Extract<WorkerDispatchPlacement, { state: "active" | "draining" }>;
  pending: WorkerWorkspacePendingResult;
  claim: WorkerSessionTurnClaim;
  workspace: WorkerSessionWorkspace;
  checkpointRef: string;
  placements: Pick<WorkerSessionPlacementStore, "validateWorkspaceResultClaim">;
  environments: Pick<WorkerDispatchEnvironmentService, "get" | "startTunnel">;
  assertCurrent: () => void;
}) {
  const { placement, pending, workspace, environments } = params;
  const environment = environments.get(placement.environmentId);
  const assertCurrent = () => {
    params.assertCurrent();
    const current = environments.get(placement.environmentId);
    if (
      placement.state !== "draining" ||
      placement.environmentId !== pending.environmentId ||
      placement.activeOwnerEpoch !== pending.ownerEpoch ||
      !params.placements.validateWorkspaceResultClaim(params.claim) ||
      !environment?.leaseId ||
      !current ||
      !isExactAttachedEnvironment(current, placement) ||
      current.environmentId !== pending.environmentId ||
      current.leaseId !== environment.leaseId ||
      current.nodeDeviceId !== environment.nodeDeviceId ||
      !isDeepStrictEqual(current.sshEndpoint, environment.sshEndpoint) ||
      current.recoveryHold
    ) {
      throw new Error("Stranded reclaim lost its exact attached environment owner");
    }
  };
  assertCurrent();
  if (
    workspace.kind !== "repository" ||
    workspace.repository.checkpointRef !== params.checkpointRef ||
    (pending.stagedResultRef !== null && pending.stagedResultRef !== params.checkpointRef) ||
    (pending.repositoryWorkspaceId !== undefined &&
      pending.repositoryWorkspaceId !== workspace.repository.workspaceId)
  ) {
    throw new Error("Stranded reclaim has no current accepted own checkpoint");
  }
  await readSessionRepositoryArtifacts({
    workspaceId: workspace.repository.workspaceId,
    checkpointRef: params.checkpointRef,
    assertCurrent,
  });
  assertCurrent();
  return {
    assertCurrent,
    async teardown<T>(run: () => Promise<T>): Promise<T> {
      assertCurrent();
      const tunnel = await environments.startTunnel({
        environmentId: placement.environmentId,
        ownerEpoch: placement.activeOwnerEpoch,
        authorize: assertCurrent,
      });
      assertCurrent();
      const quiescence = await tunnel.quiesceWorkspace(placement.remoteWorkspaceDir);
      try {
        assertCurrent();
        await quiescence.assertActive();
        assertCurrent();
        const branch = await tunnel.runWorkspaceCommand({
          argv: [
            "git",
            "-C",
            placement.remoteWorkspaceDir,
            "symbolic-ref",
            "--quiet",
            "--short",
            "HEAD",
          ],
          transportRetry: "idempotent",
          assertCurrent,
        });
        assertCurrent();
        if (
          branch.termination !== "exit" ||
          branch.code !== 0 ||
          branch.stdout.trim() !== workspace.repository.branch
        ) {
          throw new Error("Stranded reclaim retains a different workspace branch");
        }
        const observed = await captureRemoteWorkspaceManifest({
          runWorkspaceCommand: (command) =>
            tunnel.runWorkspaceCommand({ ...command, assertCurrent }),
          remoteWorkspaceDir: placement.remoteWorkspaceDir,
          baseCommit: workspace.repository.baseCommit,
          priorManifestDigests: workspace.repository.manifestHash
            ? [workspace.repository.manifestHash.slice(7)]
            : [],
          hashMemo: new Map(),
          metrics: createWorkspaceReconcileMetrics(),
        });
        assertCurrent();
        if (observed !== workspace.repository.manifestHash) {
          throw new Error("Stranded reclaim retains newer unaccepted workspace bytes");
        }
        await quiescence.assertActive();
        assertCurrent();
        return await run();
      } finally {
        if (isExactAttachedEnvironment(environments.get(placement.environmentId), placement)) {
          await quiescence.resume();
        }
      }
    },
  };
}
