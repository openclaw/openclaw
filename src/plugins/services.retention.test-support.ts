import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { startPluginServices, type PluginServicesHandle } from "./services.js";

const gc = globalThis.gc;
assert.ok(gc, "The retention child requires --expose-gc");
const scenario = process.argv[2];
const counts = { starts: 0, stops: 0 };
type Reference = { label: string; value: WeakRef<object> };

function createUnownedControl() {
  // End the creation frame so an async module's temporary cannot retain the control.
  return new WeakRef({ unowned: true });
}

function createRegistry() {
  const registry = createEmptyPluginRegistry();
  registry.services.push({
    pluginId: "retention-probe",
    origin: "workspace",
    source: "retention-probe",
    service: {
      id: "retention-probe",
      start() {
        counts.starts += 1;
      },
      stop() {
        counts.stops += 1;
      },
    },
  });
  return registry;
}

async function createGenerations() {
  const references: Reference[] = [];
  let registry = createRegistry();
  let handle = await startPluginServices({ registry, config: {} });
  for (let generation = 0; generation < 8; generation += 1) {
    references.push(
      { label: `handle:${generation}`, value: new WeakRef(handle) },
      { label: `registry:${generation}`, value: new WeakRef(registry) },
    );
    await handle.stop({ strict: true });
    registry = createRegistry();
    handle = await startPluginServices({ registry, config: {}, previous: handle });
  }
  return { handle, references };
}

class PublicationPayload {
  publications = 0;
}

async function createPublishedHandle() {
  const payload = new PublicationPayload();
  const reference = new WeakRef(payload);
  const handle = await startPluginServices({
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
  for (let pass = 0; pass < 8; pass += 1) {
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
  console.log(
    JSON.stringify({
      scenario,
      observed: references.length,
      retained,
      controlCollected: true,
      newestReloadUsable: true,
      counts,
    }),
  );
  assert.deepEqual(
    retained,
    [],
    "Live service handle retained completed generation or publication state",
  );
} finally {
  await handle.stop({ strict: true });
  assert.equal(counts.starts, counts.stops, "Every service start must have a settled stop");
}
