import fsp from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  NODE_WORKER_WORKSPACE_STDOUT_MAX_BYTES,
  type NodeWorkerWorkspaceExecResult,
} from "../../worker/node-workspace-protocol.js";
import { NODE_WORKSPACE_EMPTY_MANIFEST_REF } from "../../worker/node-workspace-transfer-protocol.js";
import { prepareRepositoryPublicationRestore } from "../github-repository-publication-restore.js";
import { createNodeWorkerAttachmentStager } from "./node-worker-attachments.js";
import { createNodeWorkerRepositoryPreparation } from "./node-worker-repository-preparation.js";
import { createNodeRepositoryReadiness } from "./node-worker-repository-readiness.js";
import { summarizeWorkerSetupMarkers } from "./node-worker-setup-diagnostics.js";
import {
  createNodeWorkerWorkspaceFallback,
  recordNodeSyncPath,
} from "./node-worker-workspace-fallback.js";
import { createNodeWorkspaceTransferCommand } from "./node-workspace-transfer-command.js";
import type { NodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { recordWorkerPlacementAwait } from "./placement-diagnostics.js";
import type {
  WorkerLocalWorkspaceReconcileRequest,
  WorkerLocalWorkspaceSyncRequest,
  WorkerWorkspaceReconcileRequest,
  WorkerWorkspaceCommand,
  WorkerWorkspaceSyncResult,
  WorkerWorkspaceSyncRequest,
} from "./tunnel-contract.js";
import { boundedWorkerError } from "./worker-error.js";
import { runInstrumentedWorkspaceReconcile } from "./workspace-finalize.js";
import { workerProjectSeedKey } from "./workspace-git-base.js";
import type { WorkspaceHashMemo, WorkspaceReconcileMetrics } from "./workspace-hash-memo.js";
import { prepareLocalWorkspaceReconciliation } from "./workspace-local-reconciliation.js";
import {
  decodeWorkspaceManifest,
  serializeWorkspaceManifest,
} from "./workspace-manifest-worker.js";
import { createWorkerWorkspaceQuiescence } from "./workspace-quiescence.js";
import { workerWorkspaceTransferPaths } from "./workspace-result-staging.js";
import { captureRemoteWorkspaceManifest } from "./workspace-sync-helpers.js";

const workspaceLog = createSubsystemLogger("gateway/worker-workspace");
// Leave room for the manifest reference and bounded numeric metrics in the result envelope.
const NODE_WORKSPACE_HASH_MEMO_BYTES = NODE_WORKER_WORKSPACE_STDOUT_MAX_BYTES - 4 * 1024;

export type NodeWorkerWorkspaceBinding = {
  source:
    | { kind: "local"; path: string }
    | { kind: "repository"; baseCommit: string; baseManifestRef: string };
  manifestRef: string;
  remoteWorkspaceDir: string;
  sessionKey?: string;
};

export function createNodeWorkerWorkspaceActions(params: {
  environmentId: string;
  ownerEpoch: number;
  sessionId: string;
  ownerSignal: AbortSignal;
  isOwnerCurrent: () => boolean;
  restoredWorkspace?: NodeWorkerWorkspaceBinding;
  supportsNativeQuiescence?: () => Promise<boolean>;
  workspaceTransfer: NodeWorkspaceTransferService;
  runWorkspaceCommand: (
    command: WorkerWorkspaceCommand & { resetWorkspace?: boolean; sessionKey?: string },
  ) => Promise<NodeWorkerWorkspaceExecResult>;
}) {
  const { restoredWorkspace } = params;
  // Transfers revalidate this tunnel binding and its durable environment/credential on use.
  const transferOwner = {
    environmentId: params.environmentId,
    ownerEpoch: params.ownerEpoch,
    sessionId: params.sessionId,
    generation: params.ownerEpoch,
    isAuthorized: params.isOwnerCurrent,
    signal: params.ownerSignal,
  };
  let workspaceReady = restoredWorkspace !== undefined;
  let sessionKey = restoredWorkspace?.sessionKey;
  const repositoryReadiness = createNodeRepositoryReadiness({
    signal: params.ownerSignal,
    assertCurrent: () => {
      if (!params.isOwnerCurrent()) {
        throw new Error("Repository worker owner changed");
      }
    },
    run: params.runWorkspaceCommand,
    onPrepared: (key) => {
      sessionKey = key;
      workspaceReady = true;
    },
  });
  const exec = async (command: WorkerWorkspaceCommand & { resetWorkspace?: boolean }) => {
    if (!workspaceReady) {
      throw new Error("node worker workspace is unavailable before sync");
    }
    return await params.runWorkspaceCommand({
      ...command,
      ...(sessionKey === undefined ? {} : { sessionKey }),
    });
  };
  const transfer = createNodeWorkspaceTransferCommand(exec);
  const workspace = createNodeWorkerWorkspaceFallback(exec);
  const quiesceWorkspace = createWorkerWorkspaceQuiescence({
    ownerSignal: params.ownerSignal,
    sharedHost: true,
    nativeWatchdog: params.supportsNativeQuiescence,
    runWorkspaceCommand: exec,
  });
  const validateRestoredWorkspace = async (authorize?: () => void): Promise<void> => {
    if (!restoredWorkspace) {
      return;
    }
    if (restoredWorkspace.source.kind === "repository") {
      await params.workspaceTransfer.prepareRepository({
        ...transferOwner,
        authorize,
        baseCommit: restoredWorkspace.source.baseCommit,
        baseManifestRef: restoredWorkspace.source.baseManifestRef,
      });
      return;
    }
    // Restore transport custody only. The uploaded base is hash-bound to placement;
    // three-way reconciliation owns legitimate changes on either workspace.
    const prepared = await params.workspaceTransfer.prepareSync({
      ...transferOwner,
      localPath: restoredWorkspace.source.path,
      authorize,
    });
    await params.workspaceTransfer.revoke(params.environmentId, prepared.token);
  };
  // Same placement-lifetime memo contract as the SSH tunnel owner: stat-identity
  // keys self-invalidate on change, and without this owner every turn re-hashes
  // the full managed worktree during prepare/apply/verify.
  const placementHashMemo: WorkspaceHashMemo = new Map();
  const reconcileWorkspace = (request: WorkerWorkspaceReconcileRequest) =>
    runInstrumentedWorkspaceReconcile((metrics) =>
      request.source.kind === "repository"
        ? reconcileRepository(request, metrics)
        : reconcileWorkspaceRun(
            {
              remoteWorkspaceDir: request.remoteWorkspaceDir,
              baseManifestRef: request.baseManifestRef,
              localPath: request.source.path,
              journal: request.source.journal,
              assertCurrent: request.source.assertCurrent,
              stagedResult: request.source.stagedResult,
            },
            metrics,
          ),
    );
  const reconcileRepository = async (
    request: WorkerWorkspaceReconcileRequest,
    metrics: WorkspaceReconcileMetrics,
  ) => {
    if (request.source.kind !== "repository") {
      throw new Error("Repository checkpoint source is required");
    }
    const { authorize } = request.source;
    authorize?.();
    const token = params.workspaceTransfer.prepareUpload(
      params.environmentId,
      request.baseManifestRef,
      authorize,
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
        { assertCurrent: authorize },
      );
      const uploaded = params.workspaceTransfer.takeUpload(
        params.environmentId,
        request.baseManifestRef,
      );
      try {
        const verifyStable = async () => {
          authorize?.();
          const observed = await captureRemoteWorkspaceManifest({
            runWorkspaceCommand: (command) => exec({ ...command, assertCurrent: authorize }),
            remoteWorkspaceDir: request.remoteWorkspaceDir,
            baseCommit: uploaded.base.baseCommit,
            priorManifestDigests: [
              uploaded.currentManifestRef.slice(7),
              uploaded.baseManifestRef.slice(7),
            ],
            hashMemo: placementHashMemo,
            metrics,
            maxHashMemoBytes: NODE_WORKSPACE_HASH_MEMO_BYTES,
          });
          authorize?.();
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
              authorize,
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
              { assertCurrent: authorize },
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
            authorize?.();
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
          authorize?.();
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
            verifyLocalStable: () => {
              authorize?.();
              return prepared.verify();
            },
            publishStagedResult: async () => {
              authorize?.();
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
      await params.workspaceTransfer.revoke(params.environmentId, token);
    }
  };
  const reconcileWorkspaceRun = async (
    request: WorkerLocalWorkspaceReconcileRequest,
    metrics: WorkspaceReconcileMetrics,
  ) => {
    const uploadToken = params.workspaceTransfer.prepareUpload(
      params.environmentId,
      request.baseManifestRef,
      request.assertCurrent,
    );
    let uploaded: ReturnType<NodeWorkspaceTransferService["takeUpload"]>;
    let acceptLocal: Awaited<ReturnType<typeof prepareLocalWorkspaceReconciliation>>;
    try {
      // Local recovery and remote upload must settle before releasing custody.
      const [local, upload] = await Promise.allSettled([
        prepareLocalWorkspaceReconciliation({ request, hashMemo: placementHashMemo, metrics }),
        transfer(
          {
            direction: "upload",
            token: uploadToken,
            baseManifestRef: request.baseManifestRef,
            referenceManifestRef: request.baseManifestRef,
          },
          "Node workspace reconcile upload failed",
          { assertCurrent: request.assertCurrent },
        ),
      ]);
      if (local.status === "rejected") {
        throw local.reason;
      }
      if (upload.status === "rejected") {
        throw upload.reason;
      }
      acceptLocal = local.value;
      uploaded = params.workspaceTransfer.takeUpload(params.environmentId, request.baseManifestRef);
    } finally {
      await params.workspaceTransfer.revoke(params.environmentId, uploadToken);
    }
    try {
      let expectedRemoteRef = uploaded.currentManifestRef;
      const verifyStable = async () => {
        const observed = await captureRemoteWorkspaceManifest({
          runWorkspaceCommand: exec,
          remoteWorkspaceDir: request.remoteWorkspaceDir,
          baseCommit: uploaded.base.baseCommit,
          priorManifestDigests: [expectedRemoteRef.slice(7), uploaded.baseManifestRef.slice(7)],
          hashMemo: placementHashMemo,
          metrics,
          maxHashMemoBytes: NODE_WORKSPACE_HASH_MEMO_BYTES,
        });
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
          rawManifest: (await serializeWorkspaceManifest(accepted.manifest, params.ownerSignal))
            .raw,
          root: await fsp.realpath(request.localPath),
        });
        try {
          await transfer(
            { direction: "download", token, manifestRef: accepted.manifestRef },
            "Node workspace accepted manifest publication failed",
          );
          expectedRemoteRef = accepted.manifestRef;
        } finally {
          await params.workspaceTransfer.revoke(params.environmentId, token);
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
  const syncRepository = async (request: WorkerWorkspaceSyncRequest) => {
    if (request.source.kind !== "repository") {
      throw new Error("Repository source is required");
    }
    const source = request.source;
    const memo = { hashes: placementHashMemo, maxBytes: NODE_WORKSPACE_HASH_MEMO_BYTES };
    const repository = createNodeWorkerRepositoryPreparation(exec, request.authorize, memo);
    const identity = {
      origin: source.url,
      ref: source.ref,
      commit: source.baseCommit,
      branch: source.branch,
      gitToken: source.gitToken,
    };
    const syncFacts = {
      generation: request.generation,
      environmentId: params.environmentId,
      ownerEpoch: params.ownerEpoch,
    };
    const baseline = await recordWorkerPlacementAwait(
      params.sessionId,
      "repository_prepare",
      async (): Promise<WorkerWorkspaceSyncResult & { baseCommit: string }> => {
        if (source.prepared) {
          if (source.runSetupScript) {
            throw new Error("Prepared repository requires completed setup");
          }
          const bound = await repository.bindPreparedRepository(
            {
              ...identity,
              commit: source.prepared.baseCommit,
              allowRefRefresh: source.preparedRefMode !== undefined,
            },
            source.prepared,
            request.gitAuthor,
          );
          return source.preparedRefMode === "fetch"
            ? await repository.refreshBoundPreparedRepository(identity, bound)
            : source.preparedRefMode === "recover"
              ? await repository.observeBoundPreparedRepository(bound)
              : bound;
        }
        const prepared = await repository.prepareRepository(identity);
        if (prepared.kind === "failed") {
          throw new Error(
            `Cloud repository preparation failed: ${prepared.reason}${prepared.detail ? `: ${prepared.detail}` : ""}`,
          );
        }
        return prepared.result;
      },
      syncFacts,
      "placement",
    );
    const baseManifestRef =
      baseline.mode === "repository" ? baseline.baseManifestRef : baseline.manifestRef;
    const baseCommit = baseline.baseCommit;
    const remoteWorkspaceDir = baseline.remoteWorkspaceDir;
    if (request.gitAuthor && !source.prepared) {
      await repository.configureAuthor(remoteWorkspaceDir, request.gitAuthor);
    }
    await recordWorkerPlacementAwait(
      params.sessionId,
      "repository_transfer_bind",
      () =>
        params.workspaceTransfer.prepareRepository({
          ...transferOwner,
          baseCommit,
          baseManifestRef,
          authorize: request.authorize,
        }),
      syncFacts,
      "placement",
    );
    let manifestRef = baseline.manifestRef;
    if (source.checkpoint) {
      const checkpoint = source.checkpoint;
      await recordWorkerPlacementAwait(
        params.sessionId,
        "repository_checkpoint_restore",
        async () => {
          const decodedBase = await decodeWorkspaceManifest(
            checkpoint.baseManifestRaw,
            undefined,
            params.ownerSignal,
          );
          if (decodedBase.manifestRef !== baseManifestRef) {
            throw new Error("Repository checkpoint baseline differs from its cloned commit");
          }
          const decoded = await decodeWorkspaceManifest(
            checkpoint.currentManifestRaw,
            undefined,
            params.ownerSignal,
          );
          manifestRef = decoded.manifestRef;
          const manifest = decoded.manifest;
          const base = decodedBase.manifest;
          const token = params.workspaceTransfer.publishSnapshot(
            params.environmentId,
            {
              manifest,
              manifestRef,
              rawManifest: checkpoint.currentManifestRaw,
              root: checkpoint.stagingRoot,
              blobPaths: new Set(workerWorkspaceTransferPaths(manifest, base, params.ownerSignal)),
            },
            request.authorize,
          );
          try {
            await transfer(
              {
                direction: "download",
                token,
                manifestRef,
                checkpointBaseManifestRef: baseManifestRef,
              },
              "Repository checkpoint restore failed",
              { assertCurrent: request.authorize },
            );
            for (const command of await prepareRepositoryPublicationRestore({
              ...checkpoint,
              current: manifest,
            })) {
              const restored = await exec({
                ...command,
                timeoutMs: 60_000,
                transportRetry: "never",
                assertCurrent: request.authorize,
              });
              if (restored.code !== 0 || restored.termination !== "exit") {
                throw new Error(
                  "Repository publication paths could not be restored; retry workspace preparation",
                );
              }
            }
          } finally {
            await params.workspaceTransfer.revoke(params.environmentId, token);
          }
          if (source.recoveryHeadCommit) {
            await repository.alignRecoveryHead(identity, baseCommit, source.recoveryHeadCommit);
            const afterAlignment = await repository.captureManifest(
              remoteWorkspaceDir,
              baseCommit,
              manifestRef,
            );
            if (afterAlignment !== manifestRef) {
              throw new Error("Recovery history alignment changed accepted workspace bytes");
            }
          }
        },
        syncFacts,
        "placement",
      );
    } else if (source.runSetupScript) {
      const setupStartedAt = performance.now();
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
        assertCurrent: request.authorize,
      });
      const failed = setup.code !== 0 || setup.termination !== "exit";
      try {
        const facts = {
          phase: "repository_setup",
          environmentId: params.environmentId,
          ownerEpoch: params.ownerEpoch,
          sessionId: params.sessionId,
          sessionKey,
          placementGeneration: request.generation,
          baseCommit,
          baseManifestRef,
          scriptPath: ".openclaw/worktree-setup.sh",
          configuredTimeoutMs: 120_000,
          elapsedMs: Math.round(performance.now() - setupStartedAt),
          exitCode: setup.code,
          termination: setup.termination,
          signal:
            setup.signal && Object.hasOwn(osConstants.signals, setup.signal)
              ? setup.signal
              : undefined,
          killed: setup.killed,
          timedOut: setup.termination === "timeout" || setup.termination === "no-output-timeout",
          stdoutTruncatedBytes: setup.stdoutTruncatedBytes,
          stderrTruncatedBytes: setup.stderrTruncatedBytes,
          outputLimitExceeded: setup.outputLimitExceeded,
          ...summarizeWorkerSetupMarkers(setup.stderr),
        };
        if (failed) {
          workspaceLog.warn("worker repository setup failed", facts);
        } else {
          workspaceLog.info("worker repository setup completed", facts);
        }
      } catch {
        // Diagnostics cannot replace the validated command failure or decide its cleanup.
      }
      if (failed) {
        throw new Error("Repository setup script failed");
      }
      manifestRef = await repository.captureManifest(
        remoteWorkspaceDir,
        baseCommit,
        baseManifestRef,
      );
    }
    request.authorize?.();
    return {
      mode: "repository" as const,
      remoteWorkspaceDir,
      manifestRef,
      baseCommit,
      baseManifestRef,
    };
  };
  return {
    prepareRepositoryWorkspace: repositoryReadiness.prepare,
    settleRepositoryWorkspace: repositoryReadiness.settle,
    getSessionKey: () => sessionKey,
    validateRestoredWorkspace,
    runWorkspaceCommand: (command: WorkerWorkspaceCommand) =>
      repositoryReadiness.execute(command, exec),
    stageAttachments: createNodeWorkerAttachmentStager({
      environmentId: params.environmentId,
      workspaceTransfer: params.workspaceTransfer,
      transfer,
      waitRepository: repositoryReadiness.wait,
    }),
    syncWorkspace: async (request: WorkerWorkspaceSyncRequest) => {
      request.authorize?.();
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
          authorize: request.authorize,
        };
        const prepared = await params.workspaceTransfer.prepareSync({
          ...transferOwner,
          localPath: localRequest.localPath,
          authorize: request.authorize,
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
            { assertCurrent: request.authorize },
          );
          return await workspace.finalizeSync(localRequest, {
            mode: prepared.snapshot.manifest.baseCommit ? ("git" as const) : ("plain" as const),
            remoteWorkspaceDir: transferred.workspaceDir,
            manifestRef: prepared.snapshot.manifestRef,
          });
        } finally {
          await params.workspaceTransfer.revoke(params.environmentId, prepared.token);
        }
      } catch (error) {
        workspaceReady = restoredWorkspace !== undefined;
        throw error;
      }
    },
    quiesceWorkspace: async (remoteWorkspaceDir: string) => {
      await repositoryReadiness.wait();
      return quiesceWorkspace(remoteWorkspaceDir);
    },
    reconcileWorkspace,
  };
}
