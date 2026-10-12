import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createWorkerPlacementDiskSpaceMonitor } from "./placement-disk-space.js";
import { placementTurnOwner } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";

const roots = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await drainGlobalSingletonLifecycleState();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  }),
);

describe("worker placement read cache", () => {
  it("reuses the disk sweep inventory and observes committed placement transitions", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("placement-disk-cache-"));
    const database = openOpenClawStateDatabase();
    const reader = createWorkerSessionPlacementStore({ database });
    const writer = createWorkerSessionPlacementStore({ database });
    const runWorkspaceCommand = vi.fn(async () => ({
      stdout: JSON.stringify({ availableBytes: "6000000000", totalBytes: "10000000000" }),
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit" as const,
    }));
    const unexpected = async () => {
      throw new Error("unexpected workspace mutation during a disk probe");
    };
    let nowMs = 1_000;
    const warn = vi.fn();
    const monitor = createWorkerPlacementDiskSpaceMonitor({
      placements: reader,
      environments: {
        startTunnel: async ({ environmentId, ownerEpoch }) => ({
          environmentId,
          ownerEpoch,
          runWorkspaceCommand,
          quiesceWorkspace: unexpected,
          syncWorkspace: unexpected,
          reconcileWorkspace: unexpected,
          stop: async () => {},
        }),
      },
      runnerAvailability: { read: () => undefined, version: () => 0 },
      warn,
      now: () => nowMs,
    });
    await monitor.sweep();
    const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    await monitor.sweep();
    expect(reads).not.toHaveBeenCalled();
    expect(runWorkspaceCommand).not.toHaveBeenCalled();

    const active = await advancePlacementFixtureToActive(writer, database, {
      sessionId: "disk-cache",
      sessionKey: "agent:main:disk-cache",
      agentId: "main",
    });
    await monitor.sweep();
    expect(runWorkspaceCommand).toHaveBeenCalledOnce();
    expect(monitor.read(active)?.status).toBe("ok");

    const draining = await writer.transition({
      sessionId: active.sessionId,
      from: "active",
      to: "draining",
      expectedGeneration: active.generation,
    });
    nowMs += 15 * 60_000;
    await monitor.sweep();
    expect(monitor.read(draining)).toBeUndefined();
    expect(runWorkspaceCommand).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it("claims and releases an existing worker placement with a NULL execution mode", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("placement-null-mode-"));
    const database = openOpenClawStateDatabase();
    const store = createWorkerSessionPlacementStore({ database });
    const identity = { sessionId: "legacy", agentId: "main", sessionKey: "agent:main:legacy" };
    const active = await advancePlacementFixtureToActive(store, database, identity, {
      environmentId: "legacy-environment",
    });
    database.db
      .prepare("UPDATE worker_session_placements SET execution_mode = NULL WHERE session_id = ?")
      .run(identity.sessionId);
    const claim = await store.claimTurn({
      ...identity,
      owner: placementTurnOwner(active),
      claimId: "legacy-claim",
      runId: "legacy-run",
    });
    expect((await store.getAsync(identity.sessionId))?.turnClaim?.claimId).toBe("legacy-claim");
    await store.releaseTurnIfOwned(claim);
    expect((await store.getAsync(identity.sessionId))?.turnClaim).toBeNull();
  });

  it.each([false, true])(
    "observes local claim receipts with a preloaded projection: %s",
    async (preloaded) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("placement-local-cache-"));
      const database = openOpenClawStateDatabase();
      const reader = createWorkerSessionPlacementStore({ database });
      const writer = createWorkerSessionPlacementStore({ database });
      const identity = { sessionId: "local", agentId: "main", sessionKey: "agent:main:local" };
      if (preloaded) {
        expect((await reader.readProjection([identity.sessionId])).placements.size).toBe(0);
      }
      const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
      const claim = await writer.claimTurn({
        ...identity,
        owner: { kind: "local" },
        claimId: "claim",
        runId: "run",
      });
      const claimed = await reader.readProjection([identity.sessionId]);
      expect(claimed.placements.get(identity.sessionId)?.turnClaim?.claimId).toBe("claim");
      await writer.releaseTurnIfOwned(claim);
      expect(
        (await reader.readProjection([identity.sessionId])).placements.get(identity.sessionId),
      ).toMatchObject({ state: "local", turnClaim: null });
      expect(reads).toHaveBeenCalledTimes(preloaded ? 0 : 1);
      // Returned snapshots cannot mutate the next reader's facts.
      claimed.placements.get(identity.sessionId)!.state = "requested";
      expect(
        (await reader.readProjection([identity.sessionId])).placements.get(identity.sessionId)
          ?.state,
      ).toBe("local");
    },
  );

  it("reuses preservation until a writer adds a non-local placement", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("placement-preservation-cache-"));
    const database = openOpenClawStateDatabase();
    const reader = createWorkerSessionPlacementStore({ database });
    const writer = createWorkerSessionPlacementStore({ database });
    const initial = await reader.prepareMaintenancePlacements();
    initial.release();
    const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    const claim = await writer.claimTurn({
      sessionId: "local",
      agentId: "main",
      sessionKey: "agent:main:local",
      owner: { kind: "local" },
      claimId: "claim",
      runId: "run",
    });
    await writer.releaseTurnIfOwned(claim);
    const unchanged = await reader.prepareMaintenancePlacements();
    expect(unchanged.placements).toEqual([]);
    unchanged.release();
    expect(reads).not.toHaveBeenCalled();
    const remote = await writer.startDispatch({
      sessionId: "remote",
      agentId: "main",
      sessionKey: "agent:main:remote",
    });
    const changed = await reader.prepareMaintenancePlacements();
    expect(changed.placements).toEqual([remote]);
    changed.assertCurrent();
    changed.release();
    expect(
      reads.mock.calls.filter(([, command]) => command.type === "workers.placementPreservation"),
    ).toHaveLength(1);
  });
});
