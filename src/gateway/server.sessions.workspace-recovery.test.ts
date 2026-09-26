import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as StateDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { loadSessionEntry } from "./session-utils.js";
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

type RecoveryScenario =
  | "offline runner"
  | "accepted result on offline runner"
  | "available runner"
  | "unknown runner"
  | "stale pending generation"
  | "stale pending environment"
  | "stale pending epoch";

async function seedPendingWorkspace(scenario: RecoveryScenario) {
  const { dir } = await createSessionStoreDir();
  const { sessionId, sessionKey, agentId } = REQUEST;
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const database = openOpenClawStateDatabase({ path: path.join(dir, "placements.sqlite") });
  const placements = createWorkerSessionPlacementStore({ database });
  const { attached } = createDispatchEnvironmentFixtures();
  const environment = {
    ...attached,
    providerId: "device",
    profileId: "device:runner-1",
    nodeDeviceId: "runner-1",
  };
  writePlacementEnvironmentFixture(database, environment);
  seedActivePlacement(placements, environment);
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
  placements.markWorkspaceResultPending(claim);
  if (scenario === "accepted result on offline runner") {
    placements.acceptWorkspaceResult(claim);
  }
  placements.handoffWorkspaceResultRecovery(claim);
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
  const before = {
    entry: loadSessionEntry(sessionKey).entry,
    placement: placements.get(sessionId),
    pending: placements.listPendingWorkspaceResults(),
  };
  expect(before.entry?.sessionId).toBe(sessionId);
  expect(before.pending).toHaveLength(1);
  return {
    context,
    source: {
      generation: claim.placementGeneration,
      environmentId: environment.environmentId,
      ownerEpoch: environment.ownerEpoch,
    },
    reclaim,
    waitForTurnClaimRelease,
    expectPreserved() {
      expect(loadSessionEntry(sessionKey).entry).toEqual(before.entry);
      expect(placements.get(sessionId)).toEqual(before.placement);
      expect(placements.listPendingWorkspaceResults()).toEqual(before.pending);
    },
  };
}

describe.each([
  { action: "Delete", method: "sessions.delete", patch: {} },
  { action: "Archive", method: "sessions.patch", patch: { archived: true } },
] as const)("$action pending workspace results", ({ method, patch }) => {
  test("offers recovery for an offline device without discarding its result", async () => {
    const fixture = await seedPendingWorkspace("offline runner");
    const result = await directSessionReq(
      method,
      { key: REQUEST.sessionKey, expectedSessionId: REQUEST.sessionId, ...patch },
      { context: fixture.context },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        retryable: false,
        details: {
          code: "SESSION_WORKSPACE_RECOVERY_REQUIRED",
          cause: "device_offline",
          recoveryAction: "continue_on_gateway",
          sessionId: REQUEST.sessionId,
          source: fixture.source,
        },
      },
    });
    expect(fixture.waitForTurnClaimRelease).not.toHaveBeenCalled();
    expect(fixture.reclaim).not.toHaveBeenCalled();
    fixture.expectPreserved();
  });

  test.each([
    "accepted result on offline runner",
    "available runner",
    "unknown runner",
    "stale pending generation",
    "stale pending environment",
    "stale pending epoch",
  ] as const)("keeps the ordinary drain for %s", async (scenario) => {
    const fixture = await seedPendingWorkspace(scenario);
    const result = await directSessionReq(
      method,
      { key: REQUEST.sessionKey, expectedSessionId: REQUEST.sessionId, ...patch },
      { context: fixture.context },
    );

    expect(result).toMatchObject({ ok: false, error: { code: "UNAVAILABLE", retryable: true } });
    expect(result.error?.details).toBeUndefined();
    expect(fixture.waitForTurnClaimRelease).toHaveBeenCalledOnce();
    expect(fixture.reclaim).not.toHaveBeenCalled();
    fixture.expectPreserved();
  });
});
