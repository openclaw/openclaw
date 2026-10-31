import { describe, expect, it, vi } from "vitest";
import type { WorkerProvider } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import { claimWorkerTurn } from "./worker-turn-admission.js";

const identity = {
  sessionId: "lease-admission",
  agentId: "main",
  sessionKey: "agent:main:lease-admission",
};

describe("provider lease admission before a fresh turn claim", () => {
  support.setupWorkerEnvironmentServiceSuite();

  async function fixture(inspect: WorkerProvider["inspect"], destroy = vi.fn(async () => {})) {
    const environmentId = "lease-admission-environment";
    await support.seedAttachedIdentity(environmentId, identity.sessionId);
    const environment = support.testState.store.get(environmentId)!;
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const placement = await advancePlacementFixtureToActive(
      placements,
      support.testState.stateDb,
      { ...identity, executionMode: "remote-exec" },
      { environmentId, ownerEpoch: environment.ownerEpoch, seedEnvironment: false },
    );
    const provision = vi.fn(async () => {
      throw new Error("unexpected replacement allocation");
    });
    const service = support.createService(support.createProvider({ inspect, destroy, provision }), {
      placementStore: createWorkerSessionPlacementGate(placements),
    });
    const claim = (signal?: AbortSignal, assertCurrent?: () => void) =>
      claimWorkerTurn({
        placements,
        environments: service,
        identity,
        placement,
        runId: "fresh-input",
        isCancellationRequested: () => false,
        signal,
        assertCurrent,
      });
    const expectUnclaimed = () => expect(placements.get(identity.sessionId)?.turnClaim).toBeNull();
    return {
      environment,
      environmentId,
      service,
      placements,
      claim,
      expectUnclaimed,
      destroy,
      provision,
    };
  }

  it.each(["active", "dormant", "unavailable", "unknown", "destroyed"] as const)(
    "admits only a recognized lease and preserves the %s disposition",
    async (status) => {
      const inspect = vi.fn<WorkerProvider["inspect"]>(async () => {
        if (status === "unavailable") {
          throw new Error("provider transport unavailable");
        }
        return status === "active" ? { status, sharedHost: false } : { status };
      });
      const f = await fixture(inspect);
      if (status === "active" || status === "dormant") {
        const admitted = await f.claim();
        expect(admitted?.turnClaim.owner).toEqual({
          kind: "local",
          environmentId: f.environmentId,
          ownerEpoch: f.environment.ownerEpoch,
        });
        expect(f.service.get(f.environmentId)?.leaseId).toBe(f.environment.leaseId);
        await f.placements.releaseTurnIfOwned(admitted!.turnClaim);
      } else {
        await expect(f.claim()).rejects.toThrow(
          status === "unavailable" ? "observation is unavailable" : "no longer usable",
        );
        expect(f.service.get(f.environmentId)).toMatchObject(
          status === "unavailable"
            ? { state: "attached", leaseId: f.environment.leaseId, destroyRequestedAtMs: null }
            : { state: "failed", leaseId: null },
        );
      }
      f.expectUnclaimed();
      expect(inspect).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          leaseId: f.environment.leaseId,
          profile: { region: "test" },
          signal: expect.any(AbortSignal),
        }),
      );
      expect(f.destroy).toHaveBeenCalledTimes(status === "unknown" ? 1 : 0);
      expect(f.provision).not.toHaveBeenCalled();
      expect(support.testState.prepareInstallation).not.toHaveBeenCalled();
      expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
    },
  );

  it.each(["cancel", "caller", "teardown"] as const)(
    "does not settle late loss or claim input after %s retires admission",
    async (change) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const f = await fixture(async () => {
        entered.resolve();
        await release.promise;
        return { status: "unknown" };
      });
      const controller = new AbortController();
      let current = true;
      const pending = f.claim(controller.signal, () => {
        if (!current) {
          throw new Error("caller retired");
        }
      });
      const rejected = expect(pending).rejects.toThrow();
      await entered.promise;
      if (change === "cancel") {
        controller.abort(new Error("input cancelled"));
      } else if (change === "caller") {
        current = false;
      } else {
        await support.testState.store.requestDestroy({
          environmentId: f.environmentId,
          state: "attached",
        });
      }
      release.resolve();
      await rejected;
      f.expectUnclaimed();
      expect(f.destroy).not.toHaveBeenCalled();
      expect(f.provision).not.toHaveBeenCalled();
      expect(f.service.get(f.environmentId)?.leaseId).toBe(f.environment.leaseId);
    },
  );

  it("finishes accepted loss cleanup after the input stops waiting", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const f = await fixture(
      async () => ({ status: "unknown" }),
      vi.fn(async () => {
        entered.resolve();
        await release.promise;
      }),
    );
    const controller = new AbortController();
    const rejected = expect(f.claim(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    try {
      await entered.promise;
      controller.abort(new Error("input cancelled"));
      await rejected;
      f.expectUnclaimed();
      expect(f.service.get(f.environmentId)).toMatchObject({
        leaseId: f.environment.leaseId,
        destroyRequestedAtMs: expect.any(Number),
      });
    } finally {
      release.resolve();
    }
    await vi.waitFor(() =>
      expect(f.service.get(f.environmentId)).toMatchObject({ state: "failed", leaseId: null }),
    );
    expect(f.destroy).toHaveBeenCalledOnce();
    expect(f.provision).not.toHaveBeenCalled();
  });

  it("retains exact cleanup custody when an unusable lease cannot be destroyed", async () => {
    const f = await fixture(
      async () => ({ status: "unknown" }),
      vi.fn(async () => {
        throw new Error("destroy outcome unavailable");
      }),
    );
    await expect(f.claim()).rejects.toThrow("no longer usable");
    f.expectUnclaimed();
    expect(f.service.get(f.environmentId)).toMatchObject({
      leaseId: f.environment.leaseId,
      destroyRequestedAtMs: expect.any(Number),
    });
    expect(f.destroy).toHaveBeenCalledOnce();
    expect(f.provision).not.toHaveBeenCalled();
  });
});
