import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { startPluginServices, type PluginServicesHandle } from "./services.js";

const gc = globalThis.gc;
assert.ok(gc, "The retention child requires --expose-gc");
// Allow GC convergence; the broken owner remains reachable even after 100 passes.
const GC_PASSES = 32;
const scenario = process.argv[2];
const counts = { starts: 0, stops: 0 };
const scheduler = createTestGatewayScheduler();
type Reference = { label: string; value: WeakRef<object> };

function createUnownedControl() {
  // End the creation frame so an async module's temporary cannot retain the control.
  return new WeakRef({ unowned: true });
}

function createRegistry() {
  const registry = createEmptyPluginRegistry();
  const id = "retention-probe";
  const service = {
    id,
    start() {
      counts.starts += 1;
    },
    stop() {
      counts.stops += 1;
    },
  };
  registry.services.push({ pluginId: id, origin: "workspace", source: id, id, service });
  return registry;
}

async function createGenerations() {
  const references: Reference[] = [];
  let registry = createRegistry();
  let handle = await startPluginServices({ scheduler, registry, config: {} });
  for (let generation = 0; generation < 8; generation += 1) {
    references.push(
      { label: `handle:${generation}`, value: new WeakRef(handle) },
      { label: `registry:${generation}`, value: new WeakRef(registry) },
    );
    await handle.stop({ strict: true });
    registry = createRegistry();
    handle = await startPluginServices({ scheduler, registry, config: {}, previous: handle });
  }
  return { handle, references };
}

async function createPublishedHandle() {
  const payload = { publications: 0 };
  const reference = new WeakRef(payload);
  const handle = await startPluginServices({
    scheduler,
    registry: createRegistry(),
    config: {},
    throwOnStartError: true,
    onHandle: (published: PluginServicesHandle) => {
      assert.equal(typeof published.stop, "function");
      payload.publications += 1;
    },
  });
  assert.equal(payload.publications, 1);
  return { handle, references: [{ label: "publication-payload", value: reference }] };
}

assert.ok(scenario === "generations" || scenario === "on-handle", "Select a retention scenario");
const { handle, references } =
  scenario === "generations" ? await createGenerations() : await createPublishedHandle();
const control = createUnownedControl();
try {
  for (let pass = 0; pass < GC_PASSES; pass += 1) {
    await setImmediate();
    gc();
  }
  assert.equal(control.deref(), undefined, "Unowned control must collect");
  const retained = references
    .filter(({ value }) => value.deref() !== undefined)
    .map(({ label }) => label);
  const beforeReload = { ...counts };
  await handle.reload({}, new Set(["retention-probe"]));
  assert.equal(counts.starts, beforeReload.starts + 1, "Newest service must restart");
  assert.equal(counts.stops, beforeReload.stops + 1, "Newest service must stop before restarting");
  assert.equal(counts.starts - counts.stops, 1, "Exactly one service must remain active");
  assert.deepEqual(retained, [], "Completed generation or publication state retained");
} finally {
  try {
    await handle.stop({ strict: true });
    assert.equal(counts.starts, counts.stops, "Every service start must have a settled stop");
  } finally {
    await scheduler.stop();
  }
}
