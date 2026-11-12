import { expect, it, vi } from "vitest";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { createDeferredCore } from "../shared/deferred.js";
import { LegacyContextEngine } from "./legacy.js";
import {
  type ContextEngineFactoryResources,
  disposeContextEngineSources,
  recordContextEngineRegistrationSource,
  resolveContextEngineFactory,
  retainLogicalTurnContextEngineSources,
} from "./registry.resources.js";
import type { ContextEngine } from "./types.js";

it("keeps selected factories and physical donors through cleanup", async () => {
  const registry = createEmptyPluginRegistry();
  const donor = createEmptyPluginRegistry();
  const primaryDisposed = vi.fn();
  const donorDisposed = vi.fn();
  const primary = new PluginRegistryInspectionResources(async () => {
    primaryDisposed();
  });
  const donorResources = new PluginRegistryInspectionResources(async () => {
    donorDisposed();
  });
  primary.attach(registry);
  donorResources.attach(donor);
  // Identical plugin IDs must not let a sibling or replacement inherit custody.
  const selected = new PluginInstance("engine");
  const fallback = new PluginInstance("fallback");
  const unrelated = new PluginInstance("engine");
  const selectedRegistration = {
    factory: selected.wrap(() => new LegacyContextEngine()),
    owner: "plugin:engine",
    lifecycle: "runtime" as const,
  };
  const fallbackRegistration = {
    factory: fallback.wrap(() => new LegacyContextEngine()),
    owner: "plugin:fallback",
    lifecycle: "runtime" as const,
  };
  registry.contextEngines.set("selected", selectedRegistration);
  registry.contextEngines.set("legacy", fallbackRegistration);
  registry.contextEngines.set("unused", {
    factory: unrelated.wrap(() => new LegacyContextEngine()),
    owner: "plugin:engine",
    lifecycle: "runtime",
  });
  recordContextEngineRegistrationSource(selectedRegistration, donor);
  const sources = retainLogicalTurnContextEngineSources(
    registry,
    fallbackRegistration,
    selectedRegistration,
    () => {},
  );
  const retained = [sources.fallback!, sources.configured!];
  const cleanupStarted = createDeferredCore();
  const finishCleanup = createDeferredCore();
  let cleanup: Promise<void> | undefined;
  try {
    expect(sources.configuredFailure).toBeUndefined();
    expect(selected.retainedWorkCount).toBeGreaterThan(0);
    expect(fallback.retainedWorkCount).toBeGreaterThan(0);
    expect(unrelated.retainedWorkCount).toBe(0);
    const owners = new Map<ContextEngine, ContextEngineFactoryResources[]>();
    const { engine } = await resolveContextEngineFactory(sources.configured, owners, async () => ({
      engine: selectedRegistration.factory(),
    }));
    await primary.release();
    await donorResources.release();
    expect(primaryDisposed).not.toHaveBeenCalled();
    expect(donorDisposed).not.toHaveBeenCalled();
    cleanup = disposeContextEngineSources(engine, retained, async () => {
      cleanupStarted.resolve();
      await finishCleanup.promise;
      expect(primaryDisposed).not.toHaveBeenCalled();
      expect(donorDisposed).not.toHaveBeenCalled();
    });
    await cleanupStarted.promise;
    expect(donorDisposed).not.toHaveBeenCalled();
    finishCleanup.resolve();
    await cleanup;
    expect(primaryDisposed).toHaveBeenCalledOnce();
    expect(donorDisposed).toHaveBeenCalledOnce();
    expect(selected.retainedWorkCount).toBe(0);
    expect(fallback.retainedWorkCount).toBe(0);
    expect(unrelated.retainedWorkCount).toBe(0);
  } finally {
    finishCleanup.resolve();
    if (cleanup) {
      await cleanup;
    } else {
      await disposeContextEngineSources(undefined, retained);
    }
    await primary.release();
    await donorResources.release();
    await Promise.all([selected.dispose(), fallback.dispose(), unrelated.dispose()]);
  }
});
