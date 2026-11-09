import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import { waitForSessionRunEnd } from "../../sessions/session-controller.native-runtime.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import * as fixture from "./worker-turn-launcher.test-support.js";

const unexpected = (): never => {
  throw new Error("Unexpected shutdown recovery operation");
};
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
