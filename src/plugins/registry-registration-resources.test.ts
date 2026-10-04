import { describe, expect, it } from "vitest";
import { transferPluginInstanceOwner } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { PluginRegistrationResourceSource } from "./registry-registration-resources.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";

function createRegistry(plugins: PluginRecord[]): PluginRegistry {
  return { plugins } as unknown as PluginRegistry;
}

function createRecord(id: string): PluginRecord {
  return { id } as unknown as PluginRecord;
}

/**
 * Regression coverage for Finding 1: a registration with no managed instance at all
 * (e.g. a lifecycle-only disposer registered via registry-registrars-host.ts, which
 * explicitly supports `registerRuntimeLifecycle` without an underlying plugin instance)
 * must still have its disposer invoked on cleanup. There is no successor registry to
 * transfer ownership to, so skipping disposal here would leak the resource forever.
 */
describe("PluginRegistrationResourceSource disposal with no managed instance", () => {
  it("disposes a disposer for a registration with no instance in the registry", async () => {
    const pluginId = "no-instance-plugin";
    const record = createRecord(pluginId);
    const registry = createRegistry([record]);
    let disposed = false;

    // Intentionally never create a PluginInstance for this record: this mirrors a
    // registration created purely via registerRuntimeLifecycle's lifecycle-only path
    // (registry-registrars-host.ts), which has a disposer but no managed instance.
    const source = new PluginRegistrationResourceSource(
      async () => undefined,
      () => registry,
    );
    source.register(pluginId, {
      id: "runtime-lifecycle",
      dispose: () => {
        disposed = true;
      },
    });

    const claim = source.acquireClaim("inspection");
    const failures = await claim.release();

    expect(failures).toEqual([]);
    expect(disposed).toBe(true);
  });

  it("still skips disposal when the instance was transferred to a different registry", async () => {
    const pluginId = "transferred-plugin";
    const record = createRecord(pluginId);
    const registry = createRegistry([record]);
    const otherRegistry = createRegistry([record]);
    let disposed = false;

    // Create a real managed instance owned by `registry`, then transfer ownership to
    // `otherRegistry` the same way loader-runtime-core.ts does for a successor generation.
    new PluginInstance(pluginId, { record, registry });
    transferPluginInstanceOwner(record, otherRegistry);

    const source = new PluginRegistrationResourceSource(
      async () => undefined,
      () => registry,
    );
    source.register(pluginId, {
      id: "runtime-lifecycle",
      dispose: () => {
        disposed = true;
      },
    });

    const claim = source.acquireClaim("inspection");
    const failures = await claim.release();

    expect(failures).toEqual([]);
    expect(disposed).toBe(false);
  });

  it("disposes when an instance exists and is still owned by this registry", async () => {
    const pluginId = "owned-plugin";
    const record = createRecord(pluginId);
    const registry = createRegistry([record]);
    let disposed = false;

    new PluginInstance(pluginId, { record, registry });

    const source = new PluginRegistrationResourceSource(
      async () => undefined,
      () => registry,
    );
    source.register(pluginId, {
      id: "runtime-lifecycle",
      dispose: () => {
        disposed = true;
      },
    });

    const claim = source.acquireClaim("inspection");
    const failures = await claim.release();

    expect(failures).toEqual([]);
    expect(disposed).toBe(true);
  });
});
