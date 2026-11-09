import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { PluginInstance } from "./plugin-instance.js";
import {
  registerPluginSnapshotScrub,
  type PluginSnapshotScrubOutcome,
} from "./plugin-source-snapshot-scrub.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry-types.js";
import {
  createPluginRegistryOwner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "./runtime.js";
import { createPluginRecord } from "./status.test-helpers.js";

afterEach(() => resetPluginRuntimeStateForTest());

function registerHeldScrub(registry: PluginRegistry, existing?: PluginInstance) {
  let instance = existing;
  if (!instance) {
    const record = createPluginRecord({ id: `scrub-${registry.plugins.length}` });
    registry.plugins.push(record);
    instance = new PluginInstance(record.id, { record, registry });
  }
  const completion = createDeferredCore<PluginSnapshotScrubOutcome>();
  const cancellation = createDeferredCore();
  const start = vi.fn(() => completion.promise);
  const cancel = vi.fn(async () => {
    await cancellation.promise;
    completion.resolve({ status: "cancelled" });
  });
  const remove = registerPluginSnapshotScrub(instance, start, cancel);
  return { instance, start, cancel, completion, cancellation, remove };
}

it("starts only the published registry after the owner reaches post-ready", async () => {
  const initial = createEmptyPluginRegistry();
  const replacement = createEmptyPluginRegistry();
  const staged = createEmptyPluginRegistry();
  const first = registerHeldScrub(initial);
  const second = registerHeldScrub(replacement);
  const unpublished = registerHeldScrub(staged);
  setActivePluginRegistry(initial);
  const owner = createPluginRegistryOwner(initial);
  try {
    setActivePluginRegistry(replacement);
    owner.publish(replacement);
    expect(first.start).not.toHaveBeenCalled();
    expect(second.start).not.toHaveBeenCalled();
    const started = owner.sourceSnapshotScrubs.start();
    await nextTurn();
    expect(first.start).not.toHaveBeenCalled();
    expect(second.start).toHaveBeenCalledOnce();
    expect(unpublished.start).not.toHaveBeenCalled();
    second.cancellation.resolve();
    await owner.sourceSnapshotScrubs.stop();
    await started;
  } finally {
    for (const scrub of [first, second, unpublished]) {
      scrub.cancellation.resolve();
      scrub.completion.resolve({ status: "cancelled" });
      scrub.remove();
    }
    await owner.close();
    await unpublished.instance.dispose();
  }
});

it.each([1, 2])(
  "starts adopted instance scrubs after %i committed replacements before post-ready",
  async (replacements) => {
    const initial = createEmptyPluginRegistry();
    const staged = createEmptyPluginRegistry();
    const retainedRecord = createPluginRecord({ id: "retained-snapshot" });
    const discardedRecord = createPluginRecord({ id: "discarded-snapshot" });
    const stagedRecord = createPluginRecord({ id: retainedRecord.id });
    initial.plugins.push(retainedRecord, discardedRecord);
    staged.plugins.push(stagedRecord);
    const retained = new PluginInstance(retainedRecord.id, {
      record: retainedRecord,
      registry: initial,
    });
    const discarded = new PluginInstance(discardedRecord.id, {
      record: discardedRecord,
      registry: initial,
    });
    const stagedInstance = new PluginInstance(stagedRecord.id, {
      record: stagedRecord,
      registry: staged,
    });
    const liveScrub = registerHeldScrub(initial, retained);
    const discardedScrub = registerHeldScrub(initial, discarded);
    const stagedScrub = registerHeldScrub(staged, stagedInstance);
    setActivePluginRegistry(initial);
    const owner = createPluginRegistryOwner(initial);
    try {
      for (let index = 0; index < replacements; index++) {
        const next = createEmptyPluginRegistry();
        next.plugins.push(retainedRecord);
        setActivePluginRegistry(next);
        owner.publish(next);
        expect(retained.owner?.registry).toBe(next);
      }
      expect(liveScrub.start).not.toHaveBeenCalled();
      const started = owner.sourceSnapshotScrubs.start();
      await nextTurn();
      expect(liveScrub.start).toHaveBeenCalledOnce();
      expect(discardedScrub.start).not.toHaveBeenCalled();
      expect(stagedScrub.start).not.toHaveBeenCalled();
      liveScrub.cancellation.resolve();
      await owner.sourceSnapshotScrubs.stop();
      await started;
    } finally {
      for (const scrub of [liveScrub, discardedScrub, stagedScrub]) {
        scrub.cancellation.resolve();
        scrub.completion.resolve({ status: "cancelled" });
        scrub.remove();
      }
      await owner.close();
      await Promise.all([retained.dispose(), discarded.dispose(), stagedInstance.dispose()]);
    }
  },
);

it("starts each published replacement and joins every pending generation on close", async () => {
  const registries = [
    createEmptyPluginRegistry(),
    createEmptyPluginRegistry(),
    createEmptyPluginRegistry(),
  ] as const;
  const scrubs = [
    registerHeldScrub(registries[0]),
    registerHeldScrub(registries[1]),
    registerHeldScrub(registries[2]),
  ] as const;
  setActivePluginRegistry(registries[0]);
  const owner = createPluginRegistryOwner(registries[0]);
  let started: Promise<PluginSnapshotScrubOutcome[]> | undefined;
  let closing: ReturnType<typeof owner.close> | undefined;
  try {
    started = owner.sourceSnapshotScrubs.start();
    for (const registry of registries.slice(1)) {
      setActivePluginRegistry(registry);
      owner.publish(registry);
    }
    await nextTurn();
    expect(scrubs.map((scrub) => scrub.start.mock.calls.length)).toEqual([1, 1, 1]);
    let closed = false;
    closing = owner.close().then((result) => {
      closed = true;
      return result;
    });
    await nextTurn();
    expect(scrubs.map((scrub) => scrub.cancel.mock.calls.length)).toEqual([1, 1, 1]);
    scrubs[0].cancellation.resolve();
    scrubs[2].cancellation.resolve();
    await nextTurn();
    expect(closed).toBe(false);
    scrubs[1].cancellation.resolve();
    await closing;
    await started;
  } finally {
    for (const scrub of scrubs) {
      scrub.cancellation.resolve();
      scrub.completion.resolve({ status: "cancelled" });
      scrub.remove();
    }
    await (closing ?? owner.close());
  }
});

it("releases completed predecessor scrubs from the owner's shutdown work", async () => {
  const previous = createEmptyPluginRegistry();
  const next = createEmptyPluginRegistry();
  const completed = registerHeldScrub(previous);
  setActivePluginRegistry(previous);
  const owner = createPluginRegistryOwner(previous);
  try {
    const started = owner.sourceSnapshotScrubs.start();
    completed.completion.resolve({ status: "passed" });
    await started;
    setActivePluginRegistry(next);
    owner.publish(next);
    await owner.close();
    expect(completed.cancel).not.toHaveBeenCalled();
  } finally {
    completed.cancellation.resolve();
    completed.remove();
    await owner.close();
  }
});

it("joins sibling scrubs and finishes resource close after a scrub cancellation fails", async () => {
  const registry = createEmptyPluginRegistry();
  const failed = registerHeldScrub(registry);
  const held = registerHeldScrub(registry);
  failed.cancel.mockImplementation(async () => {
    failed.completion.resolve({ status: "cancelled" });
    throw new Error("synthetic scrub cancellation failed");
  });
  setActivePluginRegistry(registry);
  const owner = createPluginRegistryOwner(registry);
  const started = owner.sourceSnapshotScrubs.start();
  let settled = false;
  const closing = owner.close().then((result) => {
    settled = true;
    return result;
  });
  try {
    await nextTurn();
    expect(failed.cancel).toHaveBeenCalledOnce();
    expect(held.cancel).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    held.cancellation.resolve();
    await expect(closing).resolves.toEqual({ memoryErrors: [], pluginFailures: [] });
    await started;
  } finally {
    held.cancellation.resolve();
    failed.remove();
    held.remove();
    await closing;
  }
});
