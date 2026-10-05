import { describe, expect, it, vi } from "vitest";
import { WorkerProviderError } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createDispatchEnvironmentFixtures, REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as support from "./service.test-support.js";

describe("explicit failed preactivation retirement", () => {
  support.setupWorkerEnvironmentServiceSuite({ reuseReadWorkers: true });

  async function fixture(optIn = true) {
    support.getDevelopmentProfile().lostWorkerRecovery = optIn ? "repository-ref" : undefined;
    const destroy = vi.fn(async () => {
      throw new Error("uncertain old allocation remains cleanup-owned");
    });
    const provision = vi
      .fn()
      .mockRejectedValueOnce(
        WorkerProviderError.cleanupIndeterminate(
          "old-lease",
          new Error("warmup rejected before activation"),
          new Error("old claim retained"),
        ),
      )
      .mockResolvedValue({ leaseId: "new-lease", ssh: support.SSH_ENDPOINT });
    const receipt = createDispatchEnvironmentFixtures().ready.bootstrapReceipt;
    support.testState.prepareInstallation = vi.fn(async () => ({
      ...support.BUNDLE_ARTIFACT,
      bundleHash: receipt!.bundleHash,
      openclawVersion: receipt!.openclawVersion,
      protocolFeatures: receipt!.protocolFeatures,
    }));
    support.testState.bootstrapWorker = vi.fn(async () => receipt!);
    const environments = support.createService(support.createProvider({ provision, destroy }));
    await expect(environments.create("development", "old-provision")).rejects.toThrow(
      "warmup rejected",
    );
    const old = support.testState.store.list()[0]!;
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const request = { ...REQUEST, executionMode: "remote-exec" as const };
    const requested = await placements.startDispatch(request);
    const provisioning = await placements.transition({
      sessionId: request.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: requested.generation,
      patch: { environmentId: old.environmentId },
    });
    const failed = await placements.fail({
      sessionId: request.sessionId,
      expectedGeneration: provisioning.generation,
      recoveryError: "warmup rejected before activation",
    });
    const harness = createHarness(support.testState.stateDb, placements, {
      environmentService: environments,
      workspacePath: support.testState.root,
    });
    // The existing transport fixture stands in for SSH; native allocation, retirement,
    // placement mutation, credential minting and activation remain real owners.
    harness.environments.startTunnel = vi.fn(async ({ environmentId, ownerEpoch }) => ({
      ...harness.tunnelHandle(ownerEpoch),
      environmentId,
    }));
    return { environments, placements, harness, request, old, failed, destroy, provision };
  }

  it("retires failed setup and dispatches a distinct worker while retaining old cleanup custody", async () => {
    const f = await fixture();
    const original = support.testState.store.get(f.old.environmentId);
    const local = await f.harness.service.reclaim(f.request, () => {});
    expect(local).toMatchObject({
      state: "local",
      generation: f.failed.generation + 1,
      environmentId: null,
    });
    expect(support.testState.store.get(f.old.environmentId)).toEqual(original);
    expect(support.testState.store.list()).toHaveLength(1);
    expect(f.destroy).not.toHaveBeenCalled();
    const active = await f.harness.service.dispatch(f.request, undefined, () => {});
    expect(active.state).toBe("active");
    expect(active.environmentId).not.toBe(f.old.environmentId);
    expect(active.generation).toBeGreaterThan(local.generation);
    expect(support.testState.store.list()).toHaveLength(2);
    expect(support.testState.store.get(f.old.environmentId)).toEqual(original);
    expect(f.destroy).not.toHaveBeenCalled();
    await expect(support.testState.store.ensureNodeEnrollment(f.old.environmentId)).rejects.toThrow(
      "cannot begin node enrollment",
    );
    await expect(
      support.testState.store.renewCredential({
        environmentId: f.old.environmentId,
        expectedOwnerEpoch: f.old.ownerEpoch,
        credentialHash: "late-credential",
        sessionId: f.request.sessionId,
        rpcSetVersion: 1,
        expiresAtMs: 9999,
      }),
    ).rejects.toThrow();
    await expect(
      f.placements.transition({
        sessionId: f.request.sessionId,
        from: "starting",
        to: "active",
        expectedGeneration: f.failed.generation,
        patch: { environmentId: f.old.environmentId, activeOwnerEpoch: f.old.ownerEpoch },
      }),
    ).rejects.toThrow("changed");
    expect(
      f.placements.validateTurnClaim({
        sessionId: f.request.sessionId,
        runId: "late-old-run",
        claimId: "late-old-claim",
        placementGeneration: f.failed.generation,
        owner: { kind: "local", environmentId: f.old.environmentId, ownerEpoch: f.old.ownerEpoch },
      }),
    ).toBe(false);
    expect(f.placements.get(f.request.sessionId)).toEqual(active);
  });

  it("keeps admitted-worker cleanup on its existing teardown path", async () => {
    const f = await fixture();
    await f.harness.service.reclaim(f.request);
    const active = await f.harness.service.dispatch(f.request);
    await f.harness.service.forceDestroyEnvironment(active.environmentId);
    const failed = f.placements.get(f.request.sessionId)!;
    await expect(f.harness.service.reclaim(f.request)).rejects.toThrow("uncertain old allocation");
    expect(f.placements.get(f.request.sessionId)?.activeOwnerEpoch).toBe(failed.activeOwnerEpoch);
    expect(f.placements.get(f.request.sessionId)?.state).toBe("failed");
  });

  it("preserves the default teardown barrier without the existing recovery opt-in", async () => {
    const f = await fixture(false);
    await expect(f.harness.service.reclaim(f.request)).rejects.toThrow("uncertain old allocation");
    expect(f.placements.get(f.request.sessionId)?.state).toBe("failed");
    expect(f.provision).toHaveBeenCalledOnce();
  });

  it("denies caller loss during retirement before the placement commit", async () => {
    const f = await fixture();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    // Existing owner hook: retire an outstanding enrollment before accepting the local cutover.
    let current = true;
    const revoke = vi
      .spyOn(support.testState.store, "revokeEnvironmentCredential")
      .mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
      });
    const error = new Error("original caller closed");
    const result = f.harness.service.reclaim(f.request, () => {
      if (!current) {
        throw error;
      }
    });
    await entered.promise;
    current = false;
    release.resolve();
    await expect(result).rejects.toBe(error);
    expect(f.placements.get(f.request.sessionId)).toEqual(f.failed);
    expect(f.provision).toHaveBeenCalledOnce();
    revoke.mockRestore();
  });
});
