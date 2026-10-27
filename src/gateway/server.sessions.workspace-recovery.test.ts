import { afterEach, expect, test, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as StateDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import {
  createDispatchEnvironmentFixtures,
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerPlacementRunnerAvailabilityReader } from "./worker-environments/placement-projector.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { writePlacementEnvironmentFixture } from "./worker-environments/placement-test-fixtures.js";
import type { WorkerPlacementDispatchContract } from "./worker-environments/service-contract.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  await disposeSessionReadContexts();
  vi.restoreAllMocks();
  await closeStateDatabaseForTest();
});

test.each([
  ["sessions.delete", "offline runner"],
  ["sessions.patch", "offline runner"],
  ["sessions.patch", "accepted result on offline runner"],
  ["sessions.delete", "available runner"],
  ["sessions.delete", "unknown runner"],
  ["sessions.delete", "stale pending generation"],
  ["sessions.delete", "stale pending environment"],
  ["sessions.delete", "stale pending epoch"],
] as const)("%s: %s", async (method, scenario) => {
  await createSessionStoreDir();
  const { sessionId, sessionKey, agentId } = REQUEST;
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const database = openOpenClawStateDatabase();
  const placements = createWorkerSessionPlacementStore({ database });
  const { attached } = createDispatchEnvironmentFixtures();
  const environment = {
    ...attached,
    providerId: "device",
    profileId: "device:runner-1",
    nodeDeviceId: "runner-1",
    sshEndpoint: null,
  };
  writePlacementEnvironmentFixture(database, environment);
  await seedActivePlacement(placements, environment);
  const claim = await placements.claimTurn({
    sessionId,
    sessionKey,
    agentId,
    claimId: "pending-claim",
    runId: "pending-run",
    owner: {
      kind: "worker",
      environmentId: environment.environmentId,
      ownerEpoch: environment.ownerEpoch,
    },
  });
  await placements.markWorkspaceResultPending(claim);
  if (scenario === "accepted result on offline runner") {
    await placements.acceptWorkspaceResult(claim);
  }
  await placements.handoffWorkspaceResultRecovery(claim);
  const staleFields = {
    "stale pending generation": { placement_generation: claim.placementGeneration - 1 },
    "stale pending environment": { environment_id: "previous-environment" },
    "stale pending epoch": { owner_epoch: environment.ownerEpoch - 1 },
  };
  if (
    scenario === "stale pending generation" ||
    scenario === "stale pending environment" ||
    scenario === "stale pending epoch"
  ) {
    // Retained rows from another owner must never offer destructive recovery.
    executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<Pick<StateDatabase, "worker_workspace_pending_results">>(database.db)
        .updateTable("worker_workspace_pending_results")
        .set(staleFields[scenario])
        .where("session_id", "=", sessionId),
    );
  }
  const runner = createWorkerPlacementRunnerAvailabilityReader({
    environments: { get: () => (scenario === "unknown runner" ? undefined : environment) },
    hasCurrentDeviceRunner: () => scenario === "available runner",
  });
  const reclaim = vi.fn<NonNullable<WorkerPlacementDispatchContract["reclaim"]>>();
  const waitForTurnClaimRelease = vi
    .spyOn(placements, "waitForTurnClaimRelease")
    .mockRejectedValue(new Error("Retained worker turn has not settled"));
  const context = {
    workerSessionPlacementService: placements,
    workerPlacementRunnerAvailabilityReader: runner,
    workerPlacementDispatchService: {
      dispatch: vi.fn<WorkerPlacementDispatchContract["dispatch"]>(),
      reclaim,
    },
  } satisfies Pick<
    GatewayRequestContext,
    | "workerSessionPlacementService"
    | "workerPlacementRunnerAvailabilityReader"
    | "workerPlacementDispatchService"
  >;
  const readState = async () => ({
    entry: (await loadSessionEntryAsync(sessionKey)).entry,
    placement: placements.get(sessionId),
    pending: await placements.listPendingWorkspaceResultsAsync(),
  });
  const before = await readState();
  expect(before.entry?.sessionId).toBe(sessionId);
  expect(before.pending).toHaveLength(1);
  const result = await directSessionReq(
    method,
    {
      key: sessionKey,
      expectedSessionId: sessionId,
      ...(method === "sessions.patch" ? { archived: true } : {}),
    },
    { context },
  );
  const recovery = scenario === "offline runner";
  expect(result).toMatchObject({ ok: false, error: { code: "UNAVAILABLE", retryable: !recovery } });
  if (recovery) {
    expect(result.error?.details).toMatchObject({
      code: "SESSION_WORKSPACE_RECOVERY_REQUIRED",
      cause: "device_offline",
      recoveryAction: "continue_on_gateway",
      sessionId,
      source: {
        generation: claim.placementGeneration,
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
      },
    });
  } else {
    expect(result.error?.details).toBeUndefined();
  }
  expect(waitForTurnClaimRelease).toHaveBeenCalledTimes(recovery ? 0 : 1);
  expect(reclaim).not.toHaveBeenCalled();
  expect(await readState()).toEqual(before);
});
