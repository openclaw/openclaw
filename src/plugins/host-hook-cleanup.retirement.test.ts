import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withPluginCommandExecution } from "./command-execution-lock.js";
import { createPluginHostRegistryRetirement } from "./host-hook-cleanup.js";
import { createPluginCache, retirePluginCache } from "./plugin-cache.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getPluginLoaderCacheState } from "./registry-lifecycle.js";
import {
  clearActivePluginRegistry,
  disposePluginRegistryInstances,
  setActivePluginRegistry,
} from "./runtime.js";
import { createPluginRecord } from "./status.test-helpers.js";

describe("plugin retirement session-store ownership", () => {
  it.each(["stable", "replace", "direct", "clear-command", "explicit"] as const)(
    "keeps the retiring configuration across admitted work (%s)",
    async (mode) => {
      await withOpenClawTestState({ label: "plugin-retirement-config" }, async (state) => {
        const oldPath = state.path("old-custom", "sessions.json");
        const newPath = state.path("new-custom", "sessions.json");
        const cfg: OpenClawConfig = {
          agents: { list: [{ id: "main", default: true }] },
          session: { store: oldPath },
        };
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
            pluginExtensions: { fixture: { value }, other: { value: "preserve" } },
          });
        }
        const registry = createEmptyPluginRegistry();
        const record = createPluginRecord({ id: "fixture" });
        registry.plugins.push(record);
        const instance = new PluginInstance(record.id, { record, registry });
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
          let finished = false;
          retirement = retirement.then(() => {
            finished = true;
          });
          await Promise.resolve();
          expect(finished).toBe(false);
          if (mode !== "stable") {
            const next = { ...cfg, session: { store: newPath } };
            setRuntimeConfigSnapshot(next, next);
          }
          release.resolve();
          await Promise.all([call, retirement]);
          expect(loadSessionEntry(scope(oldPath))?.pluginExtensions).toEqual({
            other: { value: "preserve" },
          });
          expect(loadSessionEntry(scope(newPath))?.pluginExtensions).toEqual({
            fixture: { value: "successor" },
            other: { value: "preserve" },
          });
        } finally {
          release.resolve();
          await Promise.allSettled([call, retirement]);
          await clearActivePluginRegistry();
        }
      });
    },
  );
});

it.each(["registry", "cache"] as const)(
  "returns best-effort cleanup rows from the %s owner without reviving callbacks",
  async (kind) => {
    await withOpenClawTestState({ label: "plugin-cleanup-outcome" }, async () => {
      const registry = createEmptyPluginRegistry();
      const record = createPluginRecord({ id: "cleanup-outcome" });
      registry.plugins.push(record);
      const instance = new PluginInstance(record.id, { record, registry });
      const hostFailure = new Error("synthetic host cleanup failure");
      const disposeFailure = new Error("synthetic instance cleanup failure");
      const hostCleanup = vi.fn(() => {
        throw hostFailure;
      });
      const instanceCleanup = vi.fn(() => {
        throw disposeFailure;
      });
      const callback = instance.wrap(() => "live");
      instance.lifecycle.onDispose(instanceCleanup);
      registry.runtimeLifecycles.push({
        pluginId: record.id,
        source: record.source,
        lifecycle: { id: "fixture", cleanup: hostCleanup },
      });
      const cache = createPluginCache();
      getPluginLoaderCacheState(cache).set("fixture", registry);
      const close = () =>
        kind === "cache" ? retirePluginCache(cache) : disposePluginRegistryInstances(registry);
      const result = await close();
      expect(result.failures).toEqual([
        { pluginId: record.id, hookId: "runtime:fixture", error: hostFailure },
        { pluginId: record.id, hookId: "instance", error: disposeFailure },
      ]);
      expect(await close()).toEqual(result);
      expect(hostCleanup).toHaveBeenCalledOnce();
      expect(instanceCleanup).toHaveBeenCalledOnce();
      expect(callback).toThrow("reloaded or disabled");
      const replacement = new PluginInstance(record.id);
      expect(replacement.run(() => "fresh")).toBe("fresh");
      await replacement.dispose();
      await retirePluginCache(cache);
    });
  },
);
