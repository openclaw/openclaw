import { expect, it, vi } from "vitest";
import { getWorkerMessageMetrics } from "../../infra/worker-message-metrics.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
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
  const listSessionIdentitiesAsync = vi.fn(async () => [...placements.values()]);
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
      listSessionIdentitiesAsync,
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
    listSessionIdentitiesAsync,
    retireSessionPlacementAsync,
    resolveSessionEvidence,
    retired,
    retirement,
  };
}

it("checks changed identities and invalidates evidence, including changes during discovery", async () => {
  const placement = localPlacement("session-current");
  const second = localPlacement("session-other");
  const harness = createHarness([placement, second]);
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
    expect(harness.createSessionEvidenceResolver).toHaveBeenCalledExactlyOnceWith(
      [placement, second],
      undefined,
    );
    harness.resolveSessionEvidence.mockResolvedValue("absent");
    harness.retirement.markPending(placement.sessionId);
    await harness.retirement.reconcile();
    expect(harness.createSessionEvidenceResolver).toHaveBeenLastCalledWith([placement], undefined);
    expect(harness.placements.has(placement.sessionId)).toBe(false);
    expect(harness.placements.has(second.sessionId)).toBe(true);
    expect(harness.listSessionIdentitiesAsync).toHaveBeenCalledOnce();

    harness.resolveSessionEvidence.mockResolvedValue("current");
    sessionChanges.emit({ all: true, scope: "config" });
    harness.listSessionIdentitiesAsync.mockImplementationOnce(async () => {
      sessionChanges.emit({ all: true, scope: "stores" });
      return [second];
    });
    await harness.retirement.reconcile();
    harness.resolveSessionEvidence.mockResolvedValue("absent");
    await harness.retirement.reconcile();
    expect(harness.placements.size).toBe(0);
    expect(harness.retired).toEqual([
      { sessionId: placement.sessionId, expectedState: "local", expectedGeneration: 1 },
      { sessionId: second.sessionId, expectedState: "local", expectedGeneration: 1 },
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

it("bounds discovery replies, preserves local identities, and retires only ownerless placements", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const placements = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
    const requested = await placements.startDispatch(sessionIdentity("requested"));
    await placements.startDispatch(sessionIdentity("failed"));
    await placements.fail({ sessionId: "failed", recoveryError: "failure ".repeat(128) });
    const ownedIdentity = sessionIdentity("owned");
    const claimInput = {
      ...ownedIdentity,
      owner: { kind: "local" as const },
      claimId: "claim",
      runId: "run",
    };
    const ownedClaim = await placements.claimTurn(claimInput);
    let discovered: readonly ReturnType<typeof sessionIdentity>[] = [];
    const resolveEvidence = vi.fn<PlacementSessionEvidenceResolver>(async () => "current");
    const forceDestroyEnvironment = vi.fn();
    const warn = vi.fn();
    const retirement = createPlacementSessionRetirement({
      placements,
      environments: { get: () => undefined },
      forceDestroyEnvironment,
      createSessionEvidenceResolver: async (identities) => {
        discovered = identities;
        return resolveEvidence;
      },
      reportChanges: (operation) => operation(),
      warn,
    });
    const replyBytes = () =>
      getWorkerMessageMetrics().find(
        ({ kind, direction }) => kind === "sqlite_reply" && direction === "from_worker",
      )?.payloadBytesByRequestClass?.workerPlacements ?? 0;
    const before = replyBytes();
    await retirement.reconcile();
    const bytes = replyBytes() - before;
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(1_024);
    expect(discovered).toEqual([
      sessionIdentity("failed"),
      sessionIdentity("requested"),
      ownedIdentity,
    ]);
    discovered[2]!.sessionKey = "changed-by-caller";
    expect(await placements.getAsync("owned")).toMatchObject(ownedIdentity);
    await placements.releaseTurn(ownedClaim);
    expect(await placements.listSessionIdentitiesAsync()).toContainEqual(ownedIdentity);
    await placements.claimTurn(claimInput);
    const ownedRequested = await placements.startDispatch(ownedIdentity);
    const retire = vi.spyOn(placements, "retireSessionPlacementAsync");
    resolveEvidence.mockResolvedValue("absent");
    retirement.markPending(requested.sessionId);
    retirement.markPending(ownedRequested.sessionId);
    await retirement.reconcile();
    expect(retire).toHaveBeenCalledExactlyOnceWith({
      sessionId: requested.sessionId,
      expectedState: "requested",
      expectedGeneration: requested.generation,
    });
    expect(placements.get(requested.sessionId)).toBeUndefined();
    expect(placements.get(ownedRequested.sessionId)).toMatchObject({
      state: "requested",
      generation: ownedRequested.generation,
      turnClaim: { owner: "local", claimId: ownedClaim.claimId, runId: ownedClaim.runId },
    });
    expect(warn).toHaveBeenCalledWith(
      `Retired ownerless worker placement ${requested.sessionId} because its authoritative session is absent (requested@${requested.generation})`,
    );
    expect(forceDestroyEnvironment).not.toHaveBeenCalled();
  }));

it.each(["unknown", "read", "write", "teardown"] as const)(
  "retries %s failures without losing pending cleanup",
  async (failure) => {
    const placement =
      failure === "teardown" ? activePlacement("session-retry") : localPlacement("session-retry");
    const harness = createHarness([placement]);
    if (failure === "unknown") {
      harness.resolveSessionEvidence.mockResolvedValueOnce("unknown");
    } else if (failure === "read") {
      harness.listSessionIdentitiesAsync.mockRejectedValueOnce(new Error("reader unavailable"));
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
