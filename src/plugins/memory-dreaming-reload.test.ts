import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTestPluginServiceScheduler } from "../plugin-sdk/plugin-test-api.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createHookRunner } from "./hooks.js";
import {
  createLazyPluginRuntime,
  createPluginModuleLoader,
  runPluginRegisterSyncInRegistry,
} from "./loader-module-runtime.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import type { PluginInstance } from "./plugin-instance.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-helpers.js";
import type { OpenClawPluginDefinition } from "./types.js";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const memorySource = path.join(repository, "extensions/memory-core/index.ts");
const loadHost = createPluginModuleLoader({
  devSourceRoot: repository,
  pluginSdkResolution: "src",
});
const { createOpenClawTestState } = loadHost(
  path.join(repository, "src/test-utils/openclaw-test-state.ts"),
) as typeof import("../test-utils/openclaw-test-state.js");
const { MEMORY_DREAMING_SYSTEM_EVENT_TEXT } = loadHost(
  path.join(repository, "src/plugin-sdk/memory-core-host-status.ts"),
) as typeof import("../plugin-sdk/memory-core-host-status.js");

it("keeps successor sweeps and diary publication owned after another registration retires", async () => {
  const state = await createOpenClawTestState({ label: "memory-dreaming-reload" });
  const instances: PluginInstance[] = [];
  const stops: Array<() => Promise<void>> = [];
  const completion = createDeferredCore<{ text: string }>();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const config: OpenClawConfig = {
    agents: { entries: { main: { workspace: state.workspaceDir } } },
  };
  await state.writeConfig(config);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const load = () => {
    const subagent = {
      complete: vi.fn(() => completion.promise),
      run: vi.fn(async () => ({ runId: "unused" })),
      waitForRun: vi.fn(async () => ({ status: "ok" as const })),
      getSessionMessages: vi.fn(async () => ({ messages: [] })),
      deleteSession: vi.fn(async () => {}),
    } satisfies PluginRuntime["subagent"];
    const host = createPluginRegistry({
      logger,
      runtime: createLazyPluginRuntime({
        devSourceRoot: repository,
        pluginSdkResolution: "src",
        runtimeOptions: { subagent },
      }),
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({
      id: "memory-core",
      origin: "bundled",
      source: memorySource,
      rootDir: path.dirname(memorySource),
      kind: "memory",
      memorySlotSelected: true,
    });
    host.registry.plugins.push(record);
    const api = host.createApi(record, { config });
    const instance = getPluginInstance(record) as PluginInstance;
    instances.push(instance);
    bindPluginInstanceModuleLoader({
      instance,
      origin: "bundled",
      source: memorySource,
      rootDir: path.dirname(memorySource),
      devSourceRoot: repository,
      pluginSdkResolution: "src",
    });
    const module = instance.loadModule(memorySource) as { default: OpenClawPluginDefinition };
    assert(module.default.register);
    runPluginRegisterSyncInRegistry(module.default.register, api, host.registry, record.id);
    const runner = createHookRunner(host.registry);
    const service = host.registry.services.find(
      (entry) => entry.service.id === "memory-core-dreaming",
    )?.service;
    assert(service);
    const scheduler = createTestPluginServiceScheduler();
    const context = {
      config,
      stateDir: state.stateDir,
      logger,
      scheduler,
      getCron: () => ({
        list: async () => [],
        add: async () => ({}),
        update: async () => ({}),
        remove: async () => ({ removed: false }),
        removeStaleJobFamily: async () => 0,
      }),
    };
    const stop = async () => {
      await service.stop?.(context);
      await scheduler.stop();
    };
    stops.push(stop);
    return {
      instance,
      subagent,
      start: () => service.start(context),
      stop,
      sweep: () =>
        runner.runBeforeAgentReply(
          { cleanedBody: MEMORY_DREAMING_SYSTEM_EVENT_TEXT },
          { trigger: "cron", agentId: "main", workspaceDir: state.workspaceDir },
        ),
    };
  };
  try {
    const initial = load();
    await initial.start();
    await expect(initial.sweep()).resolves.toMatchObject({ handled: true });
    expect(logger.error.mock.calls).toEqual([]);
    await initial.stop();
    stops.pop();
    await expect(initial.instance.dispose()).resolves.toEqual({ errors: [] });
    const successor = load();
    await successor.start();
    const inspection = load();
    await inspection.stop();
    stops.pop();
    await expect(inspection.instance.dispose()).resolves.toEqual({ errors: [] });
    await expect(successor.sweep()).resolves.toMatchObject({ handled: true });
    expect(logger.error.mock.calls).toEqual([]);
    await fs.mkdir(path.join(state.workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(state.workspaceDir, "memory", `${new Date().toISOString().slice(0, 10)}.md`),
      "- The violet telescope belongs on the library roof.\n",
    );
    await expect(successor.sweep()).resolves.toMatchObject({ handled: true });
    expect(successor.subagent.complete).toHaveBeenCalled();
    expect(initial.subagent.complete).not.toHaveBeenCalled();
    expect(inspection.subagent.complete).not.toHaveBeenCalled();
    let stopped = false;
    const stopping = successor.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    completion.resolve({ text: "The violet telescope gathered constellations above the library." });
    await stopping;
    stops.pop();
    await expect(successor.instance.dispose()).resolves.toEqual({ errors: [] });
    expect(await fs.readFile(path.join(state.workspaceDir, "DREAMS.md"), "utf8")).toContain(
      "The violet telescope gathered constellations above the library.",
    );
    expect(logger.error.mock.calls).toEqual([]);
  } finally {
    completion.resolve({ text: "settled" });
    await Promise.all(stops.map((stop) => stop()));
    await Promise.all(instances.map((instance) => instance.dispose()));
    vi.useRealTimers();
    await state.cleanup();
  }
});
