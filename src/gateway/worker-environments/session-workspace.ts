import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import {
  recoverSessionRepositoryCheckpoint,
  stageSessionRepositoryCheckpoint,
} from "./session-repository-checkpoints.js";
import type {
  WorkerLocalWorkspaceReconcileRequest,
  WorkerWorkspaceReconcileRequest,
} from "./tunnel-contract.js";

/** Adopt only the initial background sync's accepted baseline, never an unrelated later result. */
export async function resolvePreparedTurnRepository(params: {
  workspace: WorkerSessionWorkspace;
  manifestRef: string;
  resolveWorkspace: () => Promise<WorkerSessionWorkspace>;
  assertCurrent: () => void;
}): Promise<WorkerSessionWorkspace> {
  const original = params.workspace;
  params.assertCurrent();
  const ready = await params.resolveWorkspace();
  params.assertCurrent();
  if (original.kind !== "repository" || ready.kind !== "repository") {
    throw new Error("Repository workspace owner changed during background preparation");
  }
  const before = original.repository;
  const after = ready.repository;
  if (
    after.workspaceId !== before.workspaceId ||
    after.agentId !== before.agentId ||
    after.sessionKey !== before.sessionKey ||
    after.url !== before.url ||
    after.requestedRef !== before.requestedRef ||
    after.branch !== before.branch ||
    after.runSetupScript !== before.runSetupScript ||
    (before.baseCommit !== null && after.baseCommit !== before.baseCommit) ||
    (before.baseManifestHash !== null && after.baseManifestHash !== before.baseManifestHash) ||
    after.manifestHash !== params.manifestRef ||
    !after.checkpointRef ||
    after.revision < before.revision ||
    after.revision > before.revision + 1 + (!before.baseCommit || !before.baseManifestHash ? 1 : 0)
  ) {
    throw new Error("Repository workspace changed outside its admitted background preparation");
  }
  return ready;
}

/** Durable session workspace ownership is independent of its current worker placement. */
export type WorkerSessionWorkspace =
  | { kind: "local"; path: string }
  | {
      kind: "repository";
      repository: SessionRepositoryWorkspaceRecord;
      /** Advance the captured target fence only from this owner's settled checkpoint receipt. */
      acceptCheckpoint?: (accepted: SessionRepositoryWorkspaceRecord) => void;
    };

/** Repository roots contain result artifacts only; never use them as execution cwd. */
export function sessionWorkspaceRoot(workspace: WorkerSessionWorkspace): string {
  return workspace.kind === "local"
    ? workspace.path
    : getSessionRepositoryWorkspaceStore().artifactPath(workspace.repository.workspaceId);
}

export function createWorkerWorkspaceReconcileRequest(params: {
  workspace: WorkerSessionWorkspace;
  remoteWorkspaceDir: string;
  baseManifestRef: string;
  journal: WorkerLocalWorkspaceReconcileRequest["journal"];
  stagedResult: WorkerLocalWorkspaceReconcileRequest["stagedResult"];
  assertCurrent: () => void;
}): WorkerWorkspaceReconcileRequest {
  const { workspace, remoteWorkspaceDir, baseManifestRef, journal, stagedResult } = params;
  if (workspace.kind === "local") {
    return {
      source: {
        kind: "local",
        path: workspace.path,
        journal,
        stagedResult,
        assertCurrent: params.assertCurrent,
      },
      remoteWorkspaceDir,
      baseManifestRef,
    };
  }
  if (!workspace.repository.baseManifestHash || !workspace.repository.manifestHash) {
    throw new Error("Repository workspace has no accepted source manifest");
  }
  return {
    remoteWorkspaceDir,
    // Repository results are cumulative from the pinned commit. The placement
    // journal advances independently as setup, turns, and editor saves settle.
    baseManifestRef: workspace.repository.baseManifestHash,
    source: {
      kind: "repository",
      authorize: params.assertCurrent,
      referenceManifestRef: workspace.repository.manifestHash,
      prepareCheckpoint: async (payload) => {
        const prepared = await stageSessionRepositoryCheckpoint({
          ...payload,
          reconcileBranch: true,
          workspaceId: workspace.repository.workspaceId,
          expectedRevision: workspace.repository.revision,
          checkpointRef: stagedResult.ref,
          assertCurrent: params.assertCurrent,
        });
        return {
          verify: prepared.verify,
          discard: prepared.discard,
          publish: async () => {
            const accepted = await prepared.publish();
            workspace.acceptCheckpoint?.(accepted);
            params.assertCurrent();
            // The immutable ref is discoverable if the process stops between
            // checkpoint acceptance and recording its pending-result pointer.
            await stagedResult.record(prepared.checkpointRef);
            params.assertCurrent();
            await journal.commit(payload.currentManifestRef);
            return accepted;
          },
        };
      },
    },
  };
}

export async function recoverSessionWorkspaceCheckpoint(params: {
  workspace: Extract<WorkerSessionWorkspace, { kind: "repository" }>;
  checkpointRef: string;
  assertCurrent: () => void;
  onAccepted: (manifestRef: string) => Promise<void>;
}): Promise<void> {
  const accepted = await recoverSessionRepositoryCheckpoint({
    reconcileBranch: true,
    workspaceId: params.workspace.repository.workspaceId,
    checkpointRef: params.checkpointRef,
    assertCurrent: params.assertCurrent,
  });
  params.workspace.acceptCheckpoint?.(accepted);
  params.assertCurrent();
  if (!accepted.manifestHash) {
    throw new Error("Repository checkpoint has no accepted manifest");
  }
  await params.onAccepted(accepted.manifestHash);
}
