import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { WorkerRunnerCapacityError, type WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  createWorkerTurnTunnel,
  credential,
  placements,
  reconcileUnchangedLocalWorkspace,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";

afterAll(closeStateDatabaseForTest);
beforeEach(setupWorkerTurnLauncherTest);
afterEach(() => cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));
afterEach(resetGlobalHookRunner);

it("offers neither the sessions_yield tool nor yield guidance to a worker turn", async () => {
  await seedActivePlacement();
  const authorize = vi.spyOn(placements, "authorizeWorkerTurnTools");
  const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async () => {
    throw new WorkerRunnerCapacityError();
  });
  const tunnel = createWorkerTurnTunnel({
    runWorkspaceCommand: vi.fn(),
    syncWorkspace: vi.fn(),
    reconcileWorkspace: vi.fn(reconcileUnchangedLocalWorkspace),
    stop: vi.fn(),
    launchTurn,
  });
  const provider = createWorkerSessionTurnPlacementProvider({
    placements,
    environments: {
      ...unusedEnvironments(),
      get: attachedEnvironment,
      acquireTurnCredential: async () => credential(),
      startTunnel: async () => tunnel,
    },
  });
  const input = turn("worker-yield-withheld");
  try {
    await expect(
      provider.executeTurn({ ...sessionTarget, runId: input.runId }, input, vi.fn()),
    ).rejects.toBeInstanceOf(WorkerRunnerCapacityError);
    const authorized = authorize.mock.calls[0]?.[1];
    expect(authorized).toEqual(expect.arrayContaining(["sessions_spawn"]));
    expect(authorized).not.toContain("sessions_yield");
    expect(launchTurn.mock.calls[0]![0].plan.assignment.systemPrompt).not.toContain(
      "sessions_yield",
    );
  } finally {
    authorize.mockRestore();
    input.preparedRunAdmission.close();
  }
});
