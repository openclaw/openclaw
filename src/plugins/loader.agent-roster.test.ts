import { afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { diffGatewayReloadPaths } from "../gateway/config-diff.js";
import {
  buildGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
} from "../gateway/config-reload-plan.js";
import { activatePluginRegistry } from "./loader-shared.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import type { PluginRegistry } from "./registry-types.js";
import { disposePluginRegistryInstances } from "./runtime.js";

const registries: PluginRegistry[] = [];
afterEach(async () => {
  for (const registry of registries.splice(0).toReversed()) {
    await disposePluginRegistryInstances(registry);
  }
  resetPluginLoaderTestStateForTest();
});

it.each(["remove", "rename", "correct"] as const)(
  "revalidates unchanged plugin settings after roster %s through reload, cache and retention",
  (change) => {
    useNoBundledPlugins();
    // A plugin-owned roster invariant, without teaching core its settings schema.
    const plugin = writePlugin({
      id: "roster-policy",
      configSchema: { type: "object" },
      body: `module.exports = { id: 'roster-policy', register(api) {
        for (const id of Object.keys(api.pluginConfig.agents)) {
          if (!Object.hasOwn(api.config.agents.entries, id)) {
            throw new Error('unknown agent ID "' + id + '"');
          }
        }
        api.registerGatewayMethod('roster-policy.probe', ({respond}) => respond(true, 'available'));
      } };`,
    });
    const plugins = {
      allow: [plugin.id],
      load: { paths: [plugin.file] },
      slots: { memory: "none" },
      entries: { [plugin.id]: { enabled: true, config: { agents: { analyst: {} } } } },
    };
    const before: OpenClawConfig = {
      plugins,
      agents: { entries: change === "correct" ? { main: {} } : { main: {}, analyst: {} } },
    };
    const after: OpenClawConfig = {
      plugins,
      agents: {
        entries:
          change === "correct"
            ? { main: {}, analyst: {} }
            : change === "rename"
              ? { main: {}, renamed: {} }
              : { main: {} },
      },
    };
    const load = (config: OpenClawConfig, extra = {}) => {
      const registry = loadOpenClawPlugins({
        config,
        activate: false,
        runtimeSideEffects: true,
        ...extra,
      });
      registries.push(registry);
      return registry;
    };
    const initial = load(before);
    const status = (registry: PluginRegistry) =>
      registry.plugins.find((record) => record.id === plugin.id)?.status;
    expect(status(initial)).toBe(change === "correct" ? "error" : "loaded");
    if (change !== "correct") {
      // Only active, successful records can lend. Prove borrowing before invalidating it.
      activatePluginRegistry(initial, null, "default");
      const unchanged = load(before, { borrowRegistry: initial, runtimeSideEffects: false });
      expect(unchanged.plugins.find((record) => record.id === plugin.id)).toBe(
        initial.plugins.find((record) => record.id === plugin.id),
      );
    }
    const paths = diffGatewayReloadPaths(before, after, listConfigReloadRefinementPrefixes());
    const plan = buildGatewayReloadPlan(paths, { previousConfig: before, candidateConfig: after });
    expect.soft(plan.reloadPlugins).toBe(true);
    expect.soft(plan.restartGateway).toBe(false);
    const fresh = load(after, { cache: false });
    const cached = load(after);
    const retained = load(after, { previousRegistry: initial });
    const replacements = [fresh, cached, retained];
    if (change !== "correct") {
      replacements.push(load(after, { borrowRegistry: initial, runtimeSideEffects: false }));
    }
    const expected = change === "correct" ? "loaded" : "error";
    for (const registry of replacements) {
      expect.soft(status(registry)).toBe(expected);
      if (expected === "error") {
        expect
          .soft(registry.plugins.find((record) => record.id === plugin.id)?.error)
          .toContain('unknown agent ID "analyst"');
        expect.soft(registry.gatewayHandlers["roster-policy.probe"]).toBeUndefined();
      }
    }
  },
);

it("keeps ordinary agent setting edits out of plugin reloads", () => {
  const before: OpenClawConfig = {
    agents: { entries: { analyst: { utilityModel: "fixture/small" } } },
  };
  const after: OpenClawConfig = {
    agents: { entries: { analyst: { utilityModel: "fixture/large" } } },
  };
  const paths = diffGatewayReloadPaths(before, after, listConfigReloadRefinementPrefixes());
  expect(
    buildGatewayReloadPlan(paths, { previousConfig: before, candidateConfig: after }).reloadPlugins,
  ).toBe(false);
});
