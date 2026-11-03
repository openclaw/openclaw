import { assertRepositoryWorkspaceDiskIdentity } from "../../state/session-repository-workspaces.authority.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import type { WorkerSessionPlacementIdentity } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import { isExactAttachedEnvironment } from "./placement-target.js";
import { isWorkerRetainedWindowOpen } from "./retained-work-window.js";
import type { WorkerEnvironmentService } from "./service.js";
import { aliasSessionRepositoryCheckpoint } from "./session-repository-checkpoint-refs.js";
import {
  readSessionRepositoryArtifacts,
  stageSessionRepositoryCheckpoint,
} from "./session-repository-checkpoints.js";
import type { WorkerWorkspaceQuiescence } from "./tunnel-contract.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import { hasWorkerWorkspaceResultRef } from "./workspace-result-staging.js";

/** Caller owns the existing session reservation/result claim; transport joins its workspace commands. */
export async function captureRepositoryDiskCheckpoint<T>(
  params: {
    identity: WorkerSessionPlacementIdentity;
    repository: SessionRepositoryWorkspaceRecord;
    checkpointRef: string;
    additionalRefs?: readonly string[];
    purpose: "publication" | "gateway-move";
    placements: WorkerSessionPlacementStore;
    environments: Pick<WorkerEnvironmentService, "get" | "startTunnel" | "ensureRetainedRunning">;
    assertCurrent: () => void;
    quiescence?: WorkerWorkspaceQuiescence;
  },
  use: (
    snapshot: { checkpointRef: string; manifestHash: string },
    verifyCurrent: () => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const { repository, identity, checkpointRef, placements, environments } = params;
  const authority = repository.diskAuthority;
  if (!authority || !repository.baseManifestHash || !repository.manifestHash) {
    throw new Error("An initialized exact repository disk is required for capture");
  }
  if (params.purpose === "gateway-move" && !params.quiescence) {
    throw new Error("Repository disk export requires its admitted Move quiescence owner");
  }
  const store = getSessionRepositoryWorkspaceStore();
  params.assertCurrent();
  if (
    params.purpose === "publication" &&
    (await hasWorkerWorkspaceResultRef({
      root: store.artifactPath(repository.workspaceId),
      stagedResultRef: checkpointRef,
    }))
  ) {
    // The immutable artifact can precede its receipt binding after a lost reply. Never recapture it.
    const retained = await readSessionRepositoryArtifacts({
      workspaceId: repository.workspaceId,
      checkpointRef,
      assertCurrent: params.assertCurrent,
    });
    if (params.additionalRefs?.length) {
      await aliasSessionRepositoryCheckpoint({
        root: store.artifactPath(repository.workspaceId),
        workspace: repository,
        checkpointRef,
        aliases: params.additionalRefs,
        assertCurrent: params.assertCurrent,
      });
    }
    params.assertCurrent();
    return await use({ checkpointRef, manifestHash: retained.currentManifestRef }, async () =>
      params.assertCurrent(),
    );
  }
  const prepared = await placements.prepareSessionPlacement(identity.sessionId);
  using _ = { [Symbol.dispose]: () => prepared.release() };
  const placement = prepared.current();
  if (
    placement?.state !== "active" &&
    !(params.purpose === "gateway-move" && placement?.state === "draining")
  ) {
    throw new Error("The original repository disk must be attached before capture");
  }
  const assertCurrent = () => {
    params.assertCurrent();
    const current = prepared.current();
    const environment = environments.get(authority.environmentId);
    assertRepositoryWorkspaceDiskIdentity(authority, environment);
    if (
      (current?.state !== "active" && current?.state !== "draining") ||
      current.state !== placement.state ||
      current.agentId !== identity.agentId ||
      current.sessionKey !== identity.sessionKey ||
      repository.agentId !== identity.agentId ||
      repository.sessionKey !== identity.sessionKey ||
      current.generation !== placement.generation ||
      current.environmentId !== authority.environmentId ||
      current.activeOwnerEpoch !== placement.activeOwnerEpoch ||
      current.remoteWorkspaceDir !== placement.remoteWorkspaceDir ||
      !isExactAttachedEnvironment(environment, current) ||
      !environment?.nodeDeviceId ||
      environment.destroyRequestedAtMs !== null
    ) {
      throw new Error("Repository disk capture lost its exact session attachment");
    }
  };
  assertCurrent();
  // Move prepares before quiescing. Refresh here could stop its admitted native owner.
  if (
    !params.quiescence &&
    !isWorkerRetainedWindowOpen(environments.get(authority.environmentId))
  ) {
    await environments.ensureRetainedRunning({
      environmentId: authority.environmentId,
      expectedOwnerEpoch: placement.activeOwnerEpoch,
      assertCurrent,
    });
    assertCurrent();
  }
  const tunnel = await environments.startTunnel({
    environmentId: authority.environmentId,
    ownerEpoch: placement.activeOwnerEpoch,
    authorize: assertCurrent,
  });
  assertCurrent();
  if (
    tunnel.environmentId !== authority.environmentId ||
    tunnel.ownerEpoch !== placement.activeOwnerEpoch
  ) {
    throw new Error("Repository disk capture tunnel changed");
  }
  const quiescence =
    params.quiescence ??
    (await tunnel.quiesceWorkspace(placement.remoteWorkspaceDir, assertCurrent));
  let manifestHash: string | undefined;
  let staged: Awaited<ReturnType<typeof stageSessionRepositoryCheckpoint>> | undefined;
  try {
    assertCurrent();
    if (params.purpose === "gateway-move") {
      // Existing checkpoint restoration preserves HEAD and files, not partial index contents.
      const index = await tunnel.runWorkspaceCommand({
        argv: ["git", "diff", "--cached", "--quiet", "HEAD", "--"],
        transportRetry: "never",
        assertCurrent,
        timeoutMs: 30_000,
      });
      assertCurrent();
      if (index.termination !== "exit" || index.code !== 0) {
        throw new Error(
          "Commit or explicitly resolve staged changes before moving this repository disk to the Gateway; the original disk is preserved",
        );
      }
    }
    const result = await tunnel.reconcileWorkspace({
      remoteWorkspaceDir: placement.remoteWorkspaceDir,
      baseManifestRef: repository.baseManifestHash,
      source: {
        kind: "repository",
        authorize: assertCurrent,
        referenceManifestRef: repository.baseManifestHash,
        prepareCheckpoint: async (payload) => {
          assertCurrent();
          if (!payload.publicationStagingRoot || !payload.publicationDigest) {
            throw new Error(
              "The repository disk could not produce a complete Git publication snapshot",
            );
          }
          if (
            params.purpose === "gateway-move" &&
            (!payload.gitHistory?.descendsFromBase || payload.gitHistory.unavailableReason)
          ) {
            throw new Error(
              "The repository disk Git history is unavailable; preserve the original disk and retry export",
            );
          }
          const checkpoint = await stageSessionRepositoryCheckpoint({
            ...payload,
            workspaceId: repository.workspaceId,
            expectedRevision: repository.revision,
            checkpointRef,
            assertCurrent,
          });
          staged = checkpoint;
          manifestHash = payload.currentManifestRef;
          return {
            verify: checkpoint.verify,
            discard: checkpoint.discard,
            publish: () => checkpoint.publishArtifacts(params.additionalRefs),
          };
        },
      },
    });
    await verifyReconciledWorkspaceFinal(result, quiescence);
    assertCurrent();
    if (!manifestHash) {
      throw new Error("Repository disk capture did not retain a snapshot");
    }
    return await use({ checkpointRef, manifestHash }, async () => {
      assertCurrent();
      await quiescence.assertActive();
      assertCurrent();
      await result.verifyStable();
      assertCurrent();
    });
  } finally {
    try {
      await staged?.discard();
    } finally {
      if (!params.quiescence) {
        await quiescence.resume();
      }
    }
  }
}
