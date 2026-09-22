import { describe, expect, it, vi } from "vitest";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { publishWorkerEnvironmentFixture } from "./placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import type { WorkerTunnelManager } from "./tunnel.js";

const ENVIRONMENT_ID = "worker-stale-result-owner";
const SESSION_ID = "session-stale-result-owner";

describe("worker environment owner revocation", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("preserves a credential when runtime cleanup queues behind a same-epoch state change", async () => {
    const ready = await support.seedReadyNodeDesktop(ENVIRONMENT_ID);
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        db.prepare(
          "UPDATE worker_environments SET bootstrap_bundle_hash = ? WHERE environment_id = ?",
        ).run("b".repeat(64), ENVIRONMENT_ID);
        publishWorkerEnvironmentFixture(db, ENVIRONMENT_ID);
      },
      { database: support.testState.stateDb },
    );
    const store = support.testState.store;
    const revoke = store.revokeEnvironmentCredential.bind(store);
    let replacement: ReturnType<typeof store.transition> | undefined;
    const revoked: string[] = [];
    store.onCredentialRevoked((id) => revoked.push(id));
    const revocation = vi
      .spyOn(store, "revokeEnvironmentCredential")
      .mockImplementationOnce((id, options) => {
        replacement = store.transition({
          environmentId: ENVIRONMENT_ID,
          from: "ready",
          to: "idle",
          expectedOwnerEpoch: ready.ownerEpoch,
        });
        return revoke(id, options);
      });
    const stop = vi.fn(async () => {});
    const service = support.createService(support.createProvider(), {
      nodeTunnelManager: {
        status: () => "stopped",
        start: vi.fn(),
        stop,
        stopAll: vi.fn(async () => {}),
      },
      ensureNodeWorkerBundle: async () => support.BOOTSTRAP_RECEIPT,
    });
    try {
      await service.reconcileOnce();
      expect(replacement).toBeDefined();
      const idle = await replacement!;
      expect(idle.ownerEpoch).toBe(ready.ownerEpoch);
      expect(store.getCredential(ENVIRONMENT_ID)).toMatchObject({
        ownerEpoch: ready.ownerEpoch,
        sessionId: null,
      });
      expect(revoked).toEqual([]);
      expect(stop).not.toHaveBeenCalled();
    } finally {
      revocation.mockRestore();
    }
  });

  it.each(["live", "recovery-only"] as const)(
    "preserves a %s pending result during runtime refresh",
    async (owner) => {
      const ready = await support.seedReadyNodeDesktop(ENVIRONMENT_ID);
      const attached = await support.testState.store.transition({
        environmentId: ENVIRONMENT_ID,
        from: ready.state,
        to: "attached",
        patch: support.attachedPatch(ENVIRONMENT_ID, SESSION_ID),
      });
      support.testState.stateDb.db
        .prepare(
          "UPDATE worker_environments SET bootstrap_bundle_hash = ?, bootstrap_install_kind = 'local' WHERE environment_id = ?",
        )
        .run("b".repeat(64), ENVIRONMENT_ID);
      await support.reopenWorkerEnvironmentStore();
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      let placement = placements.startDispatch({
        sessionId: SESSION_ID,
        sessionKey: "agent:main:stale-result-owner",
        agentId: "main",
        executionMode: "worker-turn",
      });
      placement = placements.transition({
        sessionId: SESSION_ID,
        from: "requested",
        to: "provisioning",
        expectedGeneration: placement.generation,
        patch: { environmentId: ENVIRONMENT_ID },
      });
      placement = placements.transition({
        sessionId: SESSION_ID,
        from: "provisioning",
        to: "syncing",
        expectedGeneration: placement.generation,
        patch: { workerBundleHash: "b".repeat(64) },
      });
      placement = placements.transition({
        sessionId: SESSION_ID,
        from: "syncing",
        to: "starting",
        expectedGeneration: placement.generation,
        patch: {
          remoteWorkspaceDir: "/worker/stale-result-owner",
          workspaceBaseManifestRef: `sha256:${"c".repeat(64)}`,
        },
      });
      placement = placements.transition({
        sessionId: SESSION_ID,
        from: "starting",
        to: "active",
        expectedGeneration: placement.generation,
        patch: { activeOwnerEpoch: attached.ownerEpoch },
      });
      const claim = placements.claimTurn({
        sessionId: SESSION_ID,
        sessionKey: placement.sessionKey,
        agentId: placement.agentId,
        claimId: "claim-stale-result-owner",
        runId: "run-stale-result-owner",
        owner: {
          kind: "worker",
          environmentId: ENVIRONMENT_ID,
          ownerEpoch: attached.ownerEpoch,
        },
      });
      createWorkerSessionPlacementGate(placements).updateAckCursors({ claim, liveSeq: 1 });
      const placementStore = createWorkerSessionPlacementGate(placements, {
        rejectExistingWorkerClaims: owner === "recovery-only",
      });
      const tunnelManager = {
        status: () => "connected" as const,
        start: vi.fn(),
        stop: vi.fn(async () => {
          expect(placements.listPendingWorkspaceResults()).toMatchObject([
            { sessionId: SESSION_ID, recoveryRequestedAtMs: expect.any(Number) },
          ]);
        }),
        stopAll: vi.fn(async () => {}),
      } as unknown as WorkerTunnelManager;

      await support
        .createService(support.createProvider({ destroy: vi.fn(async () => {}) }), {
          placementStore,
          tunnelManager,
          ensureNodeWorkerBundle: async () => support.BOOTSTRAP_RECEIPT,
        })
        .reconcileOnce();

      expect(tunnelManager.stop).toHaveBeenCalledTimes(owner === "recovery-only" ? 1 : 0);
      expect(placements.listPendingWorkspaceResults()).toMatchObject([
        {
          sessionId: SESSION_ID,
          recoveryRequestedAtMs: owner === "recovery-only" ? expect.any(Number) : null,
        },
      ]);
      expect(support.testState.store.get(ENVIRONMENT_ID)).toMatchObject({
        state: "attached",
        leaseId: ready.leaseId,
        ownerEpoch: attached.ownerEpoch,
        destroyRequestedAtMs: null,
      });
    },
  );
});
