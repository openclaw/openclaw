import { afterEach, expect, it, vi } from "vitest";
import { acquirePluginRegistryForInspection } from "./loader.js";
import { resetPluginLoaderTestStateForTest, writePlugin } from "./loader.test-fixtures.js";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { getPluginRegistryInspectionResources } from "./registry-inspection-resources.js";
import { createInspectionFixture } from "./registry-inspection.test-helpers.js";
import { capturePluginLifecycleAuthority } from "./registry-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";

afterEach(() => resetPluginRuntimeStateForTest());
afterEach(resetPluginLoaderTestStateForTest);

it("keeps predecessor resources through abandoned growth and transfers them only at promotion", async () => {
  const fixture = createInspectionFixture({ resourceProvider: true, pauseDisposal: true });
  const newcomer = writePlugin({ id: "inspection-growth", registration: "" });
  const config = {
    plugins: {
      ...fixture.config.plugins,
      allow: [...fixture.config.plugins.allow, newcomer.id],
      load: { paths: [...fixture.config.plugins.load.paths, newcomer.file] },
    },
  };
  const previous = await acquirePluginRegistryForInspection({ config: fixture.config });
  let pending: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
  try {
    const record = previous.registry.plugins.find(({ id }) => id === fixture.plugin.id)!;
    const normalizeModelId = previous.registry.providers.find(
      ({ pluginId }) => pluginId === record.id,
    )!.provider.normalizeModelId!;
    const read = () => normalizeModelId({ provider: "inspection-resource", modelId: "fixture" });
    const prepare = vi.spyOn(fixture.connection().database, "prepare");
    const current = capturePluginLifecycleAuthority(previous.registry, record, {
      scopedRuntime: true,
    });
    expect(current?.()).toBe(true);
    pending = await acquirePluginRegistryForInspection({
      config,
      previousRegistry: previous.registry,
    });
    expect(pending.registry.plugins).toContain(record);
    await pending.release();
    pending = undefined;
    expect(read()).toBe("42");
    expect(fixture.state.captured.read).toMatchObject({ value: 42 });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(fixture.connection().disposals).toBe(0);
    expect(fixture.connection().instanceDisposals).toBe(0);

    pending = await acquirePluginRegistryForInspection({
      config,
      previousRegistry: previous.registry,
    });
    getPluginRegistryInspectionResources(pending.registry)!.adoptRetainedRegistrations(
      previous.registry,
    );
    await previous.release();
    expect(current?.()).toBe(true);
    expect(
      capturePluginLifecycleAuthority(previous.registry, record, { scopedRuntime: true }),
    ).toBeUndefined();
    expect(read()).toBe("42");
    expect(fixture.state.captured.read).toMatchObject({ value: 42 });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(fixture.connection().disposals).toBe(0);
    expect(fixture.connection().instanceDisposals).toBe(0);
    const released = pending.release();
    await fixture.state.disposalStarted.promise;
    expect(current?.()).toBe(false);
    // The real connection is still open: rejection must precede resource I/O,
    // not merely surface SQLite's closed-database error after physical disposal.
    expect(fixture.connection().database.isOpen).toBe(true);
    expect(read).toThrow(PluginInstanceUnavailableError);
    expect(prepare).toHaveBeenCalledTimes(2);
    fixture.state.finishDisposal.resolve();
    await released;
    pending = undefined;
    expect(read).toThrow(PluginInstanceUnavailableError);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(fixture.connection().disposals).toBe(1);
    expect(fixture.connection().instanceDisposals).toBe(1);
  } finally {
    await fixture.cleanup(pending);
    await fixture.cleanup(previous);
  }
});
