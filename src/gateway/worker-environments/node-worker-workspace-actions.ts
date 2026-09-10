import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { NodeWorkerWorkspaceExecResult } from "../../worker/node-workspace-protocol.js";
import {
  NODE_WORKSPACE_EMPTY_MANIFEST_REF,
  type NodeWorkerWorkspaceTransferInput,
} from "../../worker/node-workspace-transfer-protocol.js";
import { prepareRepositoryPublicationRestore } from "../github-repository-publication-restore.js";
import { createNodeWorkerRepositoryPreparation } from "./node-worker-repository-preparation.js";
import {
  createNodeWorkerWorkspaceFallback,
  recordNodeSyncPath,
} from "./node-worker-workspace-fallback.js";
import type { NodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import type {
  WorkerLocalWorkspaceReconcileRequest,
  WorkerLocalWorkspaceSyncRequest,
  WorkerWorkspaceReconcileRequest,
  WorkerWorkspaceCommand,
  WorkerWorkspaceTunnelHandle,
} from "./tunnel-contract.js";
import { boundedWorkerError } from "./worker-error.js";
import { runInstrumentedWorkspaceReconcile } from "./workspace-finalize.js";
import { workerProjectSeedKey } from "./workspace-git-base.js";
import type { WorkspaceHashMemo, WorkspaceReconcileMetrics } from "./workspace-hash-memo.js";
import { prepareLocalWorkspaceReconciliation } from "./workspace-local-reconciliation.js";
import {
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import { createWorkerWorkspaceQuiescence } from "./workspace-quiescence.js";
import { workerWorkspaceTransferPaths } from "./workspace-result-staging.js";

const workspaceLog = createSubsystemLogger("gateway/worker-workspace");

export type NodeWorkerWorkspaceBinding = {
  source:
    | { kind: "local"; path: string }
    | { kind: "repository"; baseCommit: string; baseManifestRef: string };
  manifestRef: string;
  remoteWorkspaceDir: string;
  sessionKey?: string;
};

type NodeWorkerWorkspaceActions = Pick<
  WorkerWorkspaceTunnelHandle,
  | "runWorkspaceCommand"
  | "syncWorkspace"
  | "quiesceWorkspace"
  | "reconcileWorkspace"
  | "stageAttachments"
> & { validateRestoredWorkspace: () => Promise<void>; getSessionKey: () => string | undefined };

export function createNodeWorkerWorkspaceActions(params: {
  environmentId: string;
  ownerEpoch: number;
  sessionId: string;
  ownerSignal: AbortSignal;
  isOwnerCurrent: () => boolean;
  restoredWorkspace?: NodeWorkerWorkspaceBinding;
  workspaceTransfer: NodeWorkspaceTransferService;
  runWorkspaceCommand: (
    command: WorkerWorkspaceCommand & { resetWorkspace?: boolean; sessionKey?: string },
  ) => Promise<NodeWorkerWorkspaceExecResult>;
}): NodeWorkerWorkspaceActions {
  const { restoredWorkspace } = params;
  let workspaceReady = restoredWorkspace !== undefined;
  let sessionKey = restoredWorkspace?.sessionKey;
  const exec = async (command: WorkerWorkspaceCommand & { resetWorkspace?: boolean }) => {
    if (!workspaceReady) {
      throw new Error("node worker workspace is unavailable before sync");
    }
    return await params.runWorkspaceCommand({
      ...command,
      ...(sessionKey === undefined ? {} : { sessionKey }),
    });
  };
  const transfer = async (
    input: NodeWorkerWorkspaceTransferInput,
    failure: string,
    command: Pick<WorkerWorkspaceCommand, "timeoutMs" | "assertCurrent" | "signal"> = {
      timeoutMs: 10 * 60_000,
    },
  ) => {
    const result = await exec({
      ...command,
      argv: ["openclaw-internal-workspace-transfer"],
      transfer: input,
      transportRetry: "never",
    });
    if (
      result.termination !== "exit" ||
      result.code !== 0 ||
      (input.direction === "download" && result.stdout.trim() !== input.manifestRef)
    ) {
      throw new Error(failure);
    }
    return result;
  };
  const workspace = createNodeWorkerWorkspaceFallback(exec);
  const quiesceWorkspace = createWorkerWorkspaceQuiescence({
    ownerSignal: params.ownerSignal,
    sharedHost: true,
    runWorkspaceCommand: exec,
  });
  const validateRestoredWorkspace = async (): Promise<void> => {
    if (!restoredWorkspace) {
      return;
    }
    if (restoredWorkspace.source.kind === "repository") {
      await params.workspaceTransfer.prepareRepository({
        environmentId: params.environmentId,
        ownerEpoch: params.ownerEpoch,
        sessionId: params.sessionId,
        generation: params.ownerEpoch,
        baseCommit: restoredWorkspace.source.baseCommit,
        baseManifestRef: restoredWorkspace.source.baseManifestRef,
        isAuthorized: params.isOwnerCurrent,
        signal: params.ownerSignal,
      });
      return;
    }
    // Restore transport custody only. The uploaded base is hash-bound to placement;
    // three-way reconciliation owns legitimate changes on either workspace.
    const prepared = await params.workspaceTransfer.prepareSync({
      environmentId: params.environmentId,
      ownerEpoch: params.ownerEpoch,
      sessionId: params.sessionId,
      generation: params.ownerEpoch,
      localPath: restoredWorkspace.source.path,
      // The transfer service re-reads the durable environment and credential together.
      // This closure fences the exact in-memory tunnel instance without duplicating that read.
      isAuthorized: params.isOwnerCurrent,
      signal: params.ownerSignal,
    });
    params.workspaceTransfer.revoke(params.environmentId, prepared.token);
  };
  // Same placement-lifetime memo contract as the SSH tunnel owner: stat-identity
  // keys self-invalidate on change, and without this owner every turn re-hashes
  // the full managed worktree during prepare/apply/verify.
  const placementHashMemo: WorkspaceHashMemo = new Map();
  const reconcileWorkspace = (request: WorkerWorkspaceReconcileRequest) =>
    runInstrumentedWorkspaceReconcile((metrics) =>
      request.source.kind === "repository"
        ? reconcileRepository(request)
        : reconcileWorkspaceRun(
            {
              remoteWorkspaceDir: request.remoteWorkspaceDir,
              baseManifestRef: request.baseManifestRef,
              localPath: request.source.path,
              journal: request.source.journal,
              stagedResult: request.source.stagedResult,
            },
            metrics,
          ),
    );
  const reconcileRepository = async (request: WorkerWorkspaceReconcileRequest) => {
    if (request.source.kind !== "repository") {
      throw new Error("Repository checkpoint source is required");
    }
    const token = params.workspaceTransfer.prepareUpload(
      params.environmentId,
      request.baseManifestRef,
    );
    let preparedCheckpoint: { discard: () => Promise<void> } | undefined;
    try {
      await transfer(
        {
          direction: "upload",
          token,
          baseManifestRef: request.baseManifestRef,
          referenceManifestRef: request.source.referenceManifestRef,
        },
        "Node repository checkpoint upload failed",
      );
      const uploaded = params.workspaceTransfer.takeUpload(
        params.environmentId,
        request.baseManifestRef,
      );
      try {
        const verifyStable = async () => {
          const observed = await workspace.captureManifest(
            request.remoteWorkspaceDir,
            uploaded.base.baseCommit,
            uploaded.currentManifestRef,
          );
          if (observed !== uploaded.currentManifestRef) {
            throw new Error("Repository workspace changed during checkpoint capture");
          }
        };
        await verifyStable();
        if (!uploaded.base.baseCommit) {
          throw new Error("Repository checkpoint has no pinned Git base");
        }
        let publicationToken: string | undefined;
        let publication: ReturnType<typeof params.workspaceTransfer.takeUpload> | undefined;
        let publicationDigest: string | undefined;
        try {
          try {
            publicationToken = params.workspaceTransfer.prepareUpload(
              params.environmentId,
              NODE_WORKSPACE_EMPTY_MANIFEST_REF,
            );
            await transfer(
              {
                direction: "upload",
                token: publicationToken,
                baseManifestRef: NODE_WORKSPACE_EMPTY_MANIFEST_REF,
                referenceManifestRef: NODE_WORKSPACE_EMPTY_MANIFEST_REF,
                publicationBaseCommit: uploaded.base.baseCommit,
              },
              "Repository publication capture failed",
            );
            publication = params.workspaceTransfer.takeUpload(
              params.environmentId,
              NODE_WORKSPACE_EMPTY_MANIFEST_REF,
            );
            const snapshot = publication.current.entries.find(
              (entry) => entry.path === "snapshot.json",
            );
            if (snapshot?.type !== "file") {
              throw new Error("Repository publication snapshot is missing");
            }
            publicationDigest = `sha256:${snapshot.sha256}`;
          } catch (error) {
            params.ownerSignal.throwIfAborted();
            if (!params.isOwnerCurrent()) {
              throw error;
            }
            workspaceLog.warn(
              `Repository publication capture unavailable: ${boundedWorkerError(error)}`,
            );
          } finally {
            if (publicationToken) {
              await params.workspaceTransfer.discardUpload(params.environmentId, publicationToken);
            }
          }
          // Publication restrictions never own recovery acceptance. Its remote
          // stability, live owner and final quiescence fences still run below.
          await verifyStable();
          const prepared = await request.source.prepareCheckpoint({
            stagingRoot: uploaded.stagingRoot,
            ...(publication && publicationDigest
              ? { publicationStagingRoot: publication.stagingRoot, publicationDigest }
              : {}),
            baseManifestRaw: uploaded.baseRaw,
            currentManifestRaw: uploaded.currentRaw,
            baseManifestRef: uploaded.baseManifestRef,
            currentManifestRef: uploaded.currentManifestRef,
          });
          preparedCheckpoint = prepared;
          return {
            manifestRef: uploaded.currentManifestRef,
            changed: uploaded.currentManifestRef !== uploaded.baseManifestRef,
            verifyStable,
            verifyLocalStable: () => prepared.verify(),
            publishStagedResult: async () => {
              await prepared.publish();
            },
            discardPreparedStagedResult: () => prepared.discard(),
          };
        } finally {
          if (publication) {
            await fsp.rm(publication.stagingRoot, { recursive: true, force: true });
          }
        }
      } finally {
        await fsp.rm(uploaded.stagingRoot, { recursive: true, force: true });
      }
    } catch (error) {
      // Finalizers can reject before the caller receives the checkpoint's disposer.
      try {
        await preparedCheckpoint?.discard();
      } catch (discardError) {
        throw new AggregateError(
          [error, discardError],
          "Repository checkpoint handoff cleanup failed",
          { cause: discardError },
        );
      }
      throw error;
    } finally {
      params.workspaceTransfer.revoke(params.environmentId, token);
    }
  };
  const reconcileWorkspaceRun = async (
    request: WorkerLocalWorkspaceReconcileRequest,
    metrics: WorkspaceReconcileMetrics,
  ) => {
    const acceptLocal = await prepareLocalWorkspaceReconciliation({
      request,
      hashMemo: placementHashMemo,
      metrics,
    });
    const uploadToken = params.workspaceTransfer.prepareUpload(
      params.environmentId,
      request.baseManifestRef,
    );
    try {
      await transfer(
        {
          direction: "upload",
          token: uploadToken,
          baseManifestRef: request.baseManifestRef,
          referenceManifestRef: request.baseManifestRef,
        },
        "Node workspace reconcile upload failed",
      );
    } finally {
      params.workspaceTransfer.revoke(params.environmentId, uploadToken);
    }
    const uploaded = params.workspaceTransfer.takeUpload(
      params.environmentId,
      request.baseManifestRef,
    );
    try {
      let expectedRemoteRef = uploaded.currentManifestRef;
      const verifyStable = async () => {
        const observed = await workspace.captureManifest(
          request.remoteWorkspaceDir,
          uploaded.base.baseCommit,
          expectedRemoteRef,
        );
        if (observed !== expectedRemoteRef) {
          throw new Error("Cloud workspace changed during final reconciliation");
        }
      };
      const publishAcceptedManifest = async (accepted: {
        manifestRef: string;
        manifest: typeof uploaded.current;
        conflictPaths: string[];
      }) => {
        if (accepted.manifestRef === expectedRemoteRef) {
          return;
        }
        const token = params.workspaceTransfer.publishSnapshot(params.environmentId, {
          manifest: accepted.manifest,
          manifestRef: accepted.manifestRef,
          rawManifest: serializeWorkerWorkspaceManifest(accepted.manifest),
          root: await fsp.realpath(request.localPath),
        });
        try {
          await transfer(
            { direction: "download", token, manifestRef: accepted.manifestRef },
            "Node workspace accepted manifest publication failed",
          );
          expectedRemoteRef = accepted.manifestRef;
        } finally {
          params.workspaceTransfer.revoke(params.environmentId, token);
        }
      };
      return await acceptLocal({
        ...uploaded,
        publishAcceptedManifest,
        manifestRef: () => expectedRemoteRef,
        verifyStable,
      });
    } finally {
      await fsp.rm(uploaded.stagingRoot, { recursive: true, force: true });
    }
  };
  const syncRepository = async (
    request: Parameters<WorkerWorkspaceTunnelHandle["syncWorkspace"]>[0],
  ) => {
    if (request.source.kind !== "repository") {
      throw new Error("Repository source is required");
    }
    const source = request.source;
    const repository = createNodeWorkerRepositoryPreparation(exec);
    const prepared = await repository.prepareRepository({
      origin: source.url,
      ref: source.ref,
      commit: source.baseCommit,
      branch: source.branch,
      gitToken: source.gitToken,
    });
    if (prepared.kind === "failed") {
      throw new Error(`Cloud repository preparation failed: ${prepared.reason}`);
    }
    const baseManifestRef = prepared.result.manifestRef;
    const baseCommit = prepared.result.baseCommit;
    const remoteWorkspaceDir = prepared.result.remoteWorkspaceDir;
    if (request.gitAuthor) {
      await repository.configureAuthor(remoteWorkspaceDir, request.gitAuthor);
    }
    await params.workspaceTransfer.prepareRepository({
      environmentId: params.environmentId,
      ownerEpoch: params.ownerEpoch,
      sessionId: params.sessionId,
      generation: params.ownerEpoch,
      baseCommit,
      baseManifestRef,
      isAuthorized: params.isOwnerCurrent,
      signal: params.ownerSignal,
    });
    let manifestRef = baseManifestRef;
    if (source.checkpoint) {
      const checkpoint = source.checkpoint;
      const digest = (raw: string) => `sha256:${createHash("sha256").update(raw).digest("hex")}`;
      if (digest(checkpoint.baseManifestRaw) !== baseManifestRef) {
        throw new Error("Repository checkpoint baseline differs from its cloned commit");
      }
      manifestRef = digest(checkpoint.currentManifestRaw);
      const manifest = parseWorkerWorkspaceManifest(checkpoint.currentManifestRaw, manifestRef);
      const base = parseWorkerWorkspaceManifest(checkpoint.baseManifestRaw, baseManifestRef);
      const token = params.workspaceTransfer.publishSnapshot(params.environmentId, {
        manifest,
        manifestRef,
        rawManifest: checkpoint.currentManifestRaw,
        root: checkpoint.stagingRoot,
        blobPaths: new Set(workerWorkspaceTransferPaths(manifest, base)),
      });
      try {
        await transfer(
          {
            direction: "download",
            token,
            manifestRef,
            checkpointBaseManifestRef: baseManifestRef,
          },
          "Repository checkpoint restore failed",
        );
        for (const command of await prepareRepositoryPublicationRestore({
          ...checkpoint,
          current: manifest,
        })) {
          const restored = await exec({ ...command, timeoutMs: 60_000, transportRetry: "never" });
          if (restored.code !== 0 || restored.termination !== "exit") {
            throw new Error(
              "Repository publication paths could not be restored; retry workspace preparation",
            );
          }
        }
      } finally {
        params.workspaceTransfer.revoke(params.environmentId, token);
      }
    } else if (source.runSetupScript) {
      const setup = await exec({
        argv: [
          "node",
          "-e",
          String.raw`const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = process.cwd();
const script = path.join(root, ".openclaw", "worktree-setup.sh");
const stat = fs.statSync(script, { throwIfNoEntry: false });
if (stat?.isFile() && (stat.mode & 0o111)) {
  const run = spawnSync(script, [], {
    cwd: root,
    env: { ...process.env, OPENCLAW_SOURCE_TREE_PATH: root, OPENCLAW_WORKTREE_PATH: root },
    stdio: "inherit",
  });
  process.exitCode = run.status ?? 1;
}`,
        ],
        timeoutMs: 120_000,
        transportRetry: "never",
      });
      if (setup.code !== 0 || setup.termination !== "exit") {
        throw new Error("Repository setup script failed");
      }
      manifestRef = await repository.captureManifest(
        remoteWorkspaceDir,
        baseCommit,
        baseManifestRef,
      );
    }
    return {
      mode: "repository" as const,
      remoteWorkspaceDir,
      manifestRef,
      baseCommit,
      baseManifestRef,
    };
  };
  return {
    getSessionKey: () => sessionKey,
    validateRestoredWorkspace,
    runWorkspaceCommand: exec,
    stageAttachments: async (request) => {
      const prepared = await params.workspaceTransfer.prepareAttachments({
        ...request,
        environmentId: params.environmentId,
      });
      try {
        await transfer(
          {
            direction: "download",
            token: prepared.token,
            manifestRef: prepared.snapshot.manifestRef,
            attachments: true,
          },
          "Worker attachment transfer failed",
          {
            assertCurrent: () => {
              if (!request.isAuthorized()) {
                throw new Error("Worker attachment transfer authority closed");
              }
            },
            signal: request.signal,
          },
        );
      } finally {
        params.workspaceTransfer.revoke(params.environmentId, prepared.token);
      }
    },
    syncWorkspace: async (request) => {
      if (
        request.sessionId !== params.sessionId ||
        (sessionKey !== undefined && request.sessionKey !== sessionKey)
      ) {
        throw new Error("Node workspace sync does not match its bound session");
      }
      sessionKey = request.sessionKey;
      workspaceReady = true;
      try {
        if (request.source.kind === "repository") {
          return await syncRepository(request);
        }
        const localRequest: WorkerLocalWorkspaceSyncRequest = {
          sessionId: request.sessionId,
          generation: request.generation,
          gitAuthor: request.gitAuthor,
          localPath: request.source.path,
          projectKey: request.source.projectKey,
        };
        const prepared = await params.workspaceTransfer.prepareSync({
          environmentId: params.environmentId,
          ownerEpoch: params.ownerEpoch,
          sessionId: params.sessionId,
          generation: params.ownerEpoch,
          localPath: localRequest.localPath,
          // Durable owner state is revalidated by the transfer service after every awaited I/O.
          isAuthorized: params.isOwnerCurrent,
          signal: params.ownerSignal,
        });
        try {
          if (!localRequest.projectKey) {
            const originStartedAt = performance.now();
            const origin = await workspace.trySyncWorkspace(
              localRequest,
              prepared.snapshot.manifestRef,
            );
            recordNodeSyncPath(params.environmentId, params.sessionId, origin, originStartedAt);
            if (origin.kind === "synced") {
              return await workspace.finalizeSync(localRequest, origin.result);
            }
          }
          const transferred = await transfer(
            {
              direction: "download",
              token: prepared.token,
              manifestRef: prepared.snapshot.manifestRef,
              ...(localRequest.projectKey && prepared.snapshot.manifest.baseCommit
                ? {
                    seedKey: workerProjectSeedKey({
                      key: localRequest.projectKey,
                      baseCommit: prepared.snapshot.manifest.baseCommit,
                    }),
                  }
                : {}),
            },
            "Node workspace transfer failed",
          );
          return await workspace.finalizeSync(localRequest, {
            mode: prepared.snapshot.manifest.baseCommit ? ("git" as const) : ("plain" as const),
            remoteWorkspaceDir: transferred.workspaceDir,
            manifestRef: prepared.snapshot.manifestRef,
          });
        } finally {
          params.workspaceTransfer.revoke(params.environmentId, prepared.token);
        }
      } catch (error) {
        workspaceReady = restoredWorkspace !== undefined;
        throw error;
      }
    },
    quiesceWorkspace,
    reconcileWorkspace,
  };
}
