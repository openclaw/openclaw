import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
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

  it("reuses local projections and observes claims from another store without rereading", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("placement-local-cache-"));
    const database = openOpenClawStateDatabase();
    const reader = createWorkerSessionPlacementStore({ database });
    const writer = createWorkerSessionPlacementStore({ database });
    const identity = { sessionId: "local", agentId: "main", sessionKey: "agent:main:local" };
    expect((await reader.readProjection([identity.sessionId])).placements.size).toBe(0);
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
    expect(reads).not.toHaveBeenCalled();
    // Returned snapshots cannot mutate the next reader's facts.
    claimed.placements.get(identity.sessionId)!.state = "requested";
    expect(
      (await reader.readProjection([identity.sessionId])).placements.get(identity.sessionId)?.state,
    ).toBe("local");
  });

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
