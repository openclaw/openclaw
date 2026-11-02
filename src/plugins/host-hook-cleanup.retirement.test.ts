import { describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withPluginCommandExecution } from "./command-execution-lock.js";
import { createPluginHostRegistryRetirement } from "./host-hook-cleanup.js";
import { createPluginCache, retirePluginCache } from "./plugin-cache.js";
import { PluginInstance } from "./plugin-instance.js";
import { createOwnedInstance, throwing, trackCompletion } from "./plugin-instance.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getPluginLoaderCacheState } from "./registry-lifecycle.js";
import {
  clearActivePluginRegistry,
  disposePluginRegistryInstances,
  setActivePluginRegistry,
} from "./runtime.js";
import { setPluginRuntimeLoadContext } from "./runtime/load-context.js";
import { createToolLoadContext } from "./tools.test-support.js";

const extensions = (value: string) => ({ fixture: { value }, other: { value: "preserve" } });

describe("plugin retirement session-store ownership", () => {
  it("retires in-memory resources without preparing persistent config", () =>
    withOpenClawTestState({ label: "plugin-retirement-no-persistent-state" }, async () => {
      const registry = createEmptyPluginRegistry();
      const cleanup = vi.fn();
      registry.runtimeLifecycles.push({
        pluginId: "fixture",
        source: "fixture",
        lifecycle: { id: "fixture", cleanup },
      });
      clearRuntimeConfigSnapshot();
      const result = await createPluginHostRegistryRetirement({
        previousRegistry: registry,
        skipPersistentSessionState: true,
      })();
      expect(result.failures).toEqual([]);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(getRuntimeConfigSnapshot()).toBeNull();
    }));

  it.each(["replace", "direct", "clear-command", "explicit", "registry-context"] as const)(
    "keeps the retiring configuration across admitted work (%s)",
    (mode) =>
      withOpenClawTestState({ label: "plugin-retirement-config" }, async (state) => {
        const oldPath = state.path("old-custom", "sessions.json");
        const newPath = state.path("new-custom", "sessions.json");
        const cfg = { agents: { entries: { main: {} } }, session: { store: oldPath } };
        setRuntimeConfigSnapshot(cfg, cfg);
        const scope = (storePath: string) => ({
          agentId: "main",
          sessionKey: "agent:main:config-retirement",
          storePath,
        });
        for (const [storePath, value] of [
          [oldPath, "old"],
          [newPath, "successor"],
        ] as const) {
          await replaceSessionEntry(scope(storePath), {
            sessionId: "config-retirement",
            updatedAt: 1,
            pluginExtensions: extensions(value),
          });
        }
        const { registry, instance } = createOwnedInstance("fixture");
        if (mode === "registry-context") {
          setPluginRuntimeLoadContext(
            registry,
            createToolLoadContext(cfg, "", { workspaceDir: undefined }),
          );
          clearRuntimeConfigSnapshot();
        }
        setActivePluginRegistry(registry);
        const release = createDeferredCore();
        const call =
          mode === "clear-command"
            ? withPluginCommandExecution(registry, () => release.promise)
            : instance.run(() => release.promise);
        let retirement: Promise<unknown> | undefined;
        try {
          if (mode === "explicit" || mode === "direct") {
            retirement = createPluginHostRegistryRetirement({
              ...(mode === "explicit" ? { cfg } : {}),
              previousRegistry: registry,
            })();
          } else if (mode === "clear-command") {
            retirement = clearActivePluginRegistry();
          } else {
            const successor = createEmptyPluginRegistry();
            setActivePluginRegistry(successor);
            retirement = disposePluginRegistryInstances(registry, successor, {
              cleanupPersistentState: true,
            });
          }
          const completion = trackCompletion(retirement);
          retirement = completion.promise;
          await Promise.resolve();
          expect(completion.done).toBe(false);
          const next = { ...cfg, session: { store: newPath } };
          setRuntimeConfigSnapshot(next, next);
          release.resolve();
          await Promise.all([call, completion.promise]);
          expect(loadSessionEntry(scope(oldPath))?.pluginExtensions).toEqual({
            ...(mode === "clear-command" ? { fixture: { value: "old" } } : {}),
            other: { value: "preserve" },
          });
          expect(loadSessionEntry(scope(newPath))?.pluginExtensions).toEqual(
            extensions("successor"),
          );
        } finally {
          release.resolve();
          await Promise.allSettled([call, retirement]);
          await clearActivePluginRegistry();
        }
      }),
  );
});

it.each(["registry", "cache"] as const)(
  "returns best-effort cleanup rows from the %s owner without reviving callbacks",
  (kind) =>
    withOpenClawTestState({ label: "plugin-cleanup-outcome" }, async () => {
      const { registry, record, instance } = createOwnedInstance("cleanup-outcome");
      const hostFailure = new Error("synthetic cleanup failure");
      const disposeFailure = new Error("synthetic cleanup failure");
      const hostCleanup = vi.fn(throwing(hostFailure));
      const instanceCleanup = vi.fn(throwing(disposeFailure));
      const callback = instance.wrap(() => "live");
      instance.lifecycle.onDispose(instanceCleanup);
      for (const id of ["fixture", "sibling"]) {
        registry.runtimeLifecycles.push({
          pluginId: record.id,
          source: record.source,
          lifecycle: { id, cleanup: hostCleanup },
        });
      }
      const cache = createPluginCache();
      getPluginLoaderCacheState(cache).set("fixture", registry);
      const close = () =>
        kind === "cache" ? retirePluginCache(cache) : disposePluginRegistryInstances(registry);
      const result = await close();
      expect(result.failures).toEqual([
        { pluginId: record.id, hookId: "runtime:fixture", error: hostFailure },
        { pluginId: record.id, hookId: "runtime:sibling", error: hostFailure },
        { pluginId: record.id, hookId: "instance", error: disposeFailure },
      ]);
      expect(result.failures[0]?.error).toBe(hostFailure);
      expect(result.failures[1]?.error).toBe(hostFailure);
      expect(result.failures[2]?.error).toBe(disposeFailure);
      expect(await close()).toEqual(result);
      expect(hostCleanup).toHaveBeenCalledTimes(2);
      expect(instanceCleanup).toHaveBeenCalledOnce();
      expect(callback).toThrow("reloaded or disabled");
      const replacement = new PluginInstance(record.id);
      expect(replacement.run(() => "fresh")).toBe("fresh");
      await replacement.dispose();
      await retirePluginCache(cache);
    }),
);
