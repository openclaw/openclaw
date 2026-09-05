import fsp from "node:fs/promises";
import { NODE_WORKER_WORKSPACE_COMMAND_TIMEOUT_MS } from "../../worker/node-workspace-deadlines.js";
import type { NodeWorkerWorkspaceExecResult } from "../../worker/node-workspace-protocol.js";
import {
  createNodeWorkerWorkspaceFallback,
  recordNodeSyncPath,
} from "./node-worker-workspace-fallback.js";
import type { NodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import type {
  WorkerWorkspaceCommand,
  WorkerWorkspaceSyncResult,
  WorkerWorkspaceTunnelHandle,
} from "./tunnel-contract.js";
import { boundedWorkerError } from "./worker-error.js";
import { runInstrumentedWorkspaceReconcile } from "./workspace-finalize.js";
import { workerProjectSeedKey } from "./workspace-git-base.js";
import {
  measureLocalWorkspaceReconciliation,
  parseRemoteWorkspaceManifestCapture,
  recordRemoteWorkspaceHashMetrics,
  pruneWorkspaceHashMemo,
  withWorkspaceHashMemo,
  type WorkspaceHashMemo,
  type WorkspaceReconcileMetrics,
} from "./workspace-hash-memo.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { createWorkerWorkspaceQuiescence } from "./workspace-quiescence.js";
import {
  applyStagedWorkerWorkspace,
  assertWorkspaceResultStable,
  recoverWorkerWorkspaceReconciliation,
  type WorkerWorkspaceApplyResult,
} from "./workspace-reconcile.js";
import { workerWorkspaceResultStaging } from "./workspace-result-staging.js";

export type NodeWorkerWorkspaceBinding = {
  localPath: string;
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
> & {
  validateRestoredWorkspace: () => Promise<void>;
  getSessionKey: () => string | undefined;
};

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
  runResumeWorkspaceCommand: (
    command: WorkerWorkspaceCommand & { sessionKey?: string },
  ) => Promise<NodeWorkerWorkspaceExecResult>;
}): NodeWorkerWorkspaceActions {
  const { restoredWorkspace } = params;
  let workspaceReady = restoredWorkspace !== undefined;
  let sessionKey = restoredWorkspace?.sessionKey;
  let remoteWorkspaceDir = restoredWorkspace?.remoteWorkspaceDir;
  const exec = async (
    command: WorkerWorkspaceCommand & { resetWorkspace?: boolean },
    run = params.runWorkspaceCommand,
  ) => {
    if (!workspaceReady) {
      throw new Error("node worker workspace is unavailable before sync");
    }
    if (
      command.skillResources &&
      (command.skillResources.workspaceDir !== remoteWorkspaceDir ||
        command.skillResources.generation !== params.ownerEpoch)
    ) {
      throw new Error("Skill resources do not match the node workspace owner");
    }
    return await run({
      ...command,
      ...(sessionKey === undefined ? {} : { sessionKey }),
    });
  };
  const workspace = createNodeWorkerWorkspaceFallback(exec);
  const rememberWorkspace = (result: WorkerWorkspaceSyncResult) => {
    remoteWorkspaceDir = result.remoteWorkspaceDir;
    return result;
  };
  const quiesceWorkspace = createWorkerWorkspaceQuiescence({
    ownerSignal: params.ownerSignal,
    sharedHost: true,
    runWorkspaceCommand: exec,
    runResumeWorkspaceCommand: (command) => exec(command, params.runResumeWorkspaceCommand),
  });
  const validateRestoredWorkspace = async (): Promise<void> => {
    if (!restoredWorkspace) {
      return;
    }
    // Restore transport custody only. The uploaded base is hash-bound to placement;
    // three-way reconciliation owns legitimate changes on either workspace.
    const prepared = await params.workspaceTransfer.prepareSync({
      environmentId: params.environmentId,
      ownerEpoch: params.ownerEpoch,
      sessionId: params.sessionId,
      generation: params.ownerEpoch,
      localPath: restoredWorkspace.localPath,
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
  const reconcileWorkspace = (
    request: Parameters<WorkerWorkspaceTunnelHandle["reconcileWorkspace"]>[0],
  ) => runInstrumentedWorkspaceReconcile((metrics) => reconcileWorkspaceRun(request, metrics));
  const reconcileWorkspaceRun = async (
    request: Parameters<WorkerWorkspaceTunnelHandle["reconcileWorkspace"]>[0],
    metrics: WorkspaceReconcileMetrics,
  ) => {
    pruneWorkspaceHashMemo(placementHashMemo);
    const runLocalReconciliation = <T>(operation: () => Promise<T>): Promise<T> =>
      measureLocalWorkspaceReconciliation(metrics, () =>
        withWorkspaceHashMemo(placementHashMemo, operation, metrics.gateway),
      );
    const pending = request.journal.load();
    if (pending) {
      await recoverWorkerWorkspaceReconciliation({ root: request.localPath, journal: pending });
      request.journal.abort();
    }
    const uploadToken = params.workspaceTransfer.prepareUpload(
      params.environmentId,
      request.baseManifestRef,
    );
    let uploadedResult: Awaited<ReturnType<typeof exec>>;
    try {
      uploadedResult = await exec({
        argv: ["openclaw-internal-workspace-transfer"],
        transfer: {
          direction: "upload",
          token: uploadToken,
          baseManifestRef: request.baseManifestRef,
        },
        timeoutMs: NODE_WORKER_WORKSPACE_COMMAND_TIMEOUT_MS,
        transportRetry: "never",
      });
    } finally {
      params.workspaceTransfer.revoke(params.environmentId, uploadToken);
    }
    if (uploadedResult.termination !== "exit" || uploadedResult.code !== 0) {
      throw new Error("Node workspace reconcile upload failed");
    }
    const uploaded = params.workspaceTransfer.takeUpload(
      params.environmentId,
      request.baseManifestRef,
    );
    try {
      const changed = uploaded.currentManifestRef !== request.baseManifestRef;
      let expectedRemoteRef = uploaded.currentManifestRef;
      const verifyStable = async () => {
        metrics.remoteManifestCalls += 1;
        const startedAt = performance.now();
        const result = await exec({
          argv: ["openclaw-internal-workspace-manifest"],
          capture: {
            baseManifestRef: request.baseManifestRef,
            referenceManifestRef: expectedRemoteRef,
          },
          transportRetry: "idempotent",
          timeoutMs: NODE_WORKER_WORKSPACE_COMMAND_TIMEOUT_MS,
        }).finally(() => {
          metrics.remoteManifestWallDurationMs += performance.now() - startedAt;
        });
        if (result.termination !== "exit" || result.code !== 0) {
          const detail = boundedWorkerError(
            result.stderr.trim() ||
              `${result.termination} (exit code ${result.code}, signal ${result.signal})`,
          );
          throw new Error(`Node workspace manifest capture failed: ${detail}`);
        }
        let captured;
        try {
          captured = parseRemoteWorkspaceManifestCapture(result.stdout);
        } catch (error) {
          throw new Error("Node workspace manifest capture failed: invalid capture result", {
            cause: error,
          });
        }
        recordRemoteWorkspaceHashMetrics(metrics, captured.metrics);
        const observed = captured.manifestRef;
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
          const published = await exec({
            argv: ["openclaw-internal-workspace-transfer"],
            transfer: { direction: "download", token, manifestRef: accepted.manifestRef },
            timeoutMs: NODE_WORKER_WORKSPACE_COMMAND_TIMEOUT_MS,
            transportRetry: "never",
          });
          if (
            published.termination !== "exit" ||
            published.code !== 0 ||
            published.stdout.trim() !== accepted.manifestRef
          ) {
            throw new Error("Node workspace accepted manifest publication failed");
          }
          expectedRemoteRef = accepted.manifestRef;
        } finally {
          params.workspaceTransfer.revoke(params.environmentId, token);
        }
      };
      const preparedStagedResult = request.stagedResult
        ? await runLocalReconciliation(
            async () =>
              await workerWorkspaceResultStaging.prepareRequestedWorkerWorkspaceResult({
                request,
                stagingRoot: uploaded.stagingRoot,
                currentManifestRef: uploaded.currentManifestRef,
                baseManifestRaw: uploaded.baseRaw,
                currentManifestRaw: uploaded.currentRaw,
                publishAcceptedManifest,
              }),
          )
        : undefined;
      let appliedWorkspaceResult: WorkerWorkspaceApplyResult | undefined;
      if (!preparedStagedResult) {
        // Staged results are fenced by the finalizer immediately before apply.
        await verifyStable();
        appliedWorkspaceResult = await runLocalReconciliation(
          async () =>
            await applyStagedWorkerWorkspace({
              root: request.localPath,
              stagingRoot: uploaded.stagingRoot,
              baseManifestRef: request.baseManifestRef,
              currentManifestRef: uploaded.currentManifestRef,
              base: uploaded.base,
              current: uploaded.current,
              journal: request.journal,
              acceptance: { kind: "reconcile", publish: publishAcceptedManifest },
            }),
        );
      }
      return {
        ...(preparedStagedResult
          ? {
              ...preparedStagedResult,
              applyPreparedStagedResult: async () => {
                await runLocalReconciliation(
                  async () => await preparedStagedResult.applyPreparedStagedResult(),
                );
                appliedWorkspaceResult = preparedStagedResult.getAppliedWorkspaceResult();
              },
            }
          : {}),
        get manifestRef() {
          return expectedRemoteRef;
        },
        changed,
        verifyStable,
        verifyLocalStable: async () =>
          await runLocalReconciliation(
            async () =>
              await (preparedStagedResult?.verifyLocalStable() ??
                appliedWorkspaceResult?.verifyLocalStable() ??
                assertWorkspaceResultStable({
                  root: request.localPath,
                  base: uploaded.base,
                  current: uploaded.current,
                })),
          ),
        getAppliedWorkspaceResult: () => appliedWorkspaceResult,
      };
    } finally {
      await fsp.rm(uploaded.stagingRoot, { recursive: true, force: true });
    }
  };
  return {
    validateRestoredWorkspace,
    getSessionKey: () => sessionKey,
    runWorkspaceCommand: exec,
    stageAttachments: async (request) => {
      const prepared = await params.workspaceTransfer.prepareAttachments({
        ...request,
        environmentId: params.environmentId,
      });
      try {
        const result = await exec({
          argv: ["openclaw-internal-workspace-transfer"],
          transfer: {
            direction: "download",
            token: prepared.token,
            manifestRef: prepared.snapshot.manifestRef,
            attachments: true,
          },
          transportRetry: "never",
          assertCurrent: () => {
            if (!request.isAuthorized()) {
              throw new Error("Worker attachment transfer authority closed");
            }
          },
          signal: request.signal,
        });
        if (
          result.termination !== "exit" ||
          result.code !== 0 ||
          result.stdout.trim() !== prepared.snapshot.manifestRef
        ) {
          throw new Error("Worker attachment transfer failed");
        }
      } finally {
        params.workspaceTransfer.revoke(params.environmentId, prepared.token);
      }
    },
    syncWorkspace: async (request) => {
      if (
        request.sessionId !== params.sessionId ||
        (sessionKey !== undefined && request.sessionKey !== sessionKey)
      ) {
        throw new Error("node workspace sync does not match its session owner");
      }
      // The placement key survives subsequent commands and tunnel recovery; callers cannot
      // replace a prepared workspace's bound identity by sending a different command payload.
      sessionKey = request.sessionKey;
      workspaceReady = true;
      try {
        const prepared = await params.workspaceTransfer.prepareSync({
          environmentId: params.environmentId,
          ownerEpoch: params.ownerEpoch,
          sessionId: params.sessionId,
          generation: params.ownerEpoch,
          localPath: request.localPath,
          // Durable owner state is revalidated by the transfer service after every awaited I/O.
          isAuthorized: params.isOwnerCurrent,
          signal: params.ownerSignal,
        });
        try {
          if (!request.projectKey) {
            const originStartedAt = performance.now();
            const origin = await workspace.trySyncWorkspace(request, prepared.snapshot.manifestRef);
            recordNodeSyncPath(params.environmentId, params.sessionId, origin, originStartedAt);
            if (origin.kind === "synced") {
              return rememberWorkspace(await workspace.finalizeSync(request, origin.result));
            }
          }
          const transferred = await exec({
            argv: ["openclaw-internal-workspace-transfer"],
            transfer: {
              direction: "download",
              token: prepared.token,
              manifestRef: prepared.snapshot.manifestRef,
              ...(request.projectKey && prepared.snapshot.manifest.baseCommit
                ? {
                    seedKey: workerProjectSeedKey({
                      key: request.projectKey,
                      baseCommit: prepared.snapshot.manifest.baseCommit,
                    }),
                  }
                : {}),
            },
            timeoutMs: NODE_WORKER_WORKSPACE_COMMAND_TIMEOUT_MS,
            transportRetry: "never",
          });
          if (
            transferred.termination !== "exit" ||
            transferred.code !== 0 ||
            transferred.stdout.trim() !== prepared.snapshot.manifestRef
          ) {
            throw new Error("Node workspace transfer failed");
          }
          return rememberWorkspace(
            await workspace.finalizeSync(request, {
              mode: prepared.snapshot.manifest.baseCommit ? ("git" as const) : ("plain" as const),
              remoteWorkspaceDir: transferred.workspaceDir,
              manifestRef: prepared.snapshot.manifestRef,
            }),
          );
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
