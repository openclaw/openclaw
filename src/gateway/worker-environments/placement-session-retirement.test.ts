import { expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import {
  createPlacementSessionRetirement,
  type PlacementSessionEvidenceResolver,
} from "./placement-session-retirement.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementRetirement,
} from "./placement-store.js";
import {
  activePlacement,
  localPlacement,
  sessionIdentity,
} from "./placement-suite.test-support.js";

function createHarness(records: WorkerSessionPlacementRecord[]) {
  const placements = new Map(records.map((record) => [record.sessionId, record]));
  const destroyed = new Set<string>();
  const retired: WorkerSessionPlacementRetirement[] = [];
  const resolveSessionEvidence = vi.fn<PlacementSessionEvidenceResolver>(async () => "absent");
  const createSessionEvidenceResolver = vi.fn(
    async (): Promise<PlacementSessionEvidenceResolver> => resolveSessionEvidence,
  );
  const forceDestroyEnvironment = vi.fn(async (environmentId: string) => {
    destroyed.add(environmentId);
    for (const record of placements.values()) {
      if (record.environmentId === environmentId && record.state === "active") {
        placements.set(record.sessionId, {
          ...record,
          state: "failed",
          generation: record.generation + 1,
          turnClaim: null,
          recoveryError: "forced teardown",
          terminalReason: "failed",
          terminalAtMs: 2,
        });
      }
    }
  });
  const listAsync = vi.fn(async () => [...placements.values()]);
  const retireSessionPlacementAsync = vi.fn(async (input: WorkerSessionPlacementRetirement) => {
    const current = placements.get(input.sessionId);
    if (
      current?.state !== input.expectedState ||
      current.generation !== input.expectedGeneration ||
      current.turnClaim
    ) {
      throw new Error("placement changed");
    }
    placements.delete(input.sessionId);
    retired.push(input);
  });
  const retirement = createPlacementSessionRetirement({
    placements: {
      getAsync: async (sessionId) => placements.get(sessionId),
      getManyAsync: async (sessionIds) =>
        new Map([...placements].filter(([sessionId]) => sessionIds.includes(sessionId))),
      listAsync,
      retireSessionPlacementAsync,
    },
    environments: {
      get: (environmentId) => {
        if (!records.some((record) => record.environmentId === environmentId)) {
          return undefined;
        }
        return {
          environmentId,
          state: destroyed.has(environmentId) ? "destroyed" : "attached",
          leaseId: destroyed.has(environmentId) ? null : `lease:${environmentId}`,
        } as never;
      },
    },
    forceDestroyEnvironment,
    createSessionEvidenceResolver,
    reportChanges: (operation) => operation(),
    warn: vi.fn(),
  });
  return {
    createSessionEvidenceResolver,
    forceDestroyEnvironment,
    placements,
    listAsync,
    retireSessionPlacementAsync,
    resolveSessionEvidence,
    retired,
    retirement,
  };
}

it("reuses evidence until invalidation, including receipts during discovery", async () => {
  const placement = localPlacement("session-current");
  const harness = createHarness([placement]);
  const uninstall = harness.retirement.installMaintenancePreservation({
    prepareMaintenancePlacements: async () => ({
      placements: [],
      assertCurrent: () => {},
      release: () => {},
    }),
  });
  try {
    harness.resolveSessionEvidence.mockResolvedValue("current");
    await harness.retirement.reconcile();
    await harness.retirement.reconcile();
    expect(harness.listAsync).toHaveBeenCalledTimes(1);

    sessionChanges.emit({ all: true, scope: "config" });
    harness.listAsync.mockImplementationOnce(async () => {
      sessionChanges.emit({ all: true, scope: "stores" });
      return [placement];
    });
    await harness.retirement.reconcile();
    harness.resolveSessionEvidence.mockResolvedValue("absent");
    await harness.retirement.reconcile();
    expect(harness.placements.has(placement.sessionId)).toBe(false);
    expect(harness.retired).toEqual([
      { sessionId: placement.sessionId, expectedState: "local", expectedGeneration: 1 },
    ]);
    expect(harness.forceDestroyEnvironment).not.toHaveBeenCalled();
  } finally {
    uninstall();
  }
});

it("fences the environment before retiring its failed placement", async () => {
  const sessionId = "session-active";
  const harness = createHarness([activePlacement(sessionId)]);
  await harness.retirement.reconcile();
  expect(harness.retired).toEqual([{ sessionId, expectedState: "failed", expectedGeneration: 3 }]);
  expect(harness.forceDestroyEnvironment).toHaveBeenCalledWith(
    `environment:${sessionId}`,
    expect.any(Function),
  );
});

it("retires only ownerless requested placements for absent sessions", async () => {
  const dirs = createTempDirTracker();
  const root = dirs.make("openclaw-placement-retirement-");
  const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  const placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  const requested = await placements.startDispatch(sessionIdentity("session-requested"));
  const ownedIdentity = sessionIdentity("session-owned-requested");
  const ownedClaim = await placements.claimTurn({
    ...ownedIdentity,
    owner: { kind: "local" },
    claimId: "requested-owner-claim",
    runId: "requested-owner-run",
  });
  const ownedRequested = await placements.startDispatch(ownedIdentity);
  const retireSessionPlacement = vi.spyOn(placements, "retireSessionPlacementAsync");
  const forceDestroyEnvironment = vi.fn();
  const warn = vi.fn();
  const retirement = createPlacementSessionRetirement({
    placements,
    environments: { get: () => undefined },
    forceDestroyEnvironment,
    createSessionEvidenceResolver: async () => async () => "absent",
    reportChanges: (operation) => operation(),
    warn,
  });

  try {
    await retirement.reconcile();

    expect(retireSessionPlacement).toHaveBeenCalledExactlyOnceWith({
      sessionId: requested.sessionId,
      expectedState: "requested",
      expectedGeneration: requested.generation,
    });
    expect(placements.get(requested.sessionId)).toBeUndefined();
    expect(placements.get(ownedRequested.sessionId)).toMatchObject({
      state: "requested",
      generation: ownedRequested.generation,
      turnClaim: {
        owner: "local",
        claimId: ownedClaim.claimId,
        runId: ownedClaim.runId,
      },
    });
    expect(warn).toHaveBeenCalledWith(
      `Retired ownerless worker placement ${requested.sessionId} because its authoritative session is absent (requested@${requested.generation})`,
    );
    expect(forceDestroyEnvironment).not.toHaveBeenCalled();
  } finally {
    await closeStateDatabaseForTest();
    dirs.cleanup();
  }
});

it("checks only changed placement identities", async () => {
  const first = localPlacement("session-one");
  const second = localPlacement("session-two");
  const harness = createHarness([first, second]);
  harness.resolveSessionEvidence.mockResolvedValue("current");

  await harness.retirement.reconcile();
  await harness.retirement.reconcile();
  await harness.retirement.reconcile();

  expect(harness.listAsync).toHaveBeenCalledOnce();
  expect(harness.createSessionEvidenceResolver).toHaveBeenCalledExactlyOnceWith(
    [first, second],
    undefined,
  );

  harness.resolveSessionEvidence.mockResolvedValue("absent");
  harness.retirement.markPending(first.sessionId);
  await harness.retirement.reconcile();

  expect(harness.createSessionEvidenceResolver).toHaveBeenLastCalledWith([first], undefined);
  expect(harness.placements.has(first.sessionId)).toBe(false);
  expect(harness.placements.has(second.sessionId)).toBe(true);
  expect(harness.listAsync).toHaveBeenCalledOnce();
});

it.each(["unknown", "read", "write", "teardown"] as const)(
  "retries %s failures without losing pending cleanup",
  async (failure) => {
    const placement =
      failure === "teardown" ? activePlacement("session-retry") : localPlacement("session-retry");
    const harness = createHarness([placement]);
    if (failure === "unknown") {
      harness.resolveSessionEvidence.mockResolvedValueOnce("unknown");
    } else if (failure === "read") {
      harness.listAsync.mockRejectedValueOnce(new Error("reader unavailable"));
    } else if (failure === "write") {
      harness.retireSessionPlacementAsync.mockRejectedValueOnce(new Error("writer unavailable"));
    } else {
      harness.forceDestroyEnvironment.mockRejectedValueOnce(new Error("provider unavailable"));
    }

    if (failure === "read") {
      await expect(harness.retirement.reconcile()).rejects.toThrow("reader unavailable");
    } else {
      await harness.retirement.reconcile();
    }
    expect(harness.placements.has(placement.sessionId)).toBe(true);

    await harness.retirement.reconcile();

    expect(harness.placements.has(placement.sessionId)).toBe(false);
    expect(harness.retired).toHaveLength(1);
  },
);

it("retains queued changes across evidence reads", async () => {
  const placement = localPlacement("session-changing");
  const harness = createHarness([placement]);
  const started = createDeferredCore();
  const release = createDeferredCore();
  harness.createSessionEvidenceResolver.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    return async () => "current";
  });

  const reconciling = harness.retirement.reconcile();
  try {
    await started.promise;
    harness.retirement.markPending(placement.sessionId);
  } finally {
    release.resolve();
    await reconciling;
  }
  await harness.retirement.reconcile();

  expect(harness.placements.has(placement.sessionId)).toBe(false);
  expect(harness.retired).toHaveLength(1);
});
