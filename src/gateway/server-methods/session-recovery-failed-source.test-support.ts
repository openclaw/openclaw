import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as gitExec from "../../infra/git-exec.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "../server-worker-placement-reclaim.js";
import {
  createWorkerWorkspaceRecoveryPreparer,
  loadWorkerPlacementSessionRuntimeModule,
} from "../server-worker-placement-session-target.js";
import type { WorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import {
  prepareRetainedRepositoryCheckpoint,
  prepareAcceptedRepositoryDisposal,
} from "../worker-environments/repository-recovery-checkpoint.js";
import {
  stageSessionRepositoryCheckpoint,
  withSessionRepositoryCheckpoint,
} from "../worker-environments/session-repository-checkpoints.js";
import type {
  WorkerEnvironmentRecord,
  WorkerEnvironmentStore,
} from "../worker-environments/store.js";
import { captureWorkspaceSnapshot } from "../worker-environments/workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "../worker-environments/workspace-manifest.js";
import { applyStagedWorkerWorkspace } from "../worker-environments/workspace-reconcile-apply.js";
import { requireWorkspaceResultGit } from "../worker-environments/workspace-result-git.js";

/** Only the GitHub Git transport and provider/enrollment leaves are synthetic. */
export async function prepareFailedSourceRecoveryFixture(params: {
  cfg: OpenClawConfig;
  placements: WorkerSessionPlacementStore;
  store: WorkerEnvironmentStore;
  repository: SessionRepositoryWorkspaceRecord;
  originalEnvironmentId: string;
  originalLeaseId: string;
  sessionId: string;
  oldWorkspaceDir: string;
  freshWorkspaceDir: string;
  resolveFreshWorkspaceDir?: () => string;
}) {
  const { oldWorkspaceDir, placements } = params;
  const repositories = getSessionRepositoryWorkspaceStore();
  const events: string[] = [];
  const destroySnapshots: Array<{
    placement: ReturnType<typeof placements.get>;
    repository: Awaited<ReturnType<typeof repositories.get>>;
    environment: ReturnType<typeof params.store.get>;
  }> = [];
  let afterDestroy: (() => Promise<void>) | undefined;
  await fs.writeFile(path.join(oldWorkspaceDir, "accepted.txt"), "base marker");
  await requireWorkspaceResultGit(oldWorkspaceDir, ["init", "--quiet"]);
  await requireWorkspaceResultGit(oldWorkspaceDir, ["add", "."]);
  await requireWorkspaceResultGit(oldWorkspaceDir, [
    "-c",
    "user.name=Recovery Fixture",
    "-c",
    "user.email=recovery@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "accepted base",
  ]);
  const baseCommit = await requireWorkspaceResultGit(oldWorkspaceDir, ["rev-parse", "HEAD"]);
  const tree = await requireWorkspaceResultGit(oldWorkspaceDir, ["rev-parse", "HEAD^{tree}"]);
  const base = await captureWorkspaceSnapshot({ root: oldWorkspaceDir, baseCommit });
  let repository = await repositories.bindBase({
    workspaceId: params.repository.workspaceId,
    expectedRevision: params.repository.revision,
    baseCommit,
    baseManifestHash: base.manifestRef,
    assertCurrent: () => {},
  });
  await fs.writeFile(path.join(oldWorkspaceDir, "accepted.txt"), "accepted marker");
  const accepted = await captureWorkspaceSnapshot({ root: oldWorkspaceDir, baseCommit });
  const staged = await stageSessionRepositoryCheckpoint({
    workspaceId: repository.workspaceId,
    expectedRevision: repository.revision,
    checkpointRef: "refs/openclaw/worker-results/accepted-before-restart",
    stagingRoot: oldWorkspaceDir,
    baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
    baseManifestRef: base.manifestRef,
    currentManifestRaw: serializeWorkerWorkspaceManifest(accepted.manifest),
    currentManifestRef: accepted.manifestRef,
    assertCurrent: () => {},
  });
  try {
    repository = await staged.publish();
  } finally {
    await staged.discard();
  }
  const acceptedCheckpointRef = repository.checkpointRef;
  await fs.writeFile(path.join(oldWorkspaceDir, "uncertain.txt"), "unaccepted old worker edit");

  const remote = path.join(path.dirname(oldWorkspaceDir), "synthetic-github.git");
  await fs.mkdir(remote);
  await requireWorkspaceResultGit(remote, ["init", "--bare", "--quiet"]);
  await requireWorkspaceResultGit(remote, ["fetch", "--quiet", "--", oldWorkspaceDir, baseCommit]);
  await requireWorkspaceResultGit(remote, ["update-ref", "refs/heads/main", baseCommit]);
  const executeGitCommand = gitExec.executeGitCommand;
  vi.spyOn(gitExec, "executeGitCommand").mockImplementation((cwd, args, options) =>
    executeGitCommand(
      cwd,
      args.map((arg) => (arg === repository.url ? remote : arg)),
      args.includes(repository.url)
        ? { ...options, baseEnv: { ...options?.baseEnv, GIT_ALLOW_PROTOCOL: "file" } }
        : options,
    ),
  );

  const holdFailedLease = vi.fn<NonNullable<WorkerProvider["holdFailedLease"]>>(
    async ({ leaseId }) => {
      events.push("hold");
      expect(leaseId).toBe(params.originalLeaseId);
      return {
        status: "held",
        leaseId,
        unacceptedChanges: "unknown",
        resources: [
          { kind: "vm", id: "fixture-vm", immutableId: "original-vm", state: "retained" },
          { kind: "disk", id: "fixture-disk", immutableId: "original-disk", state: "retained" },
          { kind: "nic", id: "fixture-nic", immutableId: "original-nic", state: "retained" },
          { kind: "public-ip", id: "fixture-ip", immutableId: "original-ip", state: "retained" },
        ],
      };
    },
  );
  const destroy = vi.fn<WorkerProvider["destroy"]>(async ({ leaseId }) => {
    events.push("destroy");
    expect(leaseId).toBe(params.originalLeaseId);
    destroySnapshots.push({
      placement: placements.get(params.sessionId),
      repository: await repositories.get(repository.workspaceId),
      environment: params.store.get(params.originalEnvironmentId),
    });
    await afterDestroy?.();
  });
  const retireNodeEnrollment = vi.fn(async (record: WorkerEnvironmentRecord) => {
    expect(record.environmentId).toBe(params.originalEnvironmentId);
    events.push("retire");
  });
  const barriers = createGatewayWorkerPlacementReclaimBarriers({
    placements,
    loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
    cancelSessionWork: async () => {
      throw new Error("Recovery must preserve the new admission");
    },
    revokeSessionAuthority: () => {
      throw new Error("Recovery cannot replace its original issuer");
    },
  });
  const withPreparedRecovery = createWorkerWorkspaceRecoveryPreparer({
    loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
    getConfig: () => params.cfg,
  });
  return {
    repository,
    originalEnvironmentId: params.originalEnvironmentId,
    baseCommit,
    base,
    repositorySnapshot: { commit: baseCommit, tree },
    acceptedCheckpointRef,
    events,
    holdFailedLease,
    destroy,
    destroySnapshots,
    retireNodeEnrollment,
    setAfterDestroy: (callback: () => Promise<void>) => {
      afterDestroy = callback;
    },
    recoveryOptions: {
      runFailedReclaimBarrier: barriers.runFailedReclaimBarrier,
      withPreparedRecovery,
      prepareRetainedRecoveryCheckpoint: prepareRetainedRepositoryCheckpoint,
      prepareFailedDisposalCheckpoint: prepareAcceptedRepositoryDisposal,
    },
    async restoreFreshCheckpoint(assertCurrent: () => void) {
      assertCurrent();
      const freshWorkspaceDir = params.resolveFreshWorkspaceDir?.() ?? params.freshWorkspaceDir;
      await requireWorkspaceResultGit(freshWorkspaceDir, ["init", "--quiet"]);
      await requireWorkspaceResultGit(freshWorkspaceDir, [
        "fetch",
        "--quiet",
        "--",
        remote,
        baseCommit,
      ]);
      await requireWorkspaceResultGit(freshWorkspaceDir, [
        "checkout",
        "--quiet",
        "--detach",
        baseCommit,
      ]);
      await withSessionRepositoryCheckpoint(
        { workspaceId: repository.workspaceId },
        async (snapshot) => {
          const applied = await applyStagedWorkerWorkspace({
            ...snapshot,
            root: freshWorkspaceDir,
            assertCurrent,
            acceptance: { kind: "reconcile" },
            journal: {
              load: async () => undefined,
              begin: async () => assertCurrent(),
              commit: async () => assertCurrent(),
              abort: async () => assertCurrent(),
            },
          });
          await applied.verifyLocalStable();
          assertCurrent();
        },
      );
      expect(await fs.readFile(path.join(freshWorkspaceDir, "accepted.txt"), "utf8")).toBe(
        "accepted marker",
      );
      await expect(fs.stat(path.join(freshWorkspaceDir, "uncertain.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await fs.readFile(path.join(oldWorkspaceDir, "uncertain.txt"), "utf8")).toBe(
        "unaccepted old worker edit",
      );
    },
  };
}
