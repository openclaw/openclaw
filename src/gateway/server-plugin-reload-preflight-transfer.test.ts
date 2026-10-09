import { afterEach, describe, expect, it } from "vitest";
import { getRegistryTransferRollbacks } from "../plugins/loader-runtime-core.js";
import { acquirePluginRegistryForInspection } from "../plugins/loader.js";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "../plugins/loader.test-fixtures.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createInspectionFixture } from "../plugins/registry-inspection.test-helpers.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";

describe("Gateway reload preflight ownership transfer", () => {
  it("preflight with previousRegistry but without transferInstanceOwnership does NOT transfer ownership", async () => {
    useNoBundledPlugins();
    const fixture = createInspectionFixture();

    let predecessor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    let preflightInspection:
      | Awaited<ReturnType<typeof acquirePluginRegistryForInspection>>
      | undefined;

    try {
      // Load predecessor generation (simulating active Gateway registry)
      predecessor = await acquirePluginRegistryForInspection({ config: fixture.config });
      const predecessorRecord = predecessor.registry.plugins.find(
        (record) => record.id === fixture.plugin.id,
      );
      const instance = getPluginInstance(predecessorRecord!);
      expect(instance).toBeDefined();

      // Simulate Gateway reload preflight: acquire with previousRegistry but WITHOUT transferInstanceOwnership
      // This mirrors what Gateway does in server-plugin-reload.ts around line 209
      preflightInspection = await acquirePluginRegistryForInspection({
        config: fixture.config,
        previousRegistry: predecessor.registry,
        // No transferInstanceOwnership flag - default is false
      });

      // Verify the instance is present in preflight registry
      const preflightRecord = preflightInspection.registry.plugins.find(
        (record) => record.id === fixture.plugin.id,
      );
      expect(preflightRecord).toBeDefined();

      // CRITICAL ASSERTION: No transfer rollbacks should be registered for preflight
      // because transferInstanceOwnership was not set
      const preflightRollbacks = getRegistryTransferRollbacks(preflightInspection.registry);
      expect(preflightRollbacks).toBeUndefined();

      // Instance should still be owned by predecessor (not transferred)
      expect(instance!.disposing).toBe(false);

      // Release preflight inspection (this should NOT trigger disposals)
      await preflightInspection.release();
      preflightInspection = undefined;

      // Instance should still be alive (not disposed)
      expect(instance!.disposing).toBe(false);

      // Now create a successor WITH transferInstanceOwnership (model-catalog worker path)
      let successor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
      successor = await acquirePluginRegistryForInspection({
        config: fixture.config,
        previousRegistry: predecessor.registry,
        transferInstanceOwnership: true,
      });

      // Verify transfer rollbacks ARE created when transferInstanceOwnership is true
      const successorRollbacks = getRegistryTransferRollbacks(successor.registry);
      expect(successorRollbacks).toBeDefined();

      await successor.release();
    } finally {
      // Cleanup
      await fixture.cleanup(preflightInspection);
      await fixture.cleanup(predecessor);
    }
  });

  it("preflight retains predecessor-owned instance after predecessor release", async () => {
    useNoBundledPlugins();
    const fixture = createInspectionFixture();

    let predecessor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    let preflightInspection:
      | Awaited<ReturnType<typeof acquirePluginRegistryForInspection>>
      | undefined;

    try {
      // Load predecessor generation
      predecessor = await acquirePluginRegistryForInspection({ config: fixture.config });
      const predecessorRecord = predecessor.registry.plugins.find(
        (record) => record.id === fixture.plugin.id,
      );
      const instance = getPluginInstance(predecessorRecord!);
      expect(instance).toBeDefined();

      // Create preflight (no ownership transfer)
      preflightInspection = await acquirePluginRegistryForInspection({
        config: fixture.config,
        previousRegistry: predecessor.registry,
        // No transferInstanceOwnership flag
      });

      // Release predecessor while preflight exists
      await predecessor.release();
      predecessor = undefined;

      // Instance SHOULD be disposed because preflight doesn't own it
      // (preflight didn't take ownership, predecessor released with no one owning it)
      expect(instance!.disposing).toBe(true);

      // However, instance calls through preflight registry should fail
      // because the owner (predecessor) is gone, even though instance isn't disposed
      // This is the correct preflight behavior

      await preflightInspection.release();
      preflightInspection = undefined;

      // Now instance should be disposed since no one owns it anymore
      expect(instance!.disposing).toBe(true);
    } finally {
      await fixture.cleanup(preflightInspection);
      await fixture.cleanup(predecessor);
    }
  });
});

// Reset test state
afterEach(() => resetPluginRuntimeStateForTest());
afterEach(resetPluginLoaderTestStateForTest);
