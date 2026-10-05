import { vi } from "vitest";
import type { WorkerLeaseRecoveryHold } from "../../plugins/types.js";
import { createSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { REQUEST, MANIFEST_REF, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import type { WorkerWorkspaceRetentionNotice } from "./placement-reclaim-contract.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import {
  createRetainedWorkerRecovery,
  type PrepareRetainedRecoveryCheckpoint,
} from "./retained-worker-recovery.js";
import * as support from "./service.test-support.js";

export async function createRetainedRecoveryFixture(holdFailure = false) {
  const environmentId = "worker-retained-source";
  await support.seedReadyNodeDesktop(environmentId);
  await support.testState.store.ensureNodeEnrollment(environmentId);
  const attached = await support.testState.store.transition({
    environmentId,
    from: "ready",
    to: "attached",
    patch: { ...support.attachedPatch(environmentId, REQUEST.sessionId), sharedHost: false },
  });
  const placements = createWorkerSessionPlacementStore({
    database: support.testState.stateDb,
    now: () => support.testState.nowMs,
  });
  const active = await seedActivePlacement(placements, {
    environmentId,
    ownerEpoch: attached.ownerEpoch,
    executionMode: "remote-exec",
  });
  const drained = await placements.startDrain({
    sessionId: active.sessionId,
    environmentId,
    ownerEpoch: attached.ownerEpoch,
    expectedGeneration: active.generation,
  });
  const reconciling = await placements.startReconcile({
    sessionId: active.sessionId,
    environmentId,
    ownerEpoch: attached.ownerEpoch,
    expectedGeneration: drained.generation,
  });
  const failed = await placements.fail({
    sessionId: active.sessionId,
    expectedGeneration: reconciling.generation,
    recoveryError: "worker node disconnected; VM absent",
  });
  if (failed.state !== "failed") {
    throw new Error("Fixture did not fail the source");
  }
  const repositories = createSessionRepositoryWorkspaceStore({
    path: support.testState.stateDb.path,
  });
  let repository = await repositories.create({
    ...REQUEST,
    url: "https://github.com/example/repository.git",
    requestedRef: "main",
    branch: "fix/example",
    assertCurrent: () => {},
  });
  repository = await repositories.bindBase({
    workspaceId: repository.workspaceId,
    expectedRevision: repository.revision,
    baseCommit: "a".repeat(40),
    baseManifestHash: MANIFEST_REF,
    assertCurrent: () => {},
  });
  repository = await repositories.acceptCheckpoint({
    workspaceId: repository.workspaceId,
    expectedRevision: repository.revision,
    checkpointRef: "refs/openclaw/worker-results/accepted-old",
    manifestHash: MANIFEST_REF,
    assertCurrent: () => {},
  });
  const holdFailedLease = vi.fn(
    async ({ leaseId }: { leaseId: string }): Promise<WorkerLeaseRecoveryHold> => {
      if (holdFailure) {
        throw new Error("provider response was lost");
      }
      return {
        leaseId,
        status: "held",
        unacceptedChanges: "unknown",
        resources: [
          { kind: "vm", id: "/retained/vm", state: "absent" },
          { kind: "disk", id: "/retained/disk", immutableId: "disk-original", state: "retained" },
        ],
      };
    },
  );
  const destroy = vi.fn(async () => {});
  const retireNodeEnrollment = vi.fn(async () => {});
  const environments = support.createService(support.createProvider({ holdFailedLease, destroy }), {
    placementStore: createWorkerSessionPlacementGate(placements),
    retireNodeEnrollment,
  });
  const reportRetention = vi.fn(async (_notice: WorkerWorkspaceRetentionNotice) => {});
  const reportConflict = vi.fn(async () => {});
  const prepareCheckpoint = vi.fn<PrepareRetainedRecoveryCheckpoint>(async () => ({
    workspaceId: repository.workspaceId,
    expectedWorkspaceRevision: repository.revision,
    previousCheckpointRef: repository.checkpointRef!,
    checkpointRef: "refs/openclaw/worker-results/reconciled-new",
    manifestHash: `sha256:${"c".repeat(64)}`,
    remoteHeadCommit: "d".repeat(40),
    conflictPaths: ["conflicting-accepted-edit.txt"],
  }));
  const recovery = createRetainedWorkerRecovery({
    environments,
    placements,
    runFailedReclaimBarrier: async ({ reclaim }) => await reclaim(),
    withPreparedRecovery: async (_identity, assertCurrent, run) =>
      run({
        workspace: { kind: "repository", repository },
        assertCurrent,
        resolveConflict: async () => ({ kind: "absent" }),
        reportConflict,
        reportFailure: async () => {},
        reportRetention,
      }),
    prepareCheckpoint,
  });
  return {
    failed,
    environments,
    placements,
    repository,
    repositories,
    recovery,
    holdFailedLease,
    destroy,
    retireNodeEnrollment,
    prepareCheckpoint,
    reportRetention,
    reportConflict,
  };
}
