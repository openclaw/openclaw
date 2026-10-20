import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginModuleLoader } from "./loader-module-runtime.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import * as preparation from "./plugin-generation-worker.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { PluginRegistryInspectionResources } from "./registry-inspection-resources.js";
import type { PluginRecord } from "./registry-types.js";
import { bindPluginRuntimeLoadContextState } from "./runtime/load-context-state.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const evaluations = Symbol.for("openclaw.test.mainInspectionEvaluations");

type FixtureModule = { evaluation: number; read(): Promise<{ value: string }> };

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, evaluations);
});

// Agents without an explicit workspace resolve below the Gateway's plugin workspace, so
// cold effective-tool inventories cannot borrow the Gateway registry. Each inspection
// then loads installed plugins in its own uncached registry and plugin cache.
it("evaluates an unchanged installed native ESM entry once per main-thread inspection workspace", async () => {
  expect(isMainThread).toBe(true);
  const rootDir = temp.make("plugin-main-inspection-");
  fs.writeFileSync(path.join(rootDir, "package.json"), '{"type":"module"}');
  const source = path.join(rootDir, "index.mjs");
  fs.writeFileSync(
    source,
    [
      `const key = Symbol.for("openclaw.test.mainInspectionEvaluations");`,
      "globalThis[key] = (globalThis[key] ?? 0) + 1;",
      "export const evaluation = globalThis[key];",
      'export const read = () => import("./side.mjs");',
    ].join("\n"),
  );
  fs.writeFileSync(path.join(rootDir, "side.mjs"), 'export const value = "side";');
  const prepare = vi.spyOn(preparation, "preparePluginGenerationArtifact");

  const open: Array<() => Promise<void>> = [];
  const inspect = async (params: {
    workspaceDir: string;
    origin?: PluginRecord["origin"];
    inspection?: boolean;
  }) => {
    const cache = createPluginCache();
    const registry = createEmptyPluginRegistry();
    bindPluginRuntimeLoadContextState(registry, {
      workspaceDir: params.workspaceDir,
      activationInputFingerprint: "fixture",
      controlPlaneFingerprint: "fixture",
      registrationConfigKey: "fixture",
      declaredProviderOwners: new Map(),
      rawConfig: {},
    });
    if (params.inspection !== false) {
      new PluginRegistryInspectionResources(async () => {}).attach(registry);
    }
    const record = createPluginRecord({
      id: "main-inspection-fixture",
      source,
      rootDir,
      origin: params.origin ?? "global",
      enabled: true,
      configSchema: false,
    });
    const owner = { record, rootDir, registry };
    const loaded = await withPluginCache(cache, async () => {
      const load = createPluginModuleLoader({});
      await load.prepare(source, owner);
      // SAFETY: The fixture entry above exports exactly this shape.
      return load(source, owner) as FixtureModule;
    });
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        await getPluginInstance(record)?.dispose();
        await retirePluginCache(cache);
      })());
    open.push(close);
    return { loaded, close };
  };

  await withPluginSourceCaptureStorage(
    { stateDir: temp.make("plugin-main-inspection-state-"), placement: "state" },
    async () => {
      try {
        const first = await inspect({ workspaceDir: "/workspace/main" });
        expect(first.loaded.evaluation).toBe(1);
        expect(prepare).toHaveBeenCalledTimes(1);
        await first.close();

        // A later cold inspection of the unchanged install reuses the retained graph
        // without acquiring another capture, including lazy imports after the first
        // inspection's cache retired.
        const second = await inspect({ workspaceDir: "/workspace/main" });
        expect(second.loaded.evaluation).toBe(1);
        expect(prepare).toHaveBeenCalledTimes(1);
        await expect(second.loaded.read()).resolves.toMatchObject({ value: "side" });
        const overlapping = await inspect({ workspaceDir: "/workspace/main" });
        expect(overlapping.loaded.evaluation).toBe(1);

        // Workspaces stay isolated.
        const otherWorkspace = await inspect({ workspaceDir: "/workspace/research" });
        expect(otherWorkspace.loaded.evaluation).toBe(2);

        // Live registries and local-path plugins keep their own evaluation.
        const live = await inspect({ workspaceDir: "/workspace/main", inspection: false });
        expect(live.loaded.evaluation).toBe(3);
        const configPath = await inspect({ workspaceDir: "/workspace/main", origin: "config" });
        expect(configPath.loaded.evaluation).toBe(4);

        // Concurrent first inspections of a workspace both acquire; the later one
        // discards its capture and joins the retained graph.
        const prepared = prepare.mock.calls.length;
        const [left, right] = await Promise.all([
          inspect({ workspaceDir: "/workspace/concurrent" }),
          inspect({ workspaceDir: "/workspace/concurrent" }),
        ]);
        expect(prepare).toHaveBeenCalledTimes(prepared + 2);
        expect([left.loaded.evaluation, right.loaded.evaluation]).toEqual([5, 5]);
        await left.close();
        await expect(right.loaded.read()).resolves.toMatchObject({ value: "side" });
      } finally {
        for (const close of open.toReversed()) {
          await close();
        }
      }
    },
  );
}, 120_000);
