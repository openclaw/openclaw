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
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import { waitForSessionRunEnd } from "../../sessions/session-controller.native-runtime.js";
import { createPlacementRecoveryActions } from "./placement-dispatch-recovery.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import { WorkerTurnExecutionError } from "./worker-turn-failure.js";
import * as fixture from "./worker-turn-launcher.test-support.js";
import { captureWorkspaceSnapshot } from "./workspace-manifest-worker.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { createWorkerWorkspaceRecoveryFixture } from "./workspace-recovery.test-support.js";
import { workerWorkspaceResultStaging } from "./workspace-result-staging.js";

const unexpected = (): never => {
  throw new Error("Unexpected shutdown recovery operation");
};
const editPath = (workspace: string) => path.join(workspace, "restart-proof.txt");
const readEdit = (workspace: string) => fs.readFile(editPath(workspace), "utf8");
function shutdownEnvironments(
  tunnel: WorkerTurnTunnelHandle,
  environment = fixture.attachedEnvironment,
) {
  return fixture.workerTurnEnvironments(tunnel, {
    get: environment,
    acknowledgeCredentialDelivery: async () => true,
    stopTunnel: vi.fn(async () => {}),
    destroy: vi.fn(async () => environment()),
  });
}

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
    await fs.writeFile(editPath(request.plan.assignment.workspaceDir), "slept-ok\n");
    await (
      await fixture.openSessionManager()
    ).appendMessageAsync(makeTextToolResult("sleep", "exec", "slept-ok", false, 1));
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
  const tunnel = fixture.createWorkerTurnTunnel({
    launchTurn,
    runWorkspaceCommand: unexpected,
    syncWorkspace: unexpected,
    stop: unexpected,
    quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
    reconcileWorkspace: async ({ remoteWorkspaceDir, baseManifestRef, source }) => {
      if (source.kind !== "local") {
        throw new Error("Expected staged local result");
      }
      const current = await captureWorkspaceSnapshot({
        root: remoteWorkspaceDir,
        baseCommit: null,
      });
      const staged = await workerWorkspaceResultStaging.prepareRequestedWorkerWorkspaceResult({
        request: {
          localPath: source.path,
          remoteWorkspaceDir,
          baseManifestRef,
          journal: source.journal,
          assertCurrent: source.assertCurrent,
          stagedResult: source.stagedResult,
        },
        stagingRoot: remoteWorkspaceDir,
        currentManifestRef: current.manifestRef,
        baseManifestRaw: base.rawManifest,
        currentManifestRaw: current.rawManifest,
      });
      return {
        manifestRef: current.manifestRef,
        changed: current.manifestRef !== baseManifestRef,
        verifyStable: async () => {},
        ...staged,
      };
    },
  });
  const environments = shutdownEnvironments(tunnel, () => environment);
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
        .executeTurn(fixture.workerTurnRequest(runId), turn, unexpected);
    } finally {
      turn.preparedRunAdmission.close();
    }
  };
  const attempt = runWithGatewayIndependentRootWorkAdmission(() =>
    execute(placements, "interrupted-turn"),
  ).catch((error: unknown) => error);
  try {
    await edited.promise;
    const operation = getSessionControllerOperation(SESSION_KEY);
    const initial = placements.get(SESSION_ID);
    const claim = initial && projectWorkerSessionTurnClaim(initial);
    if (!claim) {
      throw new Error("Expected live worker claim");
    }
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]); // No finishing ACK yet.
    await expect(readEdit(accepted)).rejects.toMatchObject({ code: "ENOENT" });
    markGatewayRestartDraining("stop (SIGTERM)");
    finish.resolve();
    expect(isAgentRunRestartAbortReason(await attempt)).toBe(true);
    expect(operation?.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    await expect(waitForGatewayActiveWork(0)).resolves.toMatchObject({ drained: true });
    expect(placements.get(SESSION_ID)).toMatchObject({
      state: "active",
      turnClaim: { claimId: claim.claimId },
    });

    resetGatewayWorkAdmission();
    const recovered = createWorkerSessionPlacementStore({ database });
    const published = vi.fn(async () => {
      expect(
        (await recovered.listPendingWorkspaceResultsAsync())[0]?.workspaceAcceptedAtMs,
      ).toEqual(expect.any(Number));
    });
    const recovery = createPlacementRecoveryActions(
      {
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
      },
      await recovered.listAsync(),
    );
    await recovery.reconcile("startup");
    await expect(readEdit(accepted)).resolves.toBe("slept-ok\n");
    expect(published).toHaveBeenCalledOnce();
    expect(await recovered.listPendingWorkspaceResultsAsync()).toEqual([]);
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
      await expect(readEdit(request.plan.assignment.workspaceDir)).resolves.toBe("slept-ok\n");
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

it("lets a worker turn that committed its terminal outcome finish through restart drain", async () => {
  const { placements, SESSION_ID, SESSION_KEY } = fixture;
  await fixture.seedActivePlacement();
  const launched = createDeferred();
  const finish = createDeferred();
  let workerSignal: AbortSignal | undefined;
  const launchTurn = vi.fn<WorkerTurnTunnelHandle["launchTurn"]>(async (request) => {
    request.onDispatchReady?.();
    workerSignal = request.signal;
    launched.resolve();
    await finish.promise;
    const leafId = await fixture.appendWorkerReply("finished during drain", 41);
    return fixture.acknowledgeCompletedWorkerTurn(request.turnClaim, leafId);
  });
  const environments = shutdownEnvironments(
    fixture.createWorkerTurnTunnel({
      launchTurn,
      reconcileWorkspace: fixture.reconcileUnchangedLocalWorkspace,
    }),
  );
  const runId = "finishing-turn";
  const turn = fixture.turn(runId);
  const attempt = runWithGatewayIndependentRootWorkAdmission(() =>
    fixture
      .createWorkerSessionTurnPlacementProvider({ environments, placements })
      .executeTurn(fixture.workerTurnRequest(runId), turn, unexpected),
  ).catch((error: unknown) => error);
  try {
    await launched.promise;
    const operation = getSessionControllerOperation(SESSION_KEY);
    // The reply runner freezes cancellation once it accepts a terminal outcome.
    operation?.freezeAbort();
    markGatewayRestartDraining("stop (SIGTERM)");
    expect(workerSignal?.aborted).toBe(false);
    expect(operation?.result).toBeNull();

    finish.resolve();
    expect(await attempt).toMatchObject({ payloads: [{ text: "finished during drain" }] });
    await expect(waitForSessionRunEnd(SESSION_ID)).resolves.toBe(true);
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    expect(environments.destroy).not.toHaveBeenCalled();
  } finally {
    finish.resolve();
    await attempt;
    await waitForSessionRunEnd(SESSION_ID);
    turn.preparedRunAdmission.close();
  }
});
