import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { PluginInstanceUnavailableError } from "../../plugins/plugin-instance-error.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { resolvePluginProvidersCore } from "../../plugins/providers.runtime.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import { createQueueTestRun, installQueueRuntimeErrorSilencer } from "./queue.test-helpers.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";

installQueueRuntimeErrorSilencer();
afterEach(() => {
  resetGatewayWorkAdmission();
});

it.each(["followup", "collect"] as const)(
  "resolves the current provider for queued %s input after its predecessor retires",
  async (mode) => {
    const released = createDeferred();
    const started = createDeferred();
    const key = `generation-reload-${mode}`;
    const original = captureActivePluginRegistrySnapshot();
    const predecessor = new PluginInstance("queue-generation-fixture");
    const stale = createEmptyPluginRegistry();
    const current = createEmptyPluginRegistry();
    const retiredHook = predecessor.wrap(() => "retired");
    stale.providers.push({
      pluginId: "queue-generation-fixture",
      source: "synthetic",
      provider: {
        id: "queue-generation-fixture",
        label: "Fixture",
        auth: [],
        formatApiKey: retiredHook,
      },
    });
    const currentHook = vi.fn(() => "current provider reply");
    current.providers.push({
      pluginId: "queue-generation-fixture",
      source: "synthetic",
      provider: {
        id: "queue-generation-fixture",
        label: "Fixture",
        auth: [],
        formatApiKey: currentHook,
      },
    });
    const queued = createQueueTestRun({ prompt: "accepted before reload" });
    const delivered: Array<{ prompt: string; reply: string | undefined }> = [];
    try {
      setActivePluginRegistry(stale);
      withPluginRuntimeGenerationScope(
        {
          metadataSnapshot: createPluginMetadataSnapshotFixture(),
          pluginRegistry: stale,
        },
        () => {
          expect(enqueueFollowupRun(key, queued, { mode, debounceMs: 0, cap: 50 })).toBe(true);
          scheduleFollowupDrain(key, async (run) => {
            started.resolve();
            await released.promise;
            const provider = resolvePluginProvidersCore({ registryScope: "loaded" })[0];
            delivered.push({
              prompt: run.prompt,
              reply: provider?.formatApiKey?.({
                type: "api_key",
                provider: "queue-generation-fixture",
                key: "synthetic-only",
              }),
            });
          });
        },
      );
      await started.promise;
      expect(getExistingFollowupQueue(key)?.items).toEqual([queued]);
      await predecessor.dispose();
      expect(() => retiredHook()).toThrow(PluginInstanceUnavailableError);
      setActivePluginRegistry(current);
      const claim = queued.controllerInput!.claim!;
      released.resolve();
      await queued.controllerInput!.settlement.promise;
      await claim.settlement.promise;
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.prompt).toContain("accepted before reload");
      expect(delivered[0]?.reply).toBe("current provider reply");
      expect(currentHook).toHaveBeenCalledOnce();
      expect(getExistingFollowupQueue(key)).toBeUndefined();
    } finally {
      released.resolve();
      clearFollowupQueue(key);
      await predecessor.dispose();
      restoreActivePluginRegistrySnapshot(original);
    }
  },
);
