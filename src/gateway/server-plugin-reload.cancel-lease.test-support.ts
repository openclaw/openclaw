import assert from "node:assert/strict";
import { expect, vi } from "vitest";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import {
  withPluginLifecycleLease,
  type PluginLifecycleLeaseContext,
} from "../plugins/plugin-lifecycle-lease.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { RecoveryFixtureFactory } from "./server-plugin-reload.recovery.test-support.js";

export async function verifyCancelledDrainRollbackLease(
  createRecoveryFixture: RecoveryFixtureFactory,
  stateDir: string,
) {
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const cancellation = new AbortController();
  const rollbackStarted = createDeferredCore();
  const finishRollback = createDeferredCore();
  let reloadLease: PluginLifecycleLeaseContext | undefined;
  const fixture = await createRecoveryFixture({
    env,
    abortOnCandidateStart: false,
    waitForDrain: true,
    drainSignal: cancellation.signal,
    assertInvokerOwned: () => {
      assert(reloadLease);
      reloadLease.assertOwned();
    },
    prepareConfigEffects: () => async () => {
      rollbackStarted.resolve();
      await finishRollback.promise;
    },
  });
  const instance = getPluginInstance(fixture.previousRegistry.plugins[0]!);
  assert(instance);
  const releaseWork = instance.retainWork();
  const drainEntered = createDeferredCore();
  const waitForWork = instance.waitForRetainedWork.bind(instance);
  const observation = vi.spyOn(instance, "waitForRetainedWork").mockImplementation((...args) => {
    const pending = waitForWork(...args);
    drainEntered.resolve();
    return pending;
  });
  let settled = false;
  const reloading = withPluginLifecycleLease(
    { env, waitMs: 0, signal: cancellation.signal },
    async (lease) => {
      reloadLease = lease;
      return await fixture.reload();
    },
  ).then(
    (result) => {
      settled = true;
      return result;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await Promise.race([drainEntered.promise, reloading]);
    expect(fixture.owner.getReloadStatus()?.reason).toBeTruthy();
    cancellation.abort(new Error("operator cancelled reload"));
    await rollbackStarted.promise;
    assert(reloadLease);
    const cancelledLease = reloadLease;
    expect(() => cancelledLease.assertOwned()).toThrow();
    expect(cancelledLease.signal.aborted).toBe(true);
    expect(settled).toBe(false);
    // Cancellation ends the wait, not the writer's custody of pending rollback.
    await expect(
      withPluginLifecycleLease({ env, waitMs: 0 }, async () => "competing owner"),
    ).rejects.toMatchObject({ outcome: { kind: "held" } });
    expect(fixture.candidates).toHaveLength(0);
    expect(fixture.firstStop).not.toHaveBeenCalled();
    finishRollback.resolve();
    expect(await reloading).toBeInstanceOf(Error);
    expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
    expect(fixture.owner.getReloadStatus()).toBeUndefined();
    expect(instance.run(() => "still serving")).toBe("still serving");
    instance.retainWork()();
    expect(() => cancelledLease.assertOwned()).toThrowError(
      expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_ABORTED" }),
    );
    await expect(
      withPluginLifecycleLease({ env, waitMs: 0 }, async (lease) => {
        lease.assertOwned();
        return "reacquired";
      }),
    ).resolves.toBe("reacquired");
  } finally {
    finishRollback.resolve();
    releaseWork();
    await reloading;
    observation.mockRestore();
  }
}
