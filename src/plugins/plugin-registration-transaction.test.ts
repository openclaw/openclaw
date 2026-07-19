import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMemoryCapabilityRegistration,
  registerMemoryCapability,
} from "./memory-state.test-fixtures.js";
import {
  createPluginRegistrationTransaction,
  type PluginProcessGlobalState,
  restorePluginProcessGlobalState,
  snapshotPluginProcessGlobalState,
} from "./plugin-registration-transaction.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

describe("plugin registration transaction", () => {
  let initialProcessGlobalState: PluginProcessGlobalState;

  beforeEach(() => {
    initialProcessGlobalState = snapshotPluginProcessGlobalState();
  });

  afterEach(() => {
    restorePluginProcessGlobalState(initialProcessGlobalState);
  });

  it("rolls back registry writes and restores prior process-global capability state", () => {
    const registry = createEmptyPluginRegistry();
    const activePromptBuilder = () => ["active"];
    const failedResolver = () => "failed";
    const rollbackGlobalSideEffects = vi.fn();
    registerMemoryCapability("active-memory", { promptBuilder: activePromptBuilder });

    const transaction = createPluginRegistrationTransaction({
      registry,
      rollbackGlobalSideEffects,
    });
    registry.hostedMediaResolvers.push({
      pluginId: "failed-plugin",
      resolver: failedResolver,
      source: "failed-plugin",
    });
    registry.gatewayHandlers.failed = async () => {};
    registerMemoryCapability("failed-memory", { promptBuilder: () => ["failed"] });

    transaction.rollback();

    expect(rollbackGlobalSideEffects).toHaveBeenCalledOnce();
    expect(registry.hostedMediaResolvers).toStrictEqual([]);
    expect(registry.gatewayHandlers).toStrictEqual({});
    expect(getMemoryCapabilityRegistration()).toEqual({
      pluginId: "active-memory",
      capability: { promptBuilder: activePromptBuilder },
    });
  });

  it("keeps snapshot registry writes while restoring globals for non-activating commits", () => {
    const registry = createEmptyPluginRegistry();
    const activePromptBuilder = () => ["active"];
    const snapshotResolver = () => "snapshot";
    registerMemoryCapability("active-memory", { promptBuilder: activePromptBuilder });

    const transaction = createPluginRegistrationTransaction({ registry });
    registry.hostedMediaResolvers.push({
      pluginId: "snapshot-plugin",
      resolver: snapshotResolver,
      source: "snapshot-plugin",
    });
    registerMemoryCapability("snapshot-memory", { promptBuilder: () => ["snapshot"] });

    transaction.commit({ activate: false });

    expect(registry.hostedMediaResolvers).toEqual([
      {
        pluginId: "snapshot-plugin",
        resolver: snapshotResolver,
        source: "snapshot-plugin",
      },
    ]);
    expect(getMemoryCapabilityRegistration()).toEqual({
      pluginId: "active-memory",
      capability: { promptBuilder: activePromptBuilder },
    });
  });

  it("rolls back nested config mutations on a registered entry (#107514)", () => {
    const registry = createEmptyPluginRegistry();
    const nestedEntry = {
      pluginId: "nested-plugin",
      resolver: () => "nested",
      source: "nested-plugin",
      config: { enabled: true, depth: { level: 1 } },
    };
    registry.hostedMediaResolvers.push(nestedEntry);

    const transaction = createPluginRegistrationTransaction({ registry });
    // Mutate a nested property in place (not a replacement) during the transaction.
    nestedEntry.config.enabled = false;
    nestedEntry.config.depth.level = 99;

    transaction.rollback();

    // The snapshot must have deep-cloned the entry, so the in-transaction
    // nested mutation is fully reverted instead of orphaning the mutated
    // state in the live registry.
    expect(registry.hostedMediaResolvers).toEqual([
      {
        pluginId: "nested-plugin",
        resolver: expect.any(Function),
        source: "nested-plugin",
        config: { enabled: true, depth: { level: 1 } },
      },
    ]);
  });

  it("preserves typed values (Date) and callable entries across rollback (#107514)", () => {
    const registry = createEmptyPluginRegistry();
    const failedAt = new Date("2026-07-19T00:00:00.000Z");
    const pluginRecord = {
      pluginId: "typed-plugin",
      resolver: () => "typed",
      source: "typed-plugin",
      failedAt,
    };
    registry.hostedMediaResolvers.push(pluginRecord);

    const transaction = createPluginRegistrationTransaction({ registry });
    // Roll back without mutating the entry.
    transaction.rollback();

    const restored = registry.hostedMediaResolvers[0] as typeof pluginRecord;
    // Typed values must keep their constructor, not collapse to {}.
    expect(restored.failedAt).toBeInstanceOf(Date);
    expect(restored.failedAt.getTime()).toBe(failedAt.getTime());
    // Callable registry entries must remain callable (reference preserved).
    expect(typeof restored.resolver).toBe("function");
    expect(restored.resolver()).toBe("typed");
  });

  it("preserves custom-class instance identity across rollback (#107514)", () => {
    const registry = createEmptyPluginRegistry();
    class CustomMeta {
      count: number;
      constructor(count: number) {
        this.count = count;
      }
      get doubled(): number {
        return this.count * 2;
      }
    }
    const meta = new CustomMeta(7);
    const entry = {
      pluginId: "class-plugin",
      resolver: () => "class",
      source: "class-plugin",
      meta,
    };
    registry.hostedMediaResolvers.push(entry);

    const transaction = createPluginRegistrationTransaction({ registry });
    entry.meta.count = 100;

    transaction.rollback();

    const restored = registry.hostedMediaResolvers[0] as typeof entry;
    // Custom-class instances get a prototype-preserving recursive clone, so the
    // in-transaction mutation is reverted instead of leaking through a shared
    // reference; the constructor/methods must survive rollback intact.
    expect(restored.meta).toBeInstanceOf(CustomMeta);
    expect(restored.meta).not.toBe(meta);
    expect(meta.doubled).toBe(200);
    expect(restored.meta.doubled).toBe(14);
  });

  it("rolls back callback-bearing Map and Set entries across rollback (#107514)", () => {
    const registry = createEmptyPluginRegistry();
    const callback = () => "cb";
    const entry = {
      pluginId: "collection-plugin",
      resolver: () => "collection",
      source: "collection-plugin",
      handlers: new Map<string, unknown>([["alpha", { fn: callback, retries: 1 }]]),
      tags: new Set<unknown>([{ fn: callback, weight: 1 }]),
    };
    registry.hostedMediaResolvers.push(entry);

    const transaction = createPluginRegistrationTransaction({ registry });
    (entry.handlers.get("alpha") as { retries: number }).retries = 99;
    entry.handlers.set("beta", { fn: callback, retries: 2 });
    for (const tag of entry.tags) {
      (tag as { weight: number }).weight = 99;
    }
    entry.tags.add({ fn: callback, weight: 2 });

    transaction.rollback();

    const restored = registry.hostedMediaResolvers[0] as typeof entry;
    // Collections are cloned entry-by-entry, so in-transaction mutations and
    // insertions revert while callback references stay callable.
    expect(restored.handlers).toBeInstanceOf(Map);
    expect([...restored.handlers.keys()]).toEqual(["alpha"]);
    expect(restored.handlers.get("alpha")).toEqual({ fn: expect.any(Function), retries: 1 });
    expect((restored.handlers.get("alpha") as { fn: () => string }).fn()).toBe("cb");
    expect(restored.tags).toBeInstanceOf(Set);
    expect(restored.tags.size).toBe(1);
    const tag = [...restored.tags][0] as { fn: () => string; weight: number };
    expect(tag).toEqual({ fn: expect.any(Function), weight: 1 });
    expect(tag.fn()).toBe("cb");
  });
});
