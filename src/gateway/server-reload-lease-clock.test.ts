import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import * as leaseStorage from "../state/openclaw-state-lease-storage.js";
import { createPluginLifecycleLeaseTestClock } from "./config-reload.test-support.js";

afterEach(() => vi.useRealTimers());

it("settles a contended reload lease after its holder releases with the fake clock stopped", async ({
  signal,
}) => {
  vi.useFakeTimers();
  const holderEntered = createDeferred();
  const releaseHolder = createDeferred();
  const holder = withPluginLifecycleLease({ signal }, async () => {
    holderEntered.resolve();
    await releaseHolder.promise;
  });
  await Promise.race([holderEntered.promise, holder]);
  const clock = createPluginLifecycleLeaseTestClock();
  const contention = createDeferred();
  const acquire = leaseStorage.acquireLease;
  const acquisition = vi.spyOn(leaseStorage, "acquireLease").mockImplementation(async (...args) => {
    const result = await acquire(...args);
    if (result.kind !== "acquired") {
      contention.resolve();
    }
    return result;
  });
  const entered = vi.fn(async () => {});
  const queued = withPluginLifecycleLease({ signal }, entered);
  try {
    await Promise.race([contention.promise, queued]);
    releaseHolder.resolve();
    await holder;
    // Releasing the real holder cannot wake an already scheduled fake backoff.
    expect(entered).not.toHaveBeenCalled();
    await clock.waitFor(queued);
    await clock.waitForFirstLease();
    expect(entered).toHaveBeenCalledOnce();
  } finally {
    releaseHolder.resolve();
    await holder;
    acquisition.mockRestore();
  }
});
