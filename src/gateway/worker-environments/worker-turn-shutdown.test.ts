import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { isAgentRunRestartAbortReason } from "../../agents/run-termination.js";
import { waitForGatewayActiveWork } from "../../infra/gateway-active-work.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createPlacementRecoveryActions } from "./placement-dispatch-recovery.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import { WorkerTurnExecutionError } from "./worker-turn-failure.js";
import * as fixture from "./worker-turn-launcher.test-support.js";
import { captureWorkspaceSnapshot } from "./workspace-manifest-worker.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { createWorkerWorkspaceRecoveryFixture } from "./workspace-recovery.test-support.js";
import {
  applyStagedWorkerWorkspaceResult,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

const unexpected = (): never => {
  throw new Error("Unexpected shutdown recovery operation");
};
beforeEach(fixture.setupWorkerTurnLauncherTest);
afterEach(async () => {
  resetGatewayWorkAdmission();
  await fixture.cleanupWorkerTurnLauncherTest();
});

it("accepts an interrupted worker's completed edit before a fresh turn reuses its machine", async () => {
  const { placements, root, database, ENVIRONMENT_ID, OWNER_EPOCH, SESSION_ID, SESSION_KEY } =
    fixture;
  const remote = path.join(root, "node-workspace");
  const accepted = path.join(root, "accepted-workspace");
  await Promise.all([fs.mkdir(remote), fs.mkdir(accepted)]);
  const base = await captureWorkspaceSnapshot({ root: remote, baseCommit: null });
  await fixture.seedActivePlacement("worker-turn", remote, base.manifestRef);
  const edited = createDeferred();
  const finish = createDeferred();
  const environment = {
    ...fixture.attachedEnvironment(),
    nodeDeviceId: "paired-worker",
    sshEndpoint: null,
  };
  const launchTurn = vi.fn<NonNullable<WorkerTurnTunnelHandle["launchTurn"]>>(async (request) => {
    request.onDispatchReady?.();
    await fs.writeFile(
      path.join(request.plan.assignment.workspaceDir, "restart-proof.txt"),
      "slept-ok\n",
    );
    fixture
      .openSessionManager()
      .appendMessage(makeTextToolResult("sleep", "exec", "slept-ok", false, 1));
    edited.resolve();
    await finish.promise;
    return {
      stdout: "",
      stderr: "worker admission deadline exceeded: Unexpected server response: 503",
      code: 1,
      signal: null,
      killed: false,
      termination: "exit",
    };
  });
  const tunnel: WorkerTurnTunnelHandle = {
    environmentId: ENVIRONMENT_ID,
    ownerEpoch: OWNER_EPOCH,
    measureLaunchTurn: fixture.measureLaunchTurn,
    launchTurn,
    runWorkspaceCommand: unexpected,
    syncWorkspace: unexpected,
    stop: unexpected,
    quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
    reconcileWorkspace: async ({ remoteWorkspaceDir, baseManifestRef, source }) => {
      if (source.kind !== "local" || !source.stagedResult) {
        throw new Error("Expected staged local result");
      }
      const current = await captureWorkspaceSnapshot({
        root: remoteWorkspaceDir,
        baseCommit: null,
      });
      await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
        root: source.path,
        stagingRoot: remoteWorkspaceDir,
        stagedResultRef: source.stagedResult.ref,
        baseManifestRef,
        currentManifestRef: current.manifestRef,
        baseManifestRaw: base.rawManifest,
        currentManifestRaw: current.rawManifest,
        assertCurrent: source.assertCurrent,
      });
      source.stagedResult.record(source.stagedResult.ref);
      const applied = await applyStagedWorkerWorkspaceResult({
        root: source.path,
        stagedResultRef: source.stagedResult.ref,
        expectedBaseManifestRef: baseManifestRef,
        journal: source.journal,
        assertCurrent: source.assertCurrent,
      });
      return { ...applied, verifyStable: async () => {}, getAppliedWorkspaceResult: () => applied };
    },
  };
  const environments = {
    ...fixture.unusedEnvironments(),
    get: () => environment,
    acquireTurnCredential: async () => fixture.credential(),
    acknowledgeCredentialDelivery: async () => true,
    startTunnel: async () => tunnel,
    stopTunnel: vi.fn(async () => {}),
    destroy: vi.fn(async () => environment),
  };
  const resolveWorkspace = async () => ({ kind: "local" as const, path: accepted });
  const execute = async (store: typeof placements, runId: string) => {
    const turn = fixture.turn(runId);
    try {
      return await fixture
        .createWorkerSessionTurnPlacementProvider({
          environments,
          placements: store,
          resolveWorkspace,
        })
        .executeTurn(
          { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId },
          turn,
          unexpected,
        );
    } finally {
      turn.preparedRunAdmission.close();
    }
  };
  const attempt = runWithGatewayIndependentRootWorkAdmission(() =>
    execute(placements, "interrupted-turn"),
  ).catch((error: unknown) => error);
  try {
    await edited.promise;
    const initial = placements.get(SESSION_ID);
    const claim = initial && projectWorkerSessionTurnClaim(initial);
    if (!claim) {
      throw new Error("Expected live worker claim");
    }
    expect(placements.listPendingWorkspaceResults()).toEqual([]); // No finishing ACK yet.
    await expect(fs.readFile(path.join(accepted, "restart-proof.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    markGatewayRestartDraining("stop (SIGTERM)");
    finish.resolve();
    expect(isAgentRunRestartAbortReason(await attempt)).toBe(true);
    await expect(waitForGatewayActiveWork(0)).resolves.toMatchObject({ drained: true });
    expect(placements.get(SESSION_ID)).toMatchObject({
      state: "active",
      turnClaim: { claimId: claim.claimId },
    });

    resetGatewayWorkAdmission();
    const recovered = createWorkerSessionPlacementStore({ database });
    const published = vi.fn(async () => {
      expect(recovered.listPendingWorkspaceResults()[0]?.workspaceAcceptedAtMs).toEqual(
        expect.any(Number),
      );
    });
    const recovery = createPlacementRecoveryActions({
      placements: recovered,
      environments: {
        ...environments,
        fenceWorkerTurnForRecovery: unexpected,
        reconcileEnvironment: async () => {},
        reconcileOnce: async () => {},
        supportsProviderExecutionMode: () => true,
      },
      failure: {
        failActive: unexpected,
        failDraining: unexpected,
        reclaimActive: unexpected,
        retryFailedTeardown: unexpected,
        teardownEnvironment: unexpected,
      },
      workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
      ...createWorkerWorkspaceRecoveryFixture({ resolveWorkspace, reportFailure: unexpected }),
      publishAcceptedWorkspace: published,
    });
    await recovery.reconcile("startup");
    await expect(fs.readFile(path.join(accepted, "restart-proof.txt"), "utf8")).resolves.toBe(
      "slept-ok\n",
    );
    expect(published).toHaveBeenCalledOnce();
    expect(recovered.listPendingWorkspaceResults()).toEqual([]);
    expect(recovered.get(SESSION_ID)).toMatchObject({
      state: "active",
      turnClaim: null,
      environmentId: ENVIRONMENT_ID,
      remoteWorkspaceDir: remote,
    });
    expect(environments.stopTunnel).toHaveBeenCalledWith(ENVIRONMENT_ID, OWNER_EPOCH);
    launchTurn.mockImplementationOnce(async (request) => {
      request.onDispatchReady?.();
      expect(request.turnClaim.claimId).not.toBe(claim.claimId);
      await expect(
        fs.readFile(path.join(request.plan.assignment.workspaceDir, "restart-proof.txt"), "utf8"),
      ).resolves.toBe("slept-ok\n");
      throw new WorkerTurnExecutionError("fresh turn read the retained edit");
    });
    await expect(execute(recovered, "next-turn")).rejects.toThrow(
      "fresh turn read the retained edit",
    );
    expect(launchTurn).toHaveBeenCalledTimes(2);
    expect(environments.destroy).not.toHaveBeenCalled();
  } finally {
    finish.resolve();
    await attempt;
  }
});
