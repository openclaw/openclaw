import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { providerService } from "./provider-lifecycle.test-support.js";
import * as support from "./service.test-support.js";
import { createWorkerTunnelManager } from "./tunnel.js";
import { fakeRunner, PWD_COMMAND, startTestTunnel, success } from "./tunnel.test-support.js";

support.setupWorkerEnvironmentServiceSuite();

it("returns reclaim after local cleanup and acceptance, retaining physical destroy ownership", async ({
  signal,
}) => {
  const environmentId = "reclaim-accepted";
  await support.seedReady(environmentId);
  const attached = await support.testState.store.transition({
    environmentId,
    from: "ready",
    to: "attached",
    patch: { ...support.attachedPatch(environmentId, "session-reclaim"), sharedHost: false },
  });
  const cleanupStarted = createDeferred();
  const cleanupFinished = createDeferred();
  const releaseFinished = createDeferred();
  const fake = fakeRunner(() => success());
  const tunnelManager = createWorkerTunnelManager({ runner: fake.runner });
  const handle = await startTestTunnel(tunnelManager, environmentId, attached.ownerEpoch);
  const destroy = vi.fn<WorkerProvider["destroy"]>(async (lease) => {
    expect(tunnelManager.status(environmentId)).toBe("stopped");
    expect(support.testState.store.getCredential(environmentId)).toBeUndefined();
    await expect(handle.runWorkspaceCommand(PWD_COMMAND)).rejects.toThrow(
      "Worker tunnel owner is no longer connected",
    );
    lease.onCleanupAccepted?.();
    await releaseFinished.promise;
  });
  const service = providerService(
    { destroy, supportsCleanupAcceptance: true },
    {
      tunnelManager,
      closeEnvironmentComputers: async () => {
        cleanupStarted.resolve();
        await cleanupFinished.promise;
      },
    },
  );
  const reclaim = service.reclaim(environmentId);
  try {
    await withinTest(cleanupStarted.promise, signal);
    expect(destroy).not.toHaveBeenCalled();
    cleanupFinished.resolve();
    await expect(withinTest(reclaim, signal)).resolves.toMatchObject({ state: "destroying" });
    expect(support.testState.store.getCredential(environmentId)).toBeUndefined();
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "destroying",
      leaseId: `lease:${environmentId}`,
      destroyRequestedAtMs: support.testState.nowMs,
    });

    let confirmed = false;
    const confirmation = service.destroy(environmentId).then((result) => {
      confirmed = true;
      return result;
    });
    await Promise.resolve();
    expect(confirmed).toBe(false);
    releaseFinished.resolve();
    await expect(confirmation).resolves.toMatchObject({ state: "destroyed" });
    expect(destroy).toHaveBeenCalledOnce();
  } finally {
    cleanupFinished.resolve();
    releaseFinished.resolve();
    await reclaim;
    await tunnelManager.stopAll();
  }
});

it("records late cleanup failure after reclaim and retries through reconciliation", async ({
  signal,
}) => {
  const environmentId = "reclaim-retry";
  await support.seedReady(environmentId);
  const releaseFinished = createDeferred();
  const cleanupFailed = createDeferred();
  const destroy = vi
    .fn<WorkerProvider["destroy"]>()
    .mockImplementationOnce(async (lease) => {
      lease.onCleanupAccepted?.();
      await releaseFinished.promise;
      throw new Error("provider release confirmation failed");
    })
    .mockResolvedValue(undefined);
  const service = providerService({ destroy, supportsCleanupAcceptance: true });
  onTestFinished(
    sessionChanges.subscribe(() => {
      if (
        support.testState.store.get(environmentId)?.lastError ===
        "provider release confirmation failed"
      ) {
        cleanupFailed.resolve();
      }
    }),
  );
  try {
    await expect(withinTest(service.reclaim(environmentId), signal)).resolves.toMatchObject({
      state: "destroying",
    });
    releaseFinished.resolve();
    await withinTest(cleanupFailed.promise, signal);
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "destroying",
      leaseId: `lease:${environmentId}`,
      destroyRequestedAtMs: support.testState.nowMs,
      lastError: "provider release confirmation failed",
    });

    await service.reconcileOnce();
    expect(support.testState.store.get(environmentId)).toMatchObject({ state: "destroyed" });
    expect(destroy).toHaveBeenCalledTimes(2);
  } finally {
    releaseFinished.resolve();
  }
});

it("keeps reclaim blocking when a provider does not acknowledge cleanup acceptance", async ({
  signal,
}) => {
  const environmentId = "reclaim-blocking-provider";
  await support.seedReady(environmentId);
  const releaseStarted = createDeferred();
  const releaseFinished = createDeferred();
  const service = providerService({
    destroy: async () => {
      releaseStarted.resolve();
      await releaseFinished.promise;
    },
  });
  let reclaimed = false;
  const reclaim = service.reclaim(environmentId).then((result) => {
    reclaimed = true;
    return result;
  });
  try {
    await withinTest(releaseStarted.promise, signal);
    expect(reclaimed).toBe(false);
    expect(support.testState.store.get(environmentId)?.state).toBe("destroying");
    releaseFinished.resolve();
    await expect(reclaim).resolves.toMatchObject({ state: "destroyed" });
  } finally {
    releaseFinished.resolve();
    await reclaim;
  }
});
