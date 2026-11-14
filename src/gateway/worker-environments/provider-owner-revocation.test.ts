import { expect, it, vi } from "vitest";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { placementClaim } from "./placement-suite.test-support.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import type { WorkerTunnelManager } from "./tunnel.js";

const ENVIRONMENT_ID = "worker-stale-result-owner";
const SESSION_ID = "session-stale-result-owner";

support.setupWorkerEnvironmentServiceSuite();

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
    const placement = await advancePlacementFixtureToActive(
      placements,
      support.testState.stateDb,
      {
        sessionId: SESSION_ID,
        sessionKey: "agent:main:stale-result-owner",
        agentId: "main",
        executionMode: "worker-turn",
      },
      {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: attached.ownerEpoch,
        workerBundleHash: "b".repeat(64),
        remoteWorkspaceDir: "/worker/stale-result-owner",
        workspaceBaseManifestRef: `sha256:${"c".repeat(64)}`,
        seedEnvironment: false,
      },
    );
    const claim = await placements.claimTurn(placementClaim(placement, "stale-result-owner"));
    await createWorkerSessionPlacementGate(placements).updateAckCursors({ claim, liveSeq: 1 });
    const placementStore = createWorkerSessionPlacementGate(placements, {
      recoveryPlacements: owner === "recovery-only" ? await placements.listAsync() : [],
    });
    const tunnelManager = {
      status: () => "connected" as const,
      start: vi.fn(),
      stop: vi.fn(async () => {
        expect(await placements.listPendingWorkspaceResultsAsync()).toMatchObject([
          { sessionId: SESSION_ID, recoveryRequestedAtMs: expect.any(Number) },
        ]);
      }),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;

    await support
      .createService(support.createProvider(), {
        placementStore,
        tunnelManager,
        ensureNodeWorkerBundle: async () => support.BOOTSTRAP_RECEIPT,
      })
      .reconcileOnce();

    expect(tunnelManager.stop).toHaveBeenCalledTimes(owner === "recovery-only" ? 1 : 0);
    expect(await placements.listPendingWorkspaceResultsAsync()).toMatchObject([
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
