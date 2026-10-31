import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { createSessionPlacementFactsReader } from "./server-methods/sessions-read-cache.test-support.js";
import {
  disposeSessionReadContexts,
  trackSessionReadProjection,
} from "./session-read-contexts.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import type { GatewaySessionRow } from "./session-utils.types.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import type { WorkerPlacementMoveIntent } from "./worker-environments/placement-move-intent.types.js";
import type { WorkerSessionPlacementReader } from "./worker-environments/placement-projector.js";
import { placementTurnOwner } from "./worker-environments/placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementRecord,
} from "./worker-environments/placement-store.js";
import {
  activePlacement,
  journalOwner,
  placementTransition,
} from "./worker-environments/placement-suite.test-support.js";
import {
  advancePlacementFixtureToActive,
  writePlacementEnvironmentFixture,
} from "./worker-environments/placement-test-fixtures.js";
import type { WorkerEnvironmentServiceRecord } from "./worker-environments/service-contract.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  await disposeSessionReadContexts();
  await closeStateDatabaseForTest();
});

function activePlacementRecord(): Extract<WorkerSessionPlacementRecord, { state: "active" }> {
  return activePlacement("sess-main", {
    sessionKey: "agent:main:main",
    environmentId: "env-placement",
    activeOwnerEpoch: 12,
    lastTranscriptAckCursor: 23,
    lastLiveEventAckCursor: 9,
  });
}

async function seedSessionRows(): Promise<void> {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: { sessionId: "sess-main", updatedAt: 200 },
      "agent:main:other": { sessionId: "sess-other", updatedAt: 100 },
    },
  });
}

function placementContext(
  placement: WorkerSessionPlacementRecord,
  environment?: Pick<WorkerEnvironmentServiceRecord, "ownerEpoch" | "state"> &
    Partial<WorkerEnvironmentServiceRecord>,
) {
  return {
    workerSessionPlacementService: {
      getMany: () => new Map([[placement.sessionId, placement]]),
    },
    workerEnvironmentService: {
      get: (): WorkerEnvironmentServiceRecord | undefined =>
        environment
          ? {
              environmentId: placement.environmentId ?? "env-placement",
              providerId: "machine0",
              profileId: "team",
              leaseId: null,
              resourceReceipt: null,
              retention: null,
              sharedHost: null,
              createdAtMs: 100,
              idleSinceAtMs: null,
              destroyRequestedAtMs: null,
              attachedSessionIds: [],
              desktopAvailable: false,
              desktopApps: [],
              tunnelStatus: "stopped",
              ...environment,
            }
          : undefined,
      readMachineShape: () => undefined,
      machineShapeVersion: () => 0,
      inventoryVersion: () => 0,
    },
  };
}

function placementMove(
  placement: Extract<WorkerSessionPlacementRecord, { state: "active" }>,
): WorkerPlacementMoveIntent {
  return {
    operationId: "move:v1:opaque",
    sessionId: placement.sessionId,
    source: {
      generation: placement.generation,
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
    },
    target: { kind: "gateway" },
    abandonSource: false,
    lastError: null,
    createdAtMs: 320,
    updatedAtMs: 340,
  };
}

async function describePlacement(
  context: NonNullable<Parameters<typeof directSessionReq>[2]>["context"],
  key = "main",
) {
  const result = await directSessionReq<{ session: GatewaySessionRow | null }>(
    "sessions.describe",
    { key },
    { context },
  );
  expect(result.ok).toBe(true);
  return result.payload?.session;
}

function failedPlacement(
  overrides: Partial<Extract<WorkerSessionPlacementRecord, { state: "failed" }>> = {},
) {
  return {
    ...activePlacementRecord(),
    state: "failed" as const,
    turnClaim: null,
    recoveryError: "cloud worker disappeared: provider reported lease destroyed",
    terminalReason: "cloud worker disappeared: provider reported lease destroyed",
    terminalAtMs: 400,
    ...overrides,
  } satisfies WorkerSessionPlacementRecord;
}

test.each([
  { name: "matching owner epoch", ownerEpoch: 12, expectedIdentity: true },
  { name: "mismatched owner epoch", ownerEpoch: 13, expectedIdentity: false },
])(
  "sessions.list retains durable worker placement for resident rows: $name",
  async ({ ownerEpoch, expectedIdentity }) => {
    await seedSessionRows();
    const placement = activePlacementRecord();
    const getMany = vi.fn<WorkerSessionPlacementReader["getMany"]>((sessionIds) => {
      return new Map(
        sessionIds.includes(placement.sessionId) ? [[placement.sessionId, placement]] : [],
      );
    });
    const diskSpace = {
      status: "warning" as const,
      availableBytes: 400,
      totalBytes: 1_000,
      observedAtMs: 350,
    };
    const identity = {
      providerId: "machine0",
      profileId: "team",
      machine: { class: "medium", os: "linux", osLabel: "Linux", cpu: 4, memoryGb: 16 },
    };
    const getEnvironment = vi.fn((environmentId: string) =>
      ownerEpoch !== undefined && environmentId === placement.environmentId
        ? { ...identity, ownerEpoch, state: "attached" }
        : undefined,
    );
    const context = {
      workerSessionPlacementService: { getMany },
      workerEnvironmentService: {
        get: getEnvironment,
        readMachineShape: () => identity.machine,
        machineShapeVersion: () => 0,
        inventoryVersion: () => 0,
      },
      workerPlacementDiskSpaceReader: { read: () => diskSpace, version: () => 1 },
      workerPlacementRunnerAvailabilityReader: {
        read: () => ({ kind: "device", status: "offline" }),
        version: () => 1,
      },
    };
    const result = await directSessionReq<{ sessions: GatewaySessionRow[] }>(
      "sessions.list",
      {},
      { context },
    );

    expect(result.ok).toBe(true);
    const main = result.payload?.sessions.find((session) => session.sessionId === "sess-main");
    const other = result.payload?.sessions.find((session) => session.sessionId === "sess-other");
    expect(main?.placement).toMatchObject({
      state: "active",
      environmentId: "env-placement",
      activeOwnerEpoch: 12,
      lastTranscriptAckCursor: 23,
      lastLiveEventAckCursor: 9,
      diskSpace,
      runner: { kind: "device", status: "offline" },
    });
    if (expectedIdentity) {
      expect(main?.placement).toMatchObject(identity);
    } else {
      expect(main?.placement).not.toHaveProperty("providerId");
      expect(main?.placement).not.toHaveProperty("profileId");
      expect(main?.placement).not.toHaveProperty("machine");
    }
    expect(other?.placement).toBeUndefined();
    getMany.mockClear();
    expect((await directSessionReq("sessions.list", {}, { context })).ok).toBe(true);
    expect(getMany).not.toHaveBeenCalled();
  },
);

test("sessions.describe preserves pre-epoch identity while starting", async () => {
  await seedSessionRows();
  const placement = {
    ...activePlacementRecord(),
    state: "starting" as const,
    activeOwnerEpoch: null,
    turnClaim: null,
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
  } satisfies WorkerSessionPlacementRecord;
  const session = await describePlacement(
    placementContext(placement, {
      ownerEpoch: 0,
      state: "provisioning",
    }),
  );
  expect(session?.placement).toMatchObject({
    state: "starting",
    providerId: "machine0",
    profileId: "team",
  });
});

test.each([
  ["without an environment", undefined, 12, false, false],
  ["with matching terminal environment provenance", 12, 12, true, false],
  ["without identity when no owner epoch was retained", 12, null, false, false],
  ["while a move still owns recovery", 13, 12, false, true],
] as const)(
  "sessions.describe projects a durable terminal reason %s",
  async (_name, ownerEpoch, activeOwnerEpoch, identity, retryBlock) => {
    await seedSessionRows();
    const active = activePlacementRecord();
    const placement = failedPlacement({ activeOwnerEpoch });
    const move = placementMove(active);
    const context = placementContext(
      placement,
      ownerEpoch === undefined
        ? undefined
        : {
            ownerEpoch,
            state: "destroyed",
          },
    );
    const projection = await createSessionRowProjection({
      cfg: (await getGatewayConfigModule()).getRuntimeConfig(),
      context,
      placementFactsReader: createSessionPlacementFactsReader(
        context.workerSessionPlacementService,
        context.workerEnvironmentService.get,
        new Map(retryBlock ? [[placement.sessionId, move]] : []),
      ),
    });
    trackSessionReadProjection(projection);

    const session = await describePlacement(bindSessionRowProjection(context, () => projection));
    const projected = session?.placement;
    expect(projected).toMatchObject({
      state: "failed",
      recoveryAction: "restart",
      terminalReason: "cloud worker disappeared: provider reported lease destroyed",
      terminalAtMs: 400,
    });
    if (ownerEpoch !== undefined && activeOwnerEpoch !== null && !retryBlock) {
      expect(projected).toHaveProperty("retryOnSend", true);
    } else {
      expect(projected).not.toHaveProperty("retryOnSend");
    }
    if (identity) {
      expect(projected).toMatchObject({ providerId: "machine0", profileId: "team" });
    } else {
      expect(projected).not.toHaveProperty("providerId");
      expect(projected).not.toHaveProperty("profileId");
    }
  },
);

function seedFailedPlacementWithRetainedResult(database: OpenClawStateDatabase, sessionId: string) {
  // Older terminal rows can retain unaccepted results beyond the active generation.
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.prepare(`UPDATE worker_session_placements SET turn_claim_owner = NULL,
        turn_claim_id = NULL, turn_claim_run_id = NULL, turn_claim_generation = NULL,
        turn_claim_owner_epoch = NULL WHERE session_id = ?`).run(sessionId);
      db.prepare(`UPDATE worker_session_placements SET state = 'failed',
        transition_generation = transition_generation + 3,
        recovery_error = 'previous worker failure', terminal_reason = 'previous worker failure',
        terminal_at_ms = 1 WHERE session_id = ?`).run(sessionId);
    },
    { database },
  );
}

test.each([
  { recovery: "unstaged result", executionMode: "remote-exec" },
  { recovery: "rollback journal", executionMode: "worker-turn" },
] as const)(
  "sessions.describe waits for retained $recovery before offering retry on send",
  async ({ recovery, executionMode }) => {
    const { dir } = await createSessionStoreDir();
    const identity = {
      sessionId: "sess-retained-recovery",
      sessionKey: "agent:main:retained-recovery",
      agentId: "main",
    };
    await writeSessionStore({
      entries: { [identity.sessionKey]: { sessionId: identity.sessionId, updatedAt: 200 } },
    });
    const database = openOpenClawStateDatabase({ path: path.join(dir, "placements.sqlite") });
    const placements = createWorkerSessionPlacementStore({ database });
    const active = await advancePlacementFixtureToActive(placements, database, {
      ...identity,
      executionMode,
    });
    const owner = journalOwner(active);
    if (recovery === "unstaged result") {
      const claim = await placements.claimTurn({
        ...identity,
        owner: placementTurnOwner(active),
        claimId: "retained-claim",
        runId: "retained-run",
      });
      await placements.markWorkspaceResultPending(claim);
    } else {
      const basePack = Buffer.from("retained workspace rollback");
      await placements.beginWorkspaceReconciliation(owner, {
        version: 1,
        temporaryNonce: "a".repeat(32),
        baseManifestRef: active.workspaceBaseManifestRef,
        currentManifestRef: `sha256:${"c".repeat(64)}`,
        baseEntries: [],
        appliedEntries: [],
        baseTree: "f".repeat(40),
        basePackSha256: createHash("sha256").update(basePack).digest("hex"),
        basePack,
      });
    }
    if (recovery === "unstaged result") {
      seedFailedPlacementWithRetainedResult(database, identity.sessionId);
    } else {
      const transition = placementTransition(active);
      const draining = await placements.startDrain(transition);
      const reconciling = await placements.startReconcile({
        ...transition,
        expectedGeneration: draining.generation,
      });
      await placements.fail({
        sessionId: identity.sessionId,
        expectedGeneration: reconciling.generation,
        recoveryError: "previous worker failure",
      });
    }
    writePlacementEnvironmentFixture(database, {
      environmentId: active.environmentId,
      state: "destroyed",
      ownerEpoch: active.activeOwnerEpoch + 1,
      attachedSessionIds: [],
    });
    const cfg = (await getGatewayConfigModule()).getRuntimeConfig();
    const context = {
      getRuntimeConfig: () => cfg,
      workerSessionPlacementService: placements,
      workerEnvironmentService: {
        get: () => undefined,
        readMachineShape: () => undefined,
      },
    };
    const projection = await createSessionRowProjection({
      cfg,
      context,
      placementFactsReader: placements,
    });
    trackSessionReadProjection(projection);
    const bound = bindSessionRowProjection(context, () => projection);
    const describe = () => describePlacement(bound, identity.sessionKey);
    const blocked = await describe();
    expect(blocked?.placement).toMatchObject({
      state: "failed",
      recoveryAction: "restart",
    });
    expect(blocked?.placement).not.toHaveProperty("retryOnSend");
    expect(blocked?.placement).not.toHaveProperty("workspaceResultReconciling");

    if (recovery === "unstaged result") {
      const pending = await placements.listPendingWorkspaceResultsAsync(identity.sessionId);
      expect(pending).toHaveLength(1);
      await placements.abandonWorkspaceResult(pending[0]!);
    } else {
      await placements.abortWorkspaceReconciliation(owner, { force: true });
    }
    const ready = await describe();
    expect(ready).toMatchObject({
      sessionId: identity.sessionId,
      placement: { ...blocked?.placement, retryOnSend: true },
    });
  },
);

test("sessions.describe requires worker teardown before failed-placement restart", async () => {
  await seedSessionRows();
  const placement = failedPlacement({
    recoveryError: "worker unavailable",
    terminalReason: "worker unavailable",
  });
  const session = await describePlacement(
    placementContext(placement, {
      ownerEpoch: 12,
      state: "failed",
      leaseId: "lease-live",
    }),
  );
  expect(session?.placement).toMatchObject({
    state: "failed",
    recoveryAction: "stop-first",
  });
});
