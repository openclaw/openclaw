import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginLoadOptions } from "./loader-types.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import type { PluginRegistry } from "./registry-types.js";
import { disposePluginRegistryInstances } from "./runtime.js";
import { getPluginRuntimeLoadContext } from "./runtime/load-context.js";

const registries: PluginRegistry[] = [];
afterEach(async () => {
  for (const registry of registries.splice(0).toReversed()) {
    await disposePluginRegistryInstances(registry);
  }
  resetPluginLoaderTestStateForTest();
});

it.each(["manifest", "config", "install record", "entry policy"] as const)(
  "retains callable registrations when only %s object key ordering changes",
  async (input) => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "semantic-retention",
      configSchema: { type: "object" },
      body: `module.exports = { id: 'semantic-retention', register(api) {
        api.registerGatewayMethod('semantic-retention.probe', ({respond}) => respond(true, 'available'));
      } };`,
    });
    const policy = { enabled: true, hooks: { allowPromptInjection: false } };
    const settings = { outer: { first: "one", second: "two" }, order: ["one", "two"] };
    const install = { source: "path" as const, sourcePath: plugin.dir, installPath: plugin.dir };
    const options: PluginLoadOptions = {
      config: {
        plugins: {
          allow: [plugin.id],
          load: { paths: [plugin.file] },
          slots: { memory: "none" },
          entries: { [plugin.id]: { ...policy, config: settings } },
        },
      },
      installRecords: { [plugin.id]: install },
      activate: false,
      runtimeSideEffects: true,
      cache: false,
      throwOnLoadError: true,
    };
    const initial = loadOpenClawPlugins(options);
    registries.push(initial);
    const manifestRegistry = getPluginRuntimeLoadContext(initial)?.manifestRegistry;
    assert(manifestRegistry);
    const reordered: PluginLoadOptions = {
      ...options,
      previousRegistry: initial,
      manifestRegistry: {
        ...manifestRegistry,
        plugins: manifestRegistry.plugins.map((record) => {
          if (input !== "manifest") {
            return record;
          }
          const { id, source, ...metadata } = record;
          return { ...metadata, source, id };
        }),
      },
      ...(input === "install record"
        ? {
            installRecords: {
              [plugin.id]: { installPath: plugin.dir, sourcePath: plugin.dir, source: "path" },
            },
          }
        : {}),
      config: {
        ...options.config,
        plugins: {
          ...options.config?.plugins,
          entries: {
            [plugin.id]: {
              ...(input === "entry policy" ? { hooks: policy.hooks, enabled: true } : policy),
              config:
                input === "config"
                  ? { order: settings.order, outer: { second: "two", first: "one" } }
                  : settings,
            },
          },
        },
      },
    };
    // Gateway replacement first plans without modules, then registers the candidate.
    for (const loadModules of [false, true]) {
      const next = loadOpenClawPlugins({ ...reordered, loadModules });
      registries.push(next);
      expect(next.plugins[0]).toBe(initial.plugins[0]);
      const handler = next.gatewayHandlers["semantic-retention.probe"];
      assert(handler);
      expect(handler).toBe(initial.gatewayHandlers["semantic-retention.probe"]);
      const respond = vi.fn();
      await handler({
        req: { type: "req", id: "semantic-retention", method: "semantic-retention.probe" },
        params: {},
        client: null,
        isWebchatConnect: () => false,
        respond,
        context: {} as Parameters<typeof handler>[0]["context"],
      });
      expect(respond).toHaveBeenCalledWith(true, "available", undefined, undefined);
    }
    // An ordered setting or real manifest value still invalidates registration.
    const changed = loadOpenClawPlugins({
      ...reordered,
      loadModules: false,
      ...(input === "manifest"
        ? {
            manifestRegistry: {
              ...manifestRegistry,
              plugins: manifestRegistry.plugins.map((record) =>
                Object.assign({}, record, { description: "changed description" }),
              ),
            },
          }
        : {
            config: {
              ...reordered.config,
              plugins: {
                ...reordered.config?.plugins,
                entries: {
                  [plugin.id]: { ...policy, config: { ...settings, order: ["two", "one"] } },
                },
              },
            },
          }),
    });
    registries.push(changed);
    expect(changed.plugins[0]).not.toBe(initial.plugins[0]);
    const forced = loadOpenClawPlugins({
      ...reordered,
      loadModules: false,
      replacePluginIds: [plugin.id],
    });
    registries.push(forced);
    expect(forced.plugins[0]).not.toBe(initial.plugins[0]);
  },
);
