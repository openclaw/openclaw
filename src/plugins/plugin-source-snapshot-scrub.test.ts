import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { PluginInstance } from "./plugin-instance.js";
import {
  registerPluginSnapshotScrub,
  startPluginSnapshotScrubs,
  stopPluginSnapshotScrubs,
} from "./plugin-source-snapshot-scrub.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry-types.js";
import { createPluginRecord } from "./status.test-helpers.js";

function createScrubInstance(registry: PluginRegistry) {
  const record = createPluginRecord({ id: `scrub-${registry.plugins.length}` });
  registry.plugins.push(record);
  return new PluginInstance(record.id, { record, registry });
}

it("starts a scrub registered after an empty registry settled", async () => {
  const registry = createEmptyPluginRegistry();
  await startPluginSnapshotScrubs(registry);
  const instance = createScrubInstance(registry);
  const start = vi.fn(async () => ({ status: "passed" as const }));
  const remove = registerPluginSnapshotScrub(instance, start, async () => {});
  try {
    await nextTurn();
    expect(start).toHaveBeenCalledOnce();
  } finally {
    await stopPluginSnapshotScrubs(registry);
    remove();
    await instance.dispose();
  }
});

it("joins every registered scrub when one cancellation fails", async () => {
  const registry = createEmptyPluginRegistry();
  const gate = createDeferredCore();
  const failure = new Error("first cancellation failed");
  const start = async () => ({ status: "cancelled" as const });
  const first = createScrubInstance(registry);
  const second = createScrubInstance(registry);
  registerPluginSnapshotScrub(first, start, async () => {
    throw failure;
  });
  let joined = false;
  const held = gate.promise.then(() => {
    joined = true;
  });
  registerPluginSnapshotScrub(second, start, () => held);
  let settled = false;
  const outcome = stopPluginSnapshotScrubs(registry).then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await nextTurn();
    expect(settled).toBe(false);
    gate.resolve();
    expect(await outcome).toMatchObject({ errors: [failure] });
    expect(joined).toBe(true);
  } finally {
    gate.resolve();
    await Promise.all([outcome, held]);
    await Promise.all([first.dispose(), second.dispose()]);
  }
});
