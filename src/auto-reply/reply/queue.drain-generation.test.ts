import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { PreparedModelRuntimePluginGenerationRetiredError } from "../../agents/prepared-model-runtime-admission-errors.js";
import { PluginInstanceUnavailableError } from "../../plugins/plugin-instance-error.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { PluginInvocationScope } from "../../plugins/plugin-invocation-scope.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { resolvePluginProvidersCore } from "../../plugins/providers.runtime.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import {
  admitFollowupRunLifecycle,
  enqueueFollowupRun,
  scheduleFollowupDrain,
  type FollowupRun,
} from "./queue.js";
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
  it.each(["unadopted", "adopted", "no-lifecycle"] as const)(
    "settles a thrown runner with %s custody",
    async (custody) => {
      const key = `runner-throw-${mode}-${custody}`;
      const onAbandoned = vi.fn();
      const onSettled = vi.fn();
      const finishCorrelation = vi.fn();
      const queued = createQueueTestRun({
        prompt: "accepted before runner failure",
        turnAdoptionLifecycle:
          custody === "no-lifecycle" ? undefined : { onAdopted() {}, onAbandoned, onSettled },
        deliveryCorrelations: [{ begin: () => finishCorrelation }],
      });
      const execute = vi.fn(async (run: FollowupRun) => {
        if (custody === "adopted") {
          await admitFollowupRunLifecycle(run);
        }
        throw new Error("runner failed before returning a disposition");
      });
      try {
        enqueueFollowupRun(key, queued, { mode, debounceMs: 0 });
        scheduleFollowupDrain(key, execute);
        await queued.controllerInput!.settlement.promise;
        await queued.controllerInput!.claim?.settlement.promise;
        expect(execute).toHaveBeenCalledOnce();
        expect(onAbandoned).toHaveBeenCalledTimes(custody === "unadopted" ? 1 : 0);
        expect(onSettled).toHaveBeenCalledTimes(custody === "no-lifecycle" ? 0 : 1);
        expect(finishCorrelation).toHaveBeenCalledTimes(custody === "unadopted" ? 1 : 0);
        expect(getExistingFollowupQueue(key)).toBeUndefined();
      } finally {
        clearFollowupQueue(key);
      }
    },
  );

  it.each([
    "replacement",
    "rollback",
    "disabled",
    "cancel",
    "shutdown",
    "plain",
    "retired",
  ] as const)("settles plugin %s without retrying the unavailable owner", async (outcome) => {
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
    const release = ["disabled", "plain", "retired"].includes(outcome)
      ? undefined
      : predecessor.reserveReplacement();
    let settled = false;
    let attempts = 0;
    const generic = outcome === "plain" || outcome === "retired";
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
            if (attempts > (generic ? 20 : 1) && !settled) {
              return;
            }
            expect(run.prompt).toContain("accepted before reload");
            try {
              if (!settled && outcome === "plain") {
                predecessor.retainConsumer().release();
              }
              if (!settled && outcome === "retired") {
                throw new PreparedModelRuntimePluginGenerationRetiredError(
                  "preparation unavailable",
                );
              }
              const provider = resolvePluginProvidersCore({ registryScope: "loaded" })[0];
              delivered.push(provider?.formatApiKey?.(credential));
            } catch (error) {
              if (!(error instanceof Error)) {
                throw error;
              }
              rejectQueuePreparation(run, error);
            }
          });
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      const claim = queued.controllerInput!.claim;
      if (generic) {
        await vi.advanceTimersByTimeAsync(999);
        expect(attempts).toBe(4);
      }
      if (outcome !== "disabled") {
        expect(getExistingFollowupQueue(key)?.items).toEqual([queued]);
        if (outcome === "shutdown") {
          markGatewayRestartDraining();
        } else if (outcome === "cancel") {
          cancellation.abort();
        } else if (outcome === "replacement" || generic) {
          setActivePluginRegistry(current);
        } else {
          predecessor.resume();
        }
      }
      settled = true;
      if (outcome !== "cancel" && outcome !== "shutdown") {
        release?.();
      }
      await vi.advanceTimersByTimeAsync(250);
      if (outcome === "shutdown") {
        expect(claim?.released).toBe(true);
        clearFollowupQueue(key);
        await vi.advanceTimersByTimeAsync(0);
      }
      await queued.controllerInput!.settlement.promise;
      await queued.controllerInput!.claim?.settlement.promise;
      const abandoned = ["disabled", "cancel", "shutdown"].includes(outcome);
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
  });
});

it.each(["followup", "collect"] as const)(
  "resolves the current provider for queued %s input after its predecessor scope closes and retires",
  async (mode) => {
    const released = createDeferred();
    const started = createDeferred();
    const key = `generation-reload-${mode}`;
    const original = captureActivePluginRegistrySnapshot();
    const predecessor = new PluginInstance("queue-generation-fixture");
    const successor = new PluginInstance("queue-generation-fixture");
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
        formatApiKey: successor.wrap(currentHook),
      },
    });
    const scope = new PluginInvocationScope(stale, [predecessor], { retained: true });
    const queued = createQueueTestRun({ prompt: "accepted before reload" });
    const delivered: Array<{ prompt: string; reply: string | undefined }> = [];
    try {
      setActivePluginRegistry(stale);
      scope.run(() =>
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
              try {
                const provider = resolvePluginProvidersCore({ registryScope: "loaded" })[0];
                delivered.push({
                  prompt: run.prompt,
                  reply: provider?.formatApiKey?.({
                    type: "api_key",
                    provider: "queue-generation-fixture",
                    key: "synthetic-only",
                  }),
                });
              } catch (error) {
                // Stop fixture retries so a broken drain reports an assertion failure.
                clearFollowupQueue(key);
                throw error;
              }
            });
          },
        ),
      );
      await started.promise;
      expect(getExistingFollowupQueue(key)?.items).toEqual([queued]);
      scope.release();
      await predecessor.dispose();
      expect(() => retiredHook()).toThrow(PluginInstanceUnavailableError);
      setActivePluginRegistry(current);
      released.resolve();
      // 2026.10.10's queue owner settles the drained item by retiring its queue.
      await vi.waitFor(() => expect(getExistingFollowupQueue(key)).toBeUndefined());
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.prompt).toContain("accepted before reload");
      expect(delivered[0]?.reply).toBe("current provider reply");
      expect(currentHook).toHaveBeenCalledOnce();
      expect(getExistingFollowupQueue(key)).toBeUndefined();
    } finally {
      released.resolve();
      clearFollowupQueue(key);
      scope.release();
      await predecessor.dispose();
      await successor.dispose();
      restoreActivePluginRegistrySnapshot(original);
    }
  },
);
