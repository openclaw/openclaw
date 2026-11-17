import { afterEach, describe, expect, it, vi } from "vitest";
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
import {
  createQueueTestRun,
  installQueueRuntimeErrorSilencer,
  rejectQueuePreparation,
} from "./queue.test-helpers.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";

installQueueRuntimeErrorSilencer();
afterEach(resetGatewayWorkAdmission);
afterEach(() => vi.useRealTimers());

describe.each(["followup", "collect"] as const)("queued %s", (mode) => {
  it.each(["replacement", "rollback", "disabled", "cancel"] as const)(
    "settles plugin %s without retrying the unavailable owner",
    async (outcome) => {
      vi.useFakeTimers();
      const key = `generation-reload-${mode}-${outcome}`;
      const original = captureActivePluginRegistrySnapshot();
      const credential = { type: "api_key" as const, provider: "queue-generation", key: "test" };
      const predecessor = new PluginInstance(credential.provider);
      const stale = createEmptyPluginRegistry();
      const current = createEmptyPluginRegistry();
      for (const [registry, formatApiKey] of [
        [stale, predecessor.wrap(() => "retired")],
        [current, () => "current provider reply"],
      ] as const) {
        registry.providers.push({
          pluginId: credential.provider,
          source: "synthetic",
          provider: { id: credential.provider, label: "Fixture", auth: [], formatApiKey },
        });
      }
      const cancellation = new AbortController();
      const onAbandoned = vi.fn();
      const queued = createQueueTestRun({
        prompt: "accepted before reload",
        abortSignal: cancellation.signal,
        turnAdoptionLifecycle: { onAdopted() {}, onAbandoned },
      });
      const delivered: Array<string | undefined> = [];
      const release = outcome === "disabled" ? undefined : predecessor.reserveReplacement();
      let settled = false;
      let attempts = 0;
      try {
        predecessor.quiesce();
        setActivePluginRegistry(stale);
        withPluginRuntimeGenerationScope(
          {
            metadataSnapshot: createPluginMetadataSnapshotFixture(),
            pluginRegistry: stale,
          },
          () => {
            expect(enqueueFollowupRun(key, queued, { mode, debounceMs: 0, cap: 50 })).toBe(true);
            scheduleFollowupDrain(key, async (run) => {
              attempts += 1;
              // Bound the broken implementation instead of letting its retry loop starve the test.
              if (attempts > 1 && !settled) {
                return;
              }
              try {
                expect(run.prompt).toContain("accepted before reload");
                const provider = resolvePluginProvidersCore({ registryScope: "loaded" })[0];
                delivered.push(provider?.formatApiKey?.(credential));
              } catch (error) {
                if (!(error instanceof PluginInstanceUnavailableError)) {
                  throw error;
                }
                rejectQueuePreparation(run, error);
              }
            });
          },
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(attempts).toBe(1);
        if (outcome !== "disabled") {
          expect(getExistingFollowupQueue(key)?.items).toEqual([queued]);
          if (outcome === "cancel") {
            cancellation.abort();
          } else if (outcome === "replacement") {
            setActivePluginRegistry(current);
          } else {
            predecessor.resume();
          }
        }
        settled = true;
        if (outcome !== "cancel") {
          release?.();
        }
        await queued.controllerInput!.settlement.promise;
        await queued.controllerInput!.claim?.settlement.promise;
        const abandoned = outcome === "disabled" || outcome === "cancel";
        expect(delivered).toEqual(
          abandoned ? [] : [outcome === "rollback" ? "retired" : "current provider reply"],
        );
        expect(onAbandoned).toHaveBeenCalledTimes(abandoned ? 1 : 0);
        expect(getExistingFollowupQueue(key)).toBeUndefined();
      } finally {
        release?.();
        clearFollowupQueue(key);
        await predecessor.dispose();
        restoreActivePluginRegistrySnapshot(original);
      }
    },
  );
});
