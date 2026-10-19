import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  callFixtureGatewayMethod,
  disposeLoaderFixtures,
  writeFixtureJson,
} from "./loader-fixture-builders.test-support.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import type { PluginRegistry } from "./registry-types.js";
import { getPluginRuntimeLoadContext } from "./runtime/load-context.js";

const registries: PluginRegistry[] = [];
const caches: ReturnType<typeof createPluginCache>[] = [];
afterEach(async () => {
  await disposeLoaderFixtures(registries, caches);
  resetPluginLoaderTestStateForTest();
});

it.each(["manifest", "config"] as const)(
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
    const configWith = (config: typeof settings) => ({
      plugins: {
        allow: [plugin.id],
        load: { paths: [plugin.file] },
        slots: { memory: "none" },
        entries: { [plugin.id]: { ...policy, config } },
      },
    });
    const install = { source: "path" as const, sourcePath: plugin.dir, installPath: plugin.dir };
    const options: PluginLoadOptions = {
      config: configWith(settings),
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
      config: configWith(
        input === "config"
          ? { order: settings.order, outer: { second: "two", first: "one" } }
          : settings,
      ),
    };
    // Gateway replacement first plans without modules, then registers the candidate.
    for (const loadModules of [false, true]) {
      const next = loadOpenClawPlugins({ ...reordered, loadModules });
      registries.push(next);
      expect(next.plugins[0]).toBe(initial.plugins[0]);
      const handler = next.gatewayHandlers["semantic-retention.probe"];
      assert(handler);
      expect(handler).toBe(initial.gatewayHandlers["semantic-retention.probe"]);
      const respond = await callFixtureGatewayMethod(handler, "semantic-retention.probe");
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
            config: configWith({ ...settings, order: ["two", "one"] }),
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

it("retains an untracked plugin across Control UI rebuilds, not declaration changes, without duplicate warnings", () => {
  useNoBundledPlugins();
  const plugin = writePlugin({
    id: "ui-retention",
    registration: `api.registerGatewayMethod('ui-retention.probe', ({respond}) => respond(true, 'available'));`,
  });
  const writeManifest = (
    build: string | undefined,
    configSchema: Record<string, unknown> = { type: "object" },
  ) => {
    const assetDir = `dist/control-ui/${build}`;
    if (build) {
      fs.mkdirSync(path.join(plugin.dir, assetDir), { recursive: true });
      fs.writeFileSync(path.join(plugin.dir, assetDir, "index.js"), "export {};\n");
      fs.writeFileSync(path.join(plugin.dir, assetDir, "index.css"), ":root { color: blue; }\n");
    }
    writeFixtureJson(plugin.dir, "openclaw.plugin.json", {
      id: plugin.id,
      configSchema,
      ...(build
        ? { controlUi: { entry: `${assetDir}/index.js`, styles: [`${assetDir}/index.css`] } }
        : {}),
    });
  };
  const load = (loadModules = true, previousRegistry = registries.at(-1)) => {
    // Each reload reads fresh disk metadata, as the Gateway's plugin operation does.
    const cache = createPluginCache();
    caches.push(cache);
    const registry = withPluginCache(cache, () =>
      loadOpenClawPlugins({
        config: {
          plugins: {
            load: { paths: [plugin.file] },
            slots: { memory: "none" },
            entries: { [plugin.id]: { enabled: true } },
          },
        },
        installRecords: {},
        previousRegistry,
        activate: false,
        runtimeSideEffects: true,
        cache: false,
        throwOnLoadError: true,
        loadModules,
      }),
    );
    registries.push(registry);
    expect
      .soft(
        registry.diagnostics.filter(
          (entry) =>
            entry.pluginId === plugin.id &&
            entry.message.startsWith("OpenClaw can't verify where this plugin came from."),
        ),
      )
      .toHaveLength(1);
    return registry;
  };
  writeManifest("build-a");
  const initial = load();
  const record = initial.plugins.find((entry) => entry.id === plugin.id);
  const handler = initial.gatewayHandlers["ui-retention.probe"];
  assert(record && handler);
  writeManifest("build-b");
  // Gateway replacement plans without modules, then registers against the same published registry.
  for (const loadModules of [false, true]) {
    const next = load(loadModules, initial);
    expect.soft(next.plugins.find((entry) => entry.id === plugin.id)).toBe(record);
    expect.soft(next.gatewayHandlers["ui-retention.probe"]).toBe(handler);
  }
  // Declaration presence decides whether the browser catalog serves the record at all.
  let current = record;
  for (const build of [undefined, "build-c"]) {
    writeManifest(build);
    const next = load();
    const replaced = next.plugins.find((entry) => entry.id === plugin.id);
    expect(replaced).not.toBe(current);
    expect(replaced?.controlUi?.entry).toBe(build && `dist/control-ui/${build}/index.js`);
    assert(replaced);
    current = replaced;
  }
  writeManifest("build-c", { type: "object", properties: { label: { type: "string" } } });
  const changed = load();
  expect(changed.plugins.find((entry) => entry.id === plugin.id)).not.toBe(current);
});
