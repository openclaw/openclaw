import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/config.js";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import * as sqliteRuntime from "../plugin-sdk/sqlite-runtime.js";
import { PluginHostCleanupTimeoutError } from "../plugins/host-hook-cleanup-timeout.js";
import { getPluginRuntimeGeneration, PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import type { OpenClawPluginDefinition } from "../plugins/plugin-definition.types.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import {
  createPluginRegistryOwner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createServiceRegistration } from "../plugins/services.test-support.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  loadBundledPluginFacade,
  resolveBundledPluginPublicModulePath,
} from "../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { diffGatewayReloadPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
} from "./config-reload-plan.js";
import {
  closeTestConfigReloaders,
  createReloaderHarness,
  createWriteReloaderHarness,
  flushReload,
  flushWatcherChange,
  makeSnapshot,
  makeWrite,
  makeZeroDebounceHookWrite,
} from "./config-reload.test-support.js";
import { PluginAdmittedWorkTimeoutError } from "./server-plugin-reload-cleanup.js";

const loadedPlugins = await Promise.all(
  ["browser", "workboard", "file-transfer"].map(async (pluginId) => {
    const surface = { pluginId, artifactBasename: "index.ts" };
    const { default: plugin } = await loadBundledPluginFacade<{
      default: OpenClawPluginDefinition;
    }>(surface);
    return { pluginId, plugin, runtimeSource: resolveBundledPluginPublicModulePath(surface) };
  }),
);
const browser = loadedPlugins[0]?.plugin;
const pluginEntries = loadedPlugins.slice(1);

export async function createReadyReloader(...args: Parameters<typeof createReloaderHarness>) {
  const harness = createReloaderHarness(...args);
  await harness.reloader.ready;
  return harness;
}

export function snapshotOf(config: OpenClawConfig, hash?: string) {
  return makeSnapshot({ config, ...(hash === undefined ? {} : { hash }) });
}

export function configWithReload<T extends OpenClawConfig>(config: T) {
  return { gateway: { reload: {} }, ...config };
}

export function expectCalls(count: number, ...callbacks: Array<{ mock: { calls: unknown[] } }>) {
  for (const callback of callbacks) {
    expect(callback).toHaveBeenCalledTimes(count);
  }
}

type Harness = ReturnType<typeof createReloaderHarness>;
function expectApplied(harness: Harness, count: number, config: OpenClawConfig) {
  expect(harness.onHotReload).toHaveBeenCalledTimes(count);
  expect(harness.onConfigApplied.mock.lastCall?.[1]).toEqual(config);
}

type PluginChange = Parameters<Harness["reloader"]["applyPluginLifecycleChange"]>[0];
export function applyPluginChange(
  harness: Harness,
  config: OpenClawConfig,
  options: Partial<Omit<PluginChange, "config">> = {},
) {
  return harness.reloader.applyPluginLifecycleChange({
    config,
    pluginIds: ["notes"],
    reason: "reload",
    ...options,
  });
}

function serviceRegistrar(registry: ReturnType<typeof createTestRegistry>, pluginId: string) {
  return (service: Parameters<typeof createServiceRegistration>[0]) => {
    registry.services.push(createServiceRegistration(service, { pluginId, origin: "bundled" }));
  };
}

function agentConfig(
  roboclaw: NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>[string] = {},
): OpenClawConfig {
  return { agents: { entries: { roboclaw } } };
}

export function registerPluginServiceReloadTests() {
  const emptyRegistry = createTestRegistry([]);
  it("reloads the registered Browser service for control policy without restarting the Gateway", () => {
    if (!browser?.register) {
      throw new Error("Browser plugin must expose its registration entry point");
    }
    const registry = createTestRegistry([]);
    browser.register(
      createTestPluginApi({
        runtime: {
          state: {
            openSyncKeyedStore: () => ({ entries: () => [] }),
            openKeyedStore: vi.fn(),
          },
        } as never,
        registerService: serviceRegistrar(registry, "browser"),
      }),
    );
    registry.reloads.push({
      pluginId: "browser",
      source: "test",
      registration: browser.reload ?? {},
    });
    setActivePluginRegistry(registry);
    try {
      for (const path of [
        "browser.enabled",
        "browser.evaluateEnabled",
        "browser.ssrfPolicy.allowedHostnames",
        "browser.extensionRelay.allowLegacyAuth",
      ]) {
        const plan = buildGatewayReloadPlan([path]);
        expect(plan, path).toMatchObject({
          restartGateway: false,
          restartServices: new Set(["browser-control"]),
          reloadPlugins: false,
          restartChannels: new Set(),
        });
      }
      const profiles = buildGatewayReloadPlan(["browser.profiles.openclaw.headless"]);
      expect(profiles).toMatchObject({ restartGateway: false, restartServices: new Set() });
    } finally {
      setActivePluginRegistry(emptyRegistry);
    }
  });

  it("keeps sandbox tool-policy writes hot with registered Workboard and node workspace services", async () => {
    const serviceRegistry = createTestRegistry([]);
    const disposals: Array<() => void | Promise<void>> = [];
    // Registration owns its storage admission, but this test exercises reload policy, not SQLite.
    const storage = vi
      .spyOn(sqliteRuntime, "openSqliteWorkerStore")
      .mockRejectedValue(new Error("Storage is unavailable in the registration-only fixture"));
    try {
      for (const { pluginId, plugin, runtimeSource } of pluginEntries) {
        if (!plugin.register) {
          throw new Error(`${pluginId} must expose its registration entry point`);
        }
        plugin.register(
          createTestPluginApi({
            id: pluginId,
            runtimeSource,
            registerService: serviceRegistrar(serviceRegistry, pluginId),
            registerRuntimeLifecycle({ dispose }) {
              if (dispose) {
                disposals.push(dispose);
              }
            },
          }),
        );
      }
      storage.mockRestore();
      setActivePluginRegistry(serviceRegistry);
      vi.useFakeTimers();
      const initialConfig = agentConfig({ tools: { sandbox: { tools: {} } } });
      const nextConfig = agentConfig({
        tools: { sandbox: { tools: { alsoAllow: ["fixture_read"] } } },
      });
      const harness = createWriteReloaderHarness({ initialConfig });
      await harness.reloader.ready;
      harness.emitWrite(makeWrite(nextConfig, "sandbox-allowlist"));
      await flushReload(harness.reloader);
      expect(harness.onHotReload).toHaveBeenCalledOnce();
      expect(harness.onHotReload.mock.calls[0]?.[0]).toMatchObject({
        changedPaths: ["agents.entries.roboclaw.tools.sandbox.tools.alsoAllow"],
        restartGateway: false,
        restartServices: new Set(),
        reloadPlugins: false,
      });
      expect(harness.onRestart).not.toHaveBeenCalled();

      const sole = agentConfig();
      const cases: Array<[OpenClawConfig, boolean, boolean?, OpenClawConfig?]> = [
        [nextConfig, false],
        [agentConfig({ workspace: "/workspace/new" }), true],
        [{ agents: { defaults: { workspace: "/workspace" }, ...sole.agents } }, true],
        [{ agents: { ownership: "explicit", ...sole.agents } }, true],
        [{ agents: { entries: {} } }, true, false, {}],
        [{ agents: { entries: { roboclaw: {}, added: {} } } }, true],
        [
          { agents: { entries: { roboclaw: {}, added: { decisionModel: "fixture/fast" } } } },
          true,
          true,
        ],
      ];
      for (const [next, reload, plugins = false, before = sole] of cases) {
        for (const [previous, candidate] of [
          [before, next],
          [next, before],
        ] as const) {
          const plan = buildGatewayReloadPlan(
            diffGatewayReloadPaths(previous, candidate, listConfigReloadRefinementPrefixes()),
          );
          expect(plan).toMatchObject({
            restartGateway: false,
            reloadPlugins: plugins,
            restartServices: new Set(reload ? ["file-transfer-workspaces"] : []),
          });
        }
      }
    } finally {
      storage.mockRestore();
      await closeTestConfigReloaders();
      vi.useRealTimers();
      resetPluginRuntimeStateForTest();
      await Promise.all(disposals.map(async (dispose) => await dispose()));
    }
  });
}

export function registerPluginDrainReloadTests(enableRealSkillsRefresh: () => void) {
  describe("plugin replacement", () => {
    beforeEach(enableRealSkillsRefresh);
    afterEach(async () => {
      await closeTestConfigReloaders();
      resetPluginRuntimeStateForTest();
    });

    const pluginConfig = <T extends NonNullable<OpenClawConfig["plugins"]>["entries"]>(
      entries: T,
    ) => ({ plugins: { entries } });
    const codexConfig = (sandbox: string): OpenClawConfig =>
      pluginConfig({ codex: { enabled: true, config: { sandbox } } });
    const codexRuntime = (operationId: string) => ({
      operationId,
      generation: getPluginRuntimeGeneration(),
      pluginIds: ["codex"],
    });
    const drainFailure = (operationId: string, cause?: Error) =>
      new PluginRuntimeApplicationError(
        "admitted work did not settle",
        { ...codexRuntime(operationId), phase: "drain", committed: false },
        { cause },
      );
    describe("plugin drain recovery", () => {
      it("hot-applies model settings without replacing the Codex generation", async () => {
        const initialConfig = pluginConfig({ codex: { enabled: true } });
        let config = initialConfig;
        const harness = await createReadyReloader(async () => snapshotOf(config), {
          initialConfig,
        });

        for (const update of [
          { agents: { defaults: { models: { "openai/gpt-5.6-sol": { alias: "primary" } } } } },
          { agents: { entries: { worker: { model: { primary: "openai/gpt-5.6-sol" } } } } },
          {
            models: {
              providers: { openai: { baseUrl: "https://api.openai.com/v1", models: [] } },
            },
          },
        ] satisfies OpenClawConfig[]) {
          config = { ...initialConfig, ...update };
          await flushWatcherChange(harness);
          expect(harness.onHotReload.mock.lastCall?.[0].reloadPlugins).toBe(false);
          expect(harness.onConfigApplied.mock.lastCall?.[1]).toEqual(config);
        }
        expect(harness.onHotReload).toHaveBeenCalledTimes(3);
        expect(harness.onRestart).not.toHaveBeenCalled();
      });

      it("retries deferred replacement after work and cleanup settle", async () => {
        const initialConfig: OpenClawConfig = {
          ...codexConfig("read-only"),
          agents: { entries: { main: {} } },
        };
        let config: OpenClawConfig = { ...initialConfig, ...codexConfig("workspace-write") };
        const builder = createTestPluginRegistry();
        const record = createPluginRecord({ id: "codex", source: "/synthetic/codex.ts" });
        builder.registry.plugins.push(record);
        builder.createApi(record, { config: {} });
        setActivePluginRegistry(builder.registry);
        const registryOwner = createPluginRegistryOwner(builder.registry);
        const instance = getPluginInstance(record);
        assert(instance);
        const releaseWork = instance.retainWork();
        const cleanup = createDeferredCore();
        let cleanupCall: Promise<void> | undefined;
        const harness = createReloaderHarness(async () => snapshotOf(config), {
          initialConfig,
          // Stands in for the reload owner's 60s pre-stop drain expiring on the held work.
          onHotReload: async (plan) => {
            if (plan.reloadPlugins && instance.retainedWorkCount > 0) {
              throw drainFailure(
                "failed-automatic-drain",
                new PluginAdmittedWorkTimeoutError(
                  new Set(["codex"]),
                  [instance],
                  new PluginHostCleanupTimeoutError("plugin codex admitted work"),
                  60_000,
                ),
              );
            }
            return plan.reloadPlugins
              ? { status: "applied", runtime: codexRuntime("codex-replacement") }
              : "applied";
          },
        });
        try {
          await harness.reloader.ready;
          await flushWatcherChange(harness);
          config = { ...config, agents: { entries: { main: { skills: [] } } } };
          await flushWatcherChange(harness);
          expect(harness.onHotReload).toHaveBeenCalledTimes(2);
          expectCalls(
            0,
            harness.onConfigApplied,
            harness.onConfigAccepted,
            harness.onConfigCandidateCommitted,
            harness.onConfigRevisionApplied,
          );

          // The pre-stop drain also joins cleanup calls, so the retry waits for them too.
          cleanupCall = instance.runCleanup(() => cleanup.promise);
          releaseWork();
          await flushReload(harness.reloader);
          expect(harness.onHotReload).toHaveBeenCalledTimes(2);

          cleanup.resolve();
          await cleanupCall;
          await flushReload(harness.reloader);
          expectApplied(harness, 3, config);
          expect(harness.onHotReload.mock.lastCall?.[0].reloadPlugins).toBe(true);
          expect(harness.log.error).toHaveBeenCalledTimes(2);
        } finally {
          await harness.reloader.stop();
          releaseWork();
          cleanup.resolve();
          await cleanupCall;
          await registryOwner.close();
        }
      });

      it.each(["explicit wait", "revert", "revert with model edit"] as const)(
        "recovers a failed automatic plugin drain through %s",
        async (recovery) => {
          const initialConfig = codexConfig("read-only");
          let config = codexConfig("workspace-write");
          const failure = drainFailure("failed-automatic-drain");
          const runtime = codexRuntime("explicit-wait-recovery");
          const harness = await createReadyReloader(async () => snapshotOf(config), {
            initialConfig,
            onHotReload: async (plan) => {
              if (plan.reloadPlugins && !plan.pluginLifecycle?.waitForDrain) {
                throw failure;
              }
              return plan.reloadPlugins ? { status: "applied", runtime } : "applied";
            },
          });
          await flushWatcherChange(harness);
          expectCalls(1, harness.onHotReload, harness.log.error);
          expect(harness.onConfigApplied).not.toHaveBeenCalled();

          if (recovery !== "explicit wait") {
            config = {
              ...initialConfig,
              ...(recovery === "revert with model edit"
                ? {
                    agents: {
                      defaults: { models: { "openai/gpt-5.6-sol": { alias: "primary" } } },
                    },
                  }
                : {}),
            };
            await flushWatcherChange(harness);
            expect(harness.onConfigAccepted.mock.lastCall?.[0]).toEqual(config);
            const attempts = harness.onHotReload.mock.calls.length;
            config = { ...config, ...codexConfig("new-settings") };
            await flushWatcherChange(harness);
            expect(harness.onHotReload).toHaveBeenCalledTimes(attempts + 1);
            expect(harness.log.error).toHaveBeenCalledTimes(2);
            return;
          }

          await expect(applyPluginChange(harness, config, { pluginIds: ["codex"] })).rejects.toBe(
            failure,
          );
          expect(harness.onHotReload).toHaveBeenCalledTimes(2);
          const drainSignal = new AbortController().signal;
          await expect(
            applyPluginChange(harness, config, {
              pluginIds: ["codex"],
              waitForDrain: true,
              drainSignal,
            }),
          ).resolves.toBe(runtime);
          expectApplied(harness, 3, config);
          expect(harness.onHotReload.mock.lastCall?.[0].pluginLifecycle).toMatchObject({
            waitForDrain: true,
            drainSignal,
          });

          config = { ...config, agents: { defaults: { model: "openai/gpt-5.6-sol" } } };
          await flushWatcherChange(harness);
          expectApplied(harness, 4, config);
          expect(harness.onHotReload.mock.lastCall?.[0].reloadPlugins).toBe(false);
        },
      );

      it.each([true, false])(
        "applies partial and complete plugin reverts with another plugin edit (%s)",
        async (existingEntries) => {
          const codex = {
            enabled: true,
            config: { sandbox: "read-only", appServer: { args: ["--original"] } },
          };
          const other = { enabled: true, config: { value: "original" } };
          const initialConfig = existingEntries ? pluginConfig({ codex, other }) : {};
          const pendingCodex = {
            ...codex,
            config: { sandbox: "workspace-write", appServer: { args: ["--replacement"] } },
          };
          let config: OpenClawConfig = pluginConfig({
            codex: pendingCodex,
            ...(existingEntries ? { other } : {}),
          });
          const harness = await createReadyReloader(async () => snapshotOf(config), {
            initialConfig,
          });
          harness.onHotReload.mockRejectedValueOnce(drainFailure("failed-codex-drain"));
          await flushWatcherChange(harness);
          expect(harness.onHotReload).toHaveBeenCalledOnce();

          const nextOther = { ...other, config: { value: "replacement" } };
          config = pluginConfig({
            codex: {
              ...pendingCodex,
              config: existingEntries
                ? { ...pendingCodex.config, sandbox: codex.config.sandbox }
                : { appServer: pendingCodex.config.appServer },
            },
            other: nextOther,
          });
          await flushWatcherChange(harness);
          expectApplied(harness, 2, config);
          expect(harness.onHotReload.mock.lastCall?.[0].reloadPlugins).toBe(true);
          expect(harness.onHotReload.mock.lastCall?.[0].changedPaths).toContain(
            existingEntries
              ? "plugins.entries.codex.config.appServer.args"
              : "plugins.entries.codex",
          );
          expectCalls(
            1,
            harness.onConfigApplied,
            harness.onConfigAccepted,
            harness.onConfigCandidateCommitted,
            harness.onConfigRevisionApplied,
          );
          expect(harness.onConfigAccepted.mock.lastCall?.[0]).toEqual(config);

          config = pluginConfig({ ...(existingEntries ? { codex } : {}), other: nextOther });
          await flushWatcherChange(harness);
          expectApplied(harness, 3, config);
          expect(harness.onHotReload.mock.lastCall?.[0].reloadPlugins).toBe(true);
          expect(harness.log.error).toHaveBeenCalledOnce();
        },
      );
    });

    describe("plugin observations", () => {
      const runtime = { operationId: "manual", generation: 1, pluginIds: ["notes"] };
      const failure = () =>
        new PluginRuntimeApplicationError("candidate activation failed", {
          ...runtime,
          phase: "activate",
          committed: false,
        });

      it.each(["none", "file-before", "file-during", "write-during"] as const)(
        "retains real work after manual failure: %s",
        async (event) => {
          const config: OpenClawConfig = {};
          const write = makeZeroDebounceHookWrite("next");
          let snapshot = snapshotOf(config, "initial");
          const entered = createDeferred();
          const release = createDeferred();
          const error = failure();
          let reject = false;
          const harness = await createReadyReloader(async () => snapshot, {
            initialConfig: config,
            onHotReload: async (plan) => {
              if (plan.pluginLifecycle && reject) {
                entered.resolve();
                await release.promise;
                throw error;
              }
              return plan.pluginLifecycle ? { status: "applied", runtime } : "applied";
            },
          });
          const reload = (sourceConfig = config) =>
            withPluginLifecycleLease({}, () => applyPluginChange(harness, sourceConfig));
          await expect(reload()).resolves.toEqual(runtime);
          harness.onConfigAccepted.mockClear();
          if (event === "file-before") {
            snapshot = write.snapshot;
            harness.watcher.emit("change");
          }
          reject = true;
          const result = reload(snapshot.sourceConfig).catch((caught: unknown) => caught);
          try {
            await entered.promise;
            if (event === "file-during" || event === "write-during") {
              snapshot = write.snapshot;
              if (event === "write-during") {
                harness.emitWrite(write);
              } else {
                harness.watcher.emit("change");
              }
              await vi.advanceTimersByTimeAsync(0);
            }
            release.resolve();
            expect(await result).toBe(error);
            await flushReload(harness.reloader);
            expect(harness.onConfigAccepted).toHaveBeenCalledTimes(event === "none" ? 0 : 1);
            if (event !== "none") {
              expect(harness.onConfigAccepted.mock.calls[0]?.[2]).toEqual(write.sourceConfig);
            }
            // A later genuine observation remains admissible after either outcome.
            harness.onConfigAccepted.mockClear();
            harness.watcher.emit("change");
            await flushReload(harness.reloader);
            expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
          } finally {
            release.resolve();
            await result;
          }
        },
      );

      it.each(["resolve", "reject"] as const)(
        "discards stale reads after manual failure: %s",
        async (outcome) => {
          const initialRead = createDeferred<ConfigFileSnapshot>();
          const config: OpenClawConfig = {};
          const snapshot = snapshotOf(config, "same");
          const readSnapshot = vi
            .fn<() => Promise<ConfigFileSnapshot>>()
            .mockImplementationOnce(() => initialRead.promise)
            .mockResolvedValue(snapshot);
          const error = failure();
          const harness = await createReadyReloader(readSnapshot, {
            initialConfig: config,
            onHotReload: async () => {
              throw error;
            },
          });
          harness.watcher.emit("ready");
          await expect(
            withPluginLifecycleLease({}, () => applyPluginChange(harness, config)),
          ).rejects.toBe(error);
          if (outcome === "reject") {
            initialRead.reject(new Error("old read failed"));
          } else {
            initialRead.resolve(makeSnapshot({ exists: false, valid: false }));
          }
          await flushReload(harness.reloader);
          expect(readSnapshot).toHaveBeenCalledTimes(2);
          expect(harness.onConfigAccepted).not.toHaveBeenCalled();
        },
      );
    });
  });
}
