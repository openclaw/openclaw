import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import * as sqliteRuntime from "../plugin-sdk/sqlite-runtime.js";
import type { OpenClawPluginDefinition } from "../plugins/plugin-definition.types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createServiceRegistration } from "../plugins/services.test-support.js";
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
  createWriteReloaderHarness,
  flushReload,
  makeSnapshot,
  makeZeroDebounceHookWrite,
} from "./config-reload.test-support.js";

const pluginEntries = await Promise.all(
  ["workboard", "file-transfer"].map(async (pluginId) => {
    const surface = { pluginId, artifactBasename: "index.ts" };
    const { default: plugin } = await loadBundledPluginFacade<{
      default: OpenClawPluginDefinition;
    }>(surface);
    return { pluginId, plugin, runtimeSource: resolveBundledPluginPublicModulePath(surface) };
  }),
);

const { default: browser } = await loadBundledPluginFacade<{
  default: OpenClawPluginDefinition;
}>({
  pluginId: "browser",
  artifactBasename: "index.ts",
});

export function registerPluginServiceReloadTests() {
  const emptyRegistry = createTestRegistry([]);
  it("reloads the registered Browser service for control policy without restarting the Gateway", () => {
    if (!browser.register) {
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
        registerService(service) {
          registry.services.push(
            createServiceRegistration(service, { pluginId: "browser", origin: "bundled" }),
          );
        },
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
        expect(plan.restartGateway, path).toBe(false);
        expect(plan.restartServices, path).toEqual(new Set(["browser-control"]));
        expect(plan.reloadPlugins, path).toBe(false);
        expect(plan.restartChannels.size, path).toBe(0);
      }
      const profiles = buildGatewayReloadPlan(["browser.profiles.openclaw.headless"]);
      expect(profiles.restartGateway).toBe(false);
      expect(profiles.restartServices).toEqual(new Set());
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
            registerService(service) {
              serviceRegistry.services.push(
                createServiceRegistration(service, { pluginId, origin: "bundled" }),
              );
            },
            registerRuntimeLifecycle(lifecycle) {
              if (lifecycle.dispose) {
                disposals.push(lifecycle.dispose);
              }
            },
          }),
        );
      }
      storage.mockRestore();
      setActivePluginRegistry(serviceRegistry);
      vi.useFakeTimers();
      const initialConfig: OpenClawConfig = {
        agents: { entries: { roboclaw: { tools: { sandbox: { tools: {} } } } } },
      };
      const nextConfig = structuredClone(initialConfig);
      nextConfig.agents!.entries!.roboclaw!.tools!.sandbox!.tools!.alsoAllow = [
        "fixture_read",
        "fixture_write",
      ];
      const harness = createWriteReloaderHarness({ initialConfig });
      await harness.reloader.ready;
      harness.emitWrite({
        ...makeZeroDebounceHookWrite("sandbox-allowlist"),
        sourceConfig: nextConfig,
        runtimeConfig: nextConfig,
        snapshot: makeSnapshot({ config: nextConfig, hash: "sandbox-allowlist" }),
      });
      await flushReload(harness.reloader);
      expect(
        harness.onHotReload,
        JSON.stringify({
          errors: harness.log.error.mock.calls,
          warnings: harness.log.warn.mock.calls,
          info: harness.log.info.mock.calls,
          reload: harness.reloader.hotReloadStatus(),
        }),
      ).toHaveBeenCalledOnce();
      expect(harness.onHotReload.mock.calls[0]?.[0]).toMatchObject({
        changedPaths: ["agents.entries.roboclaw.tools.sandbox.tools.alsoAllow"],
        restartGateway: false,
        restartServices: new Set(),
        reloadPlugins: false,
      });
      expect(harness.onRestart).not.toHaveBeenCalled();
      await harness.reloader.stop();

      const sole: OpenClawConfig = { agents: { entries: { roboclaw: {} } } };
      const cases: Array<{
        previous?: OpenClawConfig;
        next: OpenClawConfig;
        reload: boolean;
        plugins?: boolean;
      }> = [
        { next: nextConfig, reload: false },
        {
          next: { agents: { entries: { roboclaw: { workspace: "/workspace/new" } } } },
          reload: true,
        },
        {
          next: { agents: { defaults: { workspace: "/workspace" }, ...sole.agents } },
          reload: true,
        },
        { next: { agents: { ownership: "explicit", ...sole.agents } }, reload: true },
        { previous: {}, next: { agents: { entries: {} } }, reload: true },
        { next: { agents: { entries: { roboclaw: {}, added: {} } } }, reload: true },
        {
          next: { agents: { entries: { roboclaw: {}, added: { decisionModel: "fixture/fast" } } } },
          reload: true,
          plugins: true,
        },
      ];
      for (const { previous: before = sole, next, reload, plugins = false } of cases) {
        for (const [previous, candidate] of [
          [before, next],
          [next, before],
        ] as const) {
          const plan = buildGatewayReloadPlan(
            diffGatewayReloadPaths(previous, candidate, listConfigReloadRefinementPrefixes()),
          );
          expect(plan.restartGateway).toBe(false);
          expect(plan.reloadPlugins).toBe(plugins);
          expect(plan.restartServices).toEqual(new Set(reload ? ["file-transfer-workspaces"] : []));
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
