import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  readWorkerPlacementIdentity,
  projectWorkerSessionPlacement,
} from "./placement-projector.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import {
  seedAttachedPlacementEnvironment,
  writePlacementEnvironmentFixture,
} from "./placement-test-fixtures.js";

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

async function activePlacement(database: OpenClawStateDatabase, sessionId: string) {
  const store = createWorkerSessionPlacementStore({ database, now: () => 1000 });
  const identity = { sessionId, agentId: "main", sessionKey: `agent:main:${sessionId}` };
  const environmentId = `environment-${sessionId}`;
  seedAttachedPlacementEnvironment(database, { environmentId, sessionId, ownerEpoch: 7 });
  let placement = await store.startDispatch(identity);
  for (const step of [
    { to: "provisioning", patch: { environmentId } },
    { to: "syncing", patch: { workerBundleHash: "a".repeat(64) } },
    {
      to: "starting",
      patch: {
        workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
        remoteWorkspaceDir: "/workspace",
      },
    },
    { to: "active", patch: { activeOwnerEpoch: 7 } },
  ] as const) {
    placement = store.transition({
      sessionId,
      from: placement.state,
      expectedGeneration: placement.generation,
      ...step,
    });
  }
  assert(placement.state === "active", "Expected an active placement fixture");
  return { store, placement, identity };
}

describe("worker placement read projection", () => {
  it("derives inference from the bound snapshot without rewriting either spelling", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("placement-inference-snapshot-"));
    const database = openOpenClawStateDatabase();
    for (const inference of ["worker", "runtime-local"]) {
      const sessionId = "snapshot-" + inference;
      const environmentId = "environment-" + sessionId;
      const profileSnapshot = { settings: { device: "paired-node", inference } };
      writePlacementEnvironmentFixture(database, {
        environmentId,
        state: "attached",
        ownerEpoch: 7,
        attachedSessionIds: [sessionId],
        providerId: "device",
        profileId: "named-device",
        nodeDeviceId: "paired-node",
        profileSnapshot,
      });
      const { store, placement } = await activePlacement(database, sessionId);
      const snapshot = await store.readProjection([sessionId]);
      const environment = snapshot.environments.get(environmentId);
      expect(environment).toMatchObject({ profileSnapshot, inference: "worker" });
      const identity = readWorkerPlacementIdentity(placement, undefined, environment);
      const projected = projectWorkerSessionPlacement(placement, undefined, undefined, identity);
      expect(projected).toHaveProperty("inference", "worker");
      expect(projected).not.toHaveProperty("profileSnapshot");
      expect(
        (await store.readProjection([sessionId])).environments.get(environmentId)?.profileSnapshot,
      ).toEqual(profileSnapshot);
    }
  });

  it("reads placement, move, pending-result and environment facts off the host SQLite thread", async () => {
    const stateDir = roots.make("placement-projection-worker-");
    const otherStateDir = roots.make("placement-projection-other-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const database = openOpenClawStateDatabase();
    const { store, placement, identity } = await activePlacement(database, "pending");
    const claim = await store.claimTurn({
      ...identity,
      owner: {
        kind: "worker",
        environmentId: placement.environmentId,
        ownerEpoch: placement.activeOwnerEpoch,
      },
      claimId: "pending-claim",
      runId: "pending-run",
    });
    store.markWorkspaceResultPending(claim);
    const stagedResultRef = `refs/openclaw/worker-results/${claim.claimId}`;
    store.recordStagedWorkspaceResult(claim, stagedResultRef);
    store.recordWorkspaceResultConflict(claim, { paths: ["changed.txt"], stagedResultRef });
    const draining = store.startWorkspaceResultDrain(claim);
    const moving = await activePlacement(database, "moving");
    const move = moving.store.beginPlacementMove({
      sessionId: moving.placement.sessionId,
      source: {
        generation: moving.placement.generation,
        environmentId: moving.placement.environmentId,
        ownerEpoch: moving.placement.activeOwnerEpoch,
      },
      target: { kind: "gateway" },
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", otherStateDir);
    const other = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
    await other.startDispatch(identity);
    await closeOpenClawStateDatabaseAsync();
    requireNodeSqlite();
    const counters = observeMainThreadSql({ includeClose: true });
    try {
      const snapshot = await store.readProjection([
        "pending",
        " pending ",
        "moving",
        " moving ",
        "missing",
      ]);
      expect(snapshot.placements.get("pending")).toMatchObject({
        state: "draining",
        generation: draining.generation,
        workspaceResultConflict: { paths: ["changed.txt"], stagedResultRef, totalCount: 1 },
      });
      expect(snapshot.placements.get("moving")).toEqual(move.placement);
      expect(snapshot.placements.get(" pending ")).toEqual(snapshot.placements.get("pending"));
      expect(snapshot.placements.get(" moving ")).toEqual(move.placement);
      expect(snapshot.placements.has("missing")).toBe(false);
      expect(snapshot.moves.get("moving")).toEqual(move.intent);
      expect(snapshot.moves.get(" moving ")).toEqual(move.intent);
      expect(snapshot.workspaceResultReconcilingSessionIds).toEqual(
        new Set(["pending", " pending "]),
      );
      expect(snapshot.workspaceRecoveryPendingSessionIds).toEqual(
        new Set(["pending", " pending "]),
      );
      expect(snapshot.environments.get(placement.environmentId)).toEqual({
        environmentId: placement.environmentId,
        providerId: "fake",
        profileId: "development",
        profileSnapshot: { settings: {} },
        state: "attached",
        leaseId: `lease:${placement.environmentId}`,
        ownerEpoch: 7,
        nodeDeviceId: null,
        attachedSessionIds: ["pending"],
      });
      expect((await other.readProjection(["pending"])).placements.get("pending")?.state).toBe(
        "requested",
      );
      await closeOpenClawStateDatabaseAsync();
      expect((await store.readProjection(["pending"])).placements.get("pending")?.generation).toBe(
        draining.generation,
      );
      counters.expectIdle();
    } finally {
      counters.restore();
    }
  });
});
