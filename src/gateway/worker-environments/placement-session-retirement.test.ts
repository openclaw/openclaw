import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import {
  createPlacementSessionRetirement,
  type PlacementSessionEvidence,
  type PlacementSessionEvidenceResolver,
} from "./placement-session-retirement.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementRetirement,
} from "./placement-store.js";

function localPlacement(
  sessionId: string,
): Extract<WorkerSessionPlacementRecord, { state: "local" }> {
  return {
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    agentId: "main",
    state: "local",
    executionMode: "worker-turn",
    generation: 1,
    turnClaim: null,
    environmentId: null,
    activeOwnerEpoch: null,
    workspaceBaseManifestRef: null,
    remoteWorkspaceDir: null,
    workerBundleHash: null,
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    stateChangedAtMs: 1,
  };
}

function activePlacement(
  sessionId: string,
): Extract<WorkerSessionPlacementRecord, { state: "active" }> {
  return {
    ...localPlacement(sessionId),
    state: "active",
    generation: 2,
    turnClaim: null,
    environmentId: `environment:${sessionId}`,
    activeOwnerEpoch: 3,
    workspaceBaseManifestRef: "manifest",
    remoteWorkspaceDir: "/workspace",
    workerBundleHash: "a".repeat(64),
  };
}

function failedPlacement(
  placement: Extract<WorkerSessionPlacementRecord, { state: "active" }>,
): Extract<WorkerSessionPlacementRecord, { state: "failed" }> {
  return {
    ...placement,
    state: "failed",
    generation: placement.generation + 1,
    turnClaim: null,
    recoveryError: "forced teardown",
    terminalReason: "failed",
    terminalAtMs: 2,
  };
}

function createHarness(records: WorkerSessionPlacementRecord[]) {
  const placements = new Map(records.map((record) => [record.sessionId, record]));
  const environments = new Map<
    string,
    { environmentId: string; state: "attached" | "destroyed"; leaseId: string | null }
  >(
    records.flatMap((record) =>
      record.environmentId
        ? [
            [
              record.environmentId,
              {
                environmentId: record.environmentId,
                state: "attached" as const,
                leaseId: `lease:${record.environmentId}`,
              },
            ] as const,
          ]
        : [],
    ),
  );
  const retired: WorkerSessionPlacementRetirement[] = [];
  const resolveSessionEvidence = vi.fn(
    async (_placement: WorkerSessionPlacementRecord): Promise<PlacementSessionEvidence> => "absent",
  );
  const createSessionEvidenceResolver = vi.fn(
    async (): Promise<PlacementSessionEvidenceResolver> => resolveSessionEvidence,
  );
  const forceDestroyEnvironment = vi.fn(async (environmentId: string) => {
    environments.set(environmentId, {
      environmentId,
      state: "destroyed",
      leaseId: null,
    });
    for (const record of placements.values()) {
      if (record.environmentId === environmentId && record.state === "active") {
        placements.set(record.sessionId, failedPlacement(record));
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
      get: (environmentId) => environments.get(environmentId) as never,
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

describe("placement session retirement", () => {
  it("reuses local session evidence until invalidated, including a receipt during discovery", async () => {
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
    } finally {
      uninstall();
    }
  });

  it("retires an exact local placement after its session disappears", async () => {
    const harness = createHarness([localPlacement("session-local")]);

    await harness.retirement.reconcile();

    expect(harness.retired).toEqual([
      {
        sessionId: "session-local",
        expectedState: "local",
        expectedGeneration: 1,
      },
    ]);
    expect(harness.forceDestroyEnvironment).not.toHaveBeenCalled();
  });

  it("retires an exact ownerless requested placement after its session disappears", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "openclaw-placement-retirement-"),
    );
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    const requested = await placements.startDispatch({
      sessionId: "session-requested",
      sessionKey: "agent:main:session-requested",
      agentId: "main",
    });
    const ownedIdentity = {
      sessionId: "session-owned-requested",
      sessionKey: "agent:main:session-owned-requested",
      agentId: "main",
    };
    const ownedClaim = await placements.claimTurn({
      ...ownedIdentity,
      owner: { kind: "local" },
      claimId: "requested-owner-claim",
      runId: "requested-owner-run",
    });
    const ownedRequested = await placements.startDispatch(ownedIdentity);
    const retireSessionPlacement = vi.fn((input: WorkerSessionPlacementRetirement) =>
      placements.retireSessionPlacementAsync(input),
    );
    const forceDestroyEnvironment = vi.fn();
    const warn = vi.fn();
    const retirement = createPlacementSessionRetirement({
      placements: {
        getAsync: (sessionId) => placements.getAsync(sessionId),
        getManyAsync: (sessionIds) => placements.getManyAsync(sessionIds),
        listAsync: () => placements.listAsync(),
        retireSessionPlacementAsync: retireSessionPlacement,
      },
      environments: { get: () => undefined },
      forceDestroyEnvironment,
      createSessionEvidenceResolver: async () => async () => "absent",
      reportChanges: (operation) => operation(),
      warn,
    });

    try {
      await retirement.reconcile();

      expect(retireSessionPlacement).toHaveBeenCalledWith({
        sessionId: requested.sessionId,
        expectedState: "requested",
        expectedGeneration: requested.generation,
      });
      expect(retireSessionPlacement).toHaveBeenCalledOnce();
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
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fences a live environment before retiring its failed placement", async () => {
    const harness = createHarness([activePlacement("session-active")]);

    await harness.retirement.reconcile();

    expect(harness.forceDestroyEnvironment).toHaveBeenCalledWith(
      "environment:session-active",
      expect.any(Function),
    );
    expect(harness.retired).toEqual([
      {
        sessionId: "session-active",
        expectedState: "failed",
        expectedGeneration: 3,
      },
    ]);
  });

  it("skips clean placements and checks only the changed identity", async () => {
    const first = localPlacement("session-one");
    const second = localPlacement("session-two");
    const harness = createHarness([first, second]);
    harness.resolveSessionEvidence.mockResolvedValue("current");

    await harness.retirement.reconcile();
    await harness.retirement.reconcile();
    await harness.retirement.reconcile();

    expect(harness.listAsync).toHaveBeenCalledOnce();
    expect(harness.createSessionEvidenceResolver).toHaveBeenCalledOnce();
    expect(harness.createSessionEvidenceResolver).toHaveBeenCalledWith([first, second]);

    harness.resolveSessionEvidence.mockResolvedValue("absent");
    harness.retirement.markPending(first.sessionId);
    await harness.retirement.reconcile();

    expect(harness.createSessionEvidenceResolver).toHaveBeenLastCalledWith([first]);
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

  it("keeps a changed identity queued while the previous evidence read settles", async () => {
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
});
