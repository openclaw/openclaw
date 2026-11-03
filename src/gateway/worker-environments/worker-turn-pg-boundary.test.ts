import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { WORKER_PROTOCOL_FEATURES } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { assertEngineStoreExecutionAllowed } from "../../infra/database-engine/admission-scope.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { result as workerCommandResult } from "./bootstrap.test-support.js";
import { WorkerRunnerCapacityError, type WorkerTunnelHandle } from "./tunnel-contract.js";
import { environmentForTunnel } from "./worker-turn-launcher-flow.test-support.js";
import {
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  createWorkerTurnTunnel,
  placements,
  seedActivePlacement,
  reconcileUnchangedLocalWorkspace,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
} from "./worker-turn-launcher.test-support.js";

afterAll(closeStateDatabaseForTest);
beforeEach(setupWorkerTurnLauncherTest);
afterEach(() => cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));

it("prepares fresh and follow-up worker turns without Gateway-thread database queries", async () => {
  await seedActivePlacement();
  const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async () => {
    throw new WorkerRunnerCapacityError();
  });
  const tunnel = createWorkerTurnTunnel({
    launchTurn,
    runWorkspaceCommand: vi.fn(async (command) => {
      command.assertCurrent?.();
      expect(JSON.parse(command.input ?? "null")).toEqual({ op: "discover" });
      return workerCommandResult();
    }),
    reconcileWorkspace: reconcileUnchangedLocalWorkspace,
  });
  const environment = attachedEnvironment();
  environment.bootstrapReceipt = {
    ...environment.bootstrapReceipt!,
    protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
  };
  const provider = createWorkerSessionTurnPlacementProvider({
    placements,
    environments: environmentForTunnel({
      get: () => environment,
      startTunnel: async () => tunnel,
    }),
  });
  const sql = observeMainThreadSql({ onStatement: assertEngineStoreExecutionAllowed });
  try {
    for (const runId of ["fresh-pg-boundary", "followup-pg-boundary"]) {
      const input = turn(runId);
      try {
        await expect(
          provider.executeTurn({ ...sessionTarget, runId: input.runId }, input, vi.fn()),
        ).rejects.toBeInstanceOf(WorkerRunnerCapacityError);
      } finally {
        input.preparedRunAdmission.close();
      }
    }
    expect(launchTurn).toHaveBeenCalledTimes(2);
    sql.expectIdle();
  } finally {
    sql.restore();
  }
});
