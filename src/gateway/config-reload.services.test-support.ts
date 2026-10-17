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
  makeWrite,
} from "./config-reload.test-support.js";

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
