import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import { createPluginRecord } from "./status.test-helpers.js";

const key = Symbol.for("openclaw.pluginRegistryLifecycle");
const initial = Object.getOwnPropertyDescriptor(globalThis, key);
afterEach(() => {
  if (initial) {
    Object.defineProperty(globalThis, key, initial);
  } else {
    Reflect.deleteProperty(globalThis, key);
  }
  vi.resetModules();
});

describe("released updater registry retirement", () => {
  it.each(["2026.9.1", "2026.9.2", "2026.9.3"])(
    "preserves %s admission state while adding current ownership",
    async (version) => {
      const registry = createEmptyPluginRegistry();
      const record = createPluginRecord({ id: "updater-owned" });
      registry.plugins.push(record);
      const epoch = Object.freeze({});
      const controller = version === "2026.9.1" ? undefined : new AbortController();
      const recordEpoch = Object.freeze({ registryEpoch: epoch });
      const records = new WeakMap<PluginRecord, object>([[record, recordEpoch]]);
      const legacy = {
        retiredRegistries: new WeakSet<PluginRegistry>(),
        activatedRegistries: new WeakSet([registry]),
        registryEpochs: new WeakMap<PluginRegistry, object>([
          [registry, controller ? { epoch, controller } : epoch],
        ]),
        recordEpochs: new WeakMap([[registry, records]]),
        revokedRecordEpoch: Object.freeze({}),
      };
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: legacy });
      vi.resetModules();
      const current = await import("./registry-lifecycle.js");
      const view = createEmptyPluginRegistry();
      current.bindPluginRegistryResourceOwner(view, registry);
      const observed: boolean[] = [];
      controller?.signal.addEventListener("abort", () => {
        observed.push(
          legacy.retiredRegistries.has(registry) && !legacy.registryEpochs.has(registry),
        );
      });
      current.markPluginRegistryRetired(view);
      expect(legacy.retiredRegistries.has(registry)).toBe(true);
      expect(legacy.registryEpochs.has(registry)).toBe(false);
      expect(legacy.activatedRegistries.has(registry)).toBe(true);
      expect(legacy.recordEpochs.get(registry)).toBe(records);
      expect(records.get(record)).toBe(recordEpoch);
      expect(observed).toEqual(controller ? [true] : []);
      expect(Reflect.get(globalThis, key)).toBe(legacy);
      vi.resetModules();
      const next = await import("./registry-lifecycle.js");
      expect(next.getPluginRegistryResourceOwner(view)).toBe(registry);
      expect(next.isPluginRegistryRetired(view)).toBe(true);
    },
  );
});
