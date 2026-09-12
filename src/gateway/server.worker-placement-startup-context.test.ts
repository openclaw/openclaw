import { afterEach, expect, test, vi } from "vitest";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { installGatewayTestHooks, rpcReq, writeSessionStore } from "./test-helpers.js";
import { sessionStoreEntry } from "./test/server-sessions.test-helpers.js";
import * as nodeWorkerTunnelModule from "./worker-environments/node-worker-tunnel.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";
import { WorkerTunnelOwnerDisconnectedError } from "./worker-environments/tunnel-contract.js";

installGatewayTestHooks({ scope: "suite" });

const originalCreateNodeWorkerTunnelManager = nodeWorkerTunnelModule.createNodeWorkerTunnelManager;
vi.spyOn(nodeWorkerTunnelModule, "createNodeWorkerTunnelManager").mockImplementation((options) => {
  const manager = originalCreateNodeWorkerTunnelManager(options);
  return {
    ...manager,
    stopAll: async () => {
      try {
        await manager.stopAll();
      } catch (error) {
        if (error instanceof WorkerTunnelOwnerDisconnectedError) {
          return;
        }
        throw error;
      }
    },
  };
});

let harness: GatewayServerHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  closeOpenClawStateDatabaseForTest();
});

test(
  "profiles-disabled startup exposes core worker placement through real session RPCs",
  { timeout: 30_000 },
  async () => {
    // Minimal Gateway mode intentionally omits worker ownership; this exercises production startup
    // with no configured cloud profiles, where the core device provider still owns placement.
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    harness = await startGatewayServerHarness();
    const { ws } = await harness.openClient();
    const created = await rpcReq<{ key?: string; sessionId?: string }>(ws, "sessions.create", {
      agentId: "main",
      key: "startup-placement-local",
    });
    expect(created).toMatchObject({ ok: true });
    const sessionKey = created.payload?.key;
    if (!sessionKey) {
      throw new Error("session creation did not return a key");
    }

    const dispatch = await rpcReq(ws, "sessions.dispatch", {
      key: sessionKey,
      deviceId: "missing-device",
    });
    expect(dispatch.ok).toBe(false);
    expect(dispatch.error?.message).toBe("device worker is not a paired node host: missing-device");

    const reset = await rpcReq(ws, "sessions.reset", { key: sessionKey });
    expect(reset).toMatchObject({ ok: true, payload: { key: sessionKey } });
    const deleted = await rpcReq(ws, "sessions.delete", { key: sessionKey });
    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
    ws.close();
  },
);

test(
  "running Gateway sessions.move RPC abandons offline paired device with existing pending workspace result and returns to local use",
  { timeout: 60_000 },
  async () => {
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    harness = await startGatewayServerHarness();
    const { ws } = await harness.openClient();

    const sessionKey = "agent:main:live-abandon-test";
    const created = await rpcReq<{ key?: string; sessionId?: string }>(ws, "sessions.create", {
      agentId: "main",
      key: sessionKey,
    });
    expect(created).toMatchObject({ ok: true });
    const sessionId = created.payload?.sessionId;
    if (!sessionId) {
      throw new Error("session creation did not return a sessionId");
    }

    // Attach a local worktree so resolveSessionWorkspace succeeds without requiring remote Git
    const worktreeId = "wt-live-abandon-1";
    insertRegistryWorktree(process.env, {
      id: worktreeId,
      repoFingerprint: "fp-live",
      repoRoot: "/tmp",
      path: "/tmp",
      branch: "main",
      baseRef: "main",
      ownerKind: "session",
      ownerId: sessionKey,
      createdAt: 1_000,
      lastActiveAt: 1_000,
    });
    await writeSessionStore({
      storePath: resolveDefaultSessionStorePath("main"),
      entries: {
        [sessionKey]: sessionStoreEntry(sessionId, {
          worktree: { id: worktreeId, branch: "main", repoRoot: "/tmp" },
        }),
      },
    });

    // Seed state database with active paired device placement and pending workspace result
    const database = openOpenClawStateDatabase();
    const placements = createWorkerSessionPlacementStore({ database });

    seedAttachedPlacementEnvironment(database, {
      environmentId: "env-device-1",
      sessionId,
      ownerEpoch: 1,
      providerId: "device",
      profileId: "device:device-1",
      nodeDeviceId: "device-1",
      sharedHost: true,
    });

    const requested = placements.startDispatch({
      sessionId,
      sessionKey,
      agentId: "main",
      executionMode: "worker-turn",
    });
    const provisioning = placements.transition({
      sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: requested.generation,
      patch: { environmentId: "env-device-1" },
    });
    const syncing = placements.transition({
      sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: provisioning.generation,
      patch: { workerBundleHash: "a".repeat(64) },
    });
    const starting = placements.transition({
      sessionId,
      from: "syncing",
      to: "starting",
      expectedGeneration: syncing.generation,
      patch: { workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`, remoteWorkspaceDir: "/tmp" },
    });
    const active = placements.transition({
      sessionId,
      from: "starting",
      to: "active",
      expectedGeneration: starting.generation,
      patch: { activeOwnerEpoch: 1 },
    });

    const claim = placements.claimTurn({
      sessionId,
      sessionKey,
      agentId: "main",
      claimId: "live-claim-1",
      runId: "live-run-1",
      owner: {
        kind: "worker",
        environmentId: "env-device-1",
        ownerEpoch: 1,
      },
    });
    placements.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    placements.markWorkspaceResultPending(claim);
    expect(placements.listPendingWorkspaceResults()).toHaveLength(1);

    // Invoke sessions.move over the live WebSocket to the running Gateway
    const moveRes = await rpcReq<{
      ok?: boolean;
      key?: string;
      sessionId?: string;
      placement?: { state?: string };
    }>(ws, "sessions.move", {
      key: sessionKey,
      expected: {
        generation: active.generation,
        environmentId: "env-device-1",
        ownerEpoch: 1,
      },
      target: { kind: "gateway" },
      abandonSource: true,
    });

    expect(moveRes).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        key: sessionKey,
        sessionId,
        placement: expect.objectContaining({ state: "local" }),
      },
    });

    expect(placements.listPendingWorkspaceResults()).toHaveLength(0);
    expect(placements.validateTurnClaim(claim)).toBe(false);
    expect(placements.get(sessionId)).toMatchObject({ state: "local" });
    expect(placements.getPlacementMove(sessionId)).toBeUndefined();

    database.db
      .prepare("DELETE FROM worker_environments WHERE environment_id = ?")
      .run("env-device-1");

    ws.close();
  },
);

test(
  "persisted abandonment completes after actual Gateway process restart and clears pending workspace results",
  { timeout: 60_000 },
  async () => {
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";

    const sessionKey = "agent:main:live-restart-test";
    const sessionId = "sess-restart-abandon-1";

    const worktreeId = "wt-restart-abandon-1";
    insertRegistryWorktree(process.env, {
      id: worktreeId,
      repoFingerprint: "fp-restart",
      repoRoot: "/tmp",
      path: "/tmp",
      branch: "main",
      baseRef: "main",
      ownerKind: "session",
      ownerId: sessionKey,
      createdAt: 1_000,
      lastActiveAt: 1_000,
    });
    await writeSessionStore({
      storePath: resolveDefaultSessionStorePath("main"),
      entries: {
        [sessionKey]: sessionStoreEntry(sessionId, {
          worktree: { id: worktreeId, branch: "main", repoRoot: "/tmp" },
        }),
      },
    });

    const database = openOpenClawStateDatabase();
    const placements = createWorkerSessionPlacementStore({ database });

    seedAttachedPlacementEnvironment(database, {
      environmentId: "env-device-restart",
      sessionId,
      ownerEpoch: 1,
      providerId: "device",
      profileId: "device:device-restart",
      nodeDeviceId: "device-restart",
      sharedHost: true,
    });

    const requested = placements.startDispatch({
      sessionId,
      sessionKey,
      agentId: "main",
      executionMode: "worker-turn",
    });
    const provisioning = placements.transition({
      sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: requested.generation,
      patch: { environmentId: "env-device-restart" },
    });
    const syncing = placements.transition({
      sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: provisioning.generation,
      patch: { workerBundleHash: "a".repeat(64) },
    });
    const starting = placements.transition({
      sessionId,
      from: "syncing",
      to: "starting",
      expectedGeneration: syncing.generation,
      patch: { workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`, remoteWorkspaceDir: "/tmp" },
    });
    const active = placements.transition({
      sessionId,
      from: "starting",
      to: "active",
      expectedGeneration: starting.generation,
      patch: { activeOwnerEpoch: 1 },
    });

    const claim = placements.claimTurn({
      sessionId,
      sessionKey,
      agentId: "main",
      claimId: "restart-claim-1",
      runId: "restart-run-1",
      owner: {
        kind: "worker",
        environmentId: "env-device-restart",
        ownerEpoch: 1,
      },
    });
    placements.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    placements.markWorkspaceResultPending(claim);
    expect(placements.listPendingWorkspaceResults()).toHaveLength(1);

    // Persist abandonment move intent directly into SQLite (simulating in-flight abandonment when Gateway crashed)
    const begun = placements.beginPlacementMove({
      sessionId,
      source: {
        generation: active.generation,
        environmentId: "env-device-restart",
        ownerEpoch: 1,
      },
      target: { kind: "gateway" },
      abandonSource: true,
    });
    expect(begun.placement.state).toBe("draining");
    expect(begun.intent.abandonSource).toBe(true);

    closeOpenClawStateDatabaseForTest();

    // Actual Gateway process startup / restart
    harness = await startGatewayServerHarness();
    const { ws } = await harness.openClient();

    // The Gateway recovery on restart must have completed abandonment to local
    const restartedDb = openOpenClawStateDatabase();
    const restartedStore = createWorkerSessionPlacementStore({ database: restartedDb });

    expect(restartedStore.get(sessionId)).toMatchObject({ state: "local" });
    expect(restartedStore.listPendingWorkspaceResults()).toHaveLength(0);
    expect(restartedStore.validateTurnClaim(claim)).toBe(false);
    expect(restartedStore.getPlacementMove(sessionId)).toBeUndefined();

    restartedDb.db
      .prepare("DELETE FROM worker_environments WHERE environment_id = ?")
      .run("env-device-restart");

    ws.close();
  },
);
