import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it, onTestFinished } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { drainSystemEvents } from "../infra/system-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { activatePluginRegistry } from "./loader-shared.js";
import { loadOpenClawPluginCliRegistry, loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
  writePluginMetadata,
} from "./loader.test-fixtures.js";
import { withPluginRegistryPreparationScope } from "./registry-lifecycle.js";
import { createEmptyPluginRegistry } from "./registry.js";
import {
  disposePluginRegistryInstances,
  getActivePluginRegistry,
  setActivePluginRegistry,
} from "./runtime.js";
import { startPluginServices } from "./services.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

it.each(["runtime", "cli"] as const)(
  "keeps effective enablement separate from reason-only activation (%s)",
  async (surface) => {
    const imported = path.join(makePluginLoaderTempDir(), "imported");
    const plugin = writePlugin({
      id: "admission-contract",
      filename: "index.cjs",
      body: `require("node:fs").writeFileSync(${JSON.stringify(imported)}, "imported");
module.exports = { id: "admission-contract", register() {} };`,
    });
    const config: OpenClawConfig = {
      plugins: { enabled: true, slots: { memory: "none" } },
    };
    const options = {
      config,
      manifestRegistry: {
        plugins: [
          {
            id: plugin.id,
            origin: "bundled" as const,
            rootDir: plugin.dir,
            source: plugin.file,
            manifestPath: path.join(plugin.dir, "openclaw.plugin.json"),
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            configSchema: EMPTY_PLUGIN_SCHEMA,
          },
        ],
        diagnostics: [],
      },
      installRecords: {},
      onlyPluginIds: [plugin.id],
      activate: false,
      cache: false,
      autoEnabledReasons: { [plugin.id]: ["reason without effective enablement"] },
    };
    const registry =
      surface === "runtime"
        ? loadOpenClawPlugins(options)
        : await loadOpenClawPluginCliRegistry(options);
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0]).toMatchObject({
      id: plugin.id,
      enabled: false,
      activated: false,
      status: "disabled",
      activationSource: "disabled",
      activationReason: "bundled (disabled by default)",
      error: "bundled (disabled by default)",
    });
    expect(registry.cliRegistrars).toHaveLength(0);
    expect(fs.existsSync(imported)).toBe(false);
  },
);

it.each([false, true])("keeps scoped forced setup selection with setupEntry=%s", (setupEntry) => {
  useNoBundledPlugins();
  const markers = makePluginLoaderTempDir();
  const fullMarker = path.join(markers, "full-imported");
  const setupMarker = path.join(markers, "setup-imported");
  const channelSource = `const channel = {
  id: "admission-channel",
  meta: { id: "admission-channel", label: "Admission Channel" },
  capabilities: { chatTypes: ["direct"] },
  config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
};`;
  const plugin = writePlugin({
    id: "admission-setup",
    filename: "index.cjs",
    body: `require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "imported");
${channelSource}
module.exports = { id: "admission-setup", register(api) { api.registerChannel({ plugin: channel }); } };`,
  });
  if (setupEntry) {
    writePlugin({
      id: plugin.id,
      dir: plugin.dir,
      filename: "setup.cjs",
      body: `require("node:fs").writeFileSync(${JSON.stringify(setupMarker)}, "imported");
${channelSource}
module.exports = { plugin: channel };`,
    });
  }
  writePluginMetadata({
    dir: plugin.dir,
    id: plugin.id,
    channels: ["admission-channel"],
    packageJson: {
      name: "@example/admission-setup",
      version: "1.0.0",
      openclaw: {
        extensions: ["./index.cjs"],
        ...(setupEntry ? { setupEntry: "./setup.cjs" } : {}),
      },
    },
  });
  const registry = loadOpenClawPlugins({
    config: { plugins: { allow: [plugin.id], load: { paths: [plugin.dir] } } },
    onlyPluginIds: [plugin.id],
    includeSetupOnlyChannelPlugins: true,
    forceSetupOnlyChannelPlugins: true,
    activate: false,
    cache: false,
  });
  expect(registry.plugins.map(({ id, status }) => ({ id, status }))).toEqual([
    { id: plugin.id, status: "loaded" },
  ]);
  expect(registry.channelSetups.map(({ plugin: channel }) => channel.id)).toEqual([
    "admission-channel",
  ]);
  expect(registry.channels).toHaveLength(0);
  expect(fs.existsSync(setupMarker)).toBe(setupEntry);
  expect(fs.existsSync(fullMarker)).toBe(!setupEntry);
});

it.each(["root", "scoped", "replacement"] as const)(
  "keeps system routing bound to the %s lifecycle owner",
  async (mode) => {
    useNoBundledPlugins();
    const sessionKey = `preparation-${mode}`;
    const event = `plugin-preparation-${mode}`;
    const late = createDeferredCore<Array<{ phase: string; ok: boolean }>>();
    const receive = (observed: Array<{ phase: string; ok: boolean }>) => late.resolve(observed);
    process.once(event, receive);
    onTestFinished(() => {
      process.off(event, receive);
      drainSystemEvents(sessionKey);
    });
    const plugin = writePlugin({
      id: "preparation-probe",
      body: `module.exports = { id: "preparation-probe", register(api) {
        const observed = [];
        const route = (phase) => {
          try {
            api.runtime.system.enqueueSystemEvent(phase, { sessionKey: ${JSON.stringify(sessionKey)} });
            observed.push({ phase, ok: true });
          } catch { observed.push({ phase, ok: false }); }
        };
        route("registration");
        api.registerService({ id: "preparation-probe", start() { route("service"); } });
        api.registerTool({ name: "preparation_probe", description: "Exercise published routing",
          parameters: { type: "object", properties: {} },
          execute() { route("published"); return { content: [{ type: "text", text: "done" }] }; }
        });
        setImmediate(() => { route("late"); process.emit(${JSON.stringify(event)}, observed); });
      } };`,
    });
    const manifestPath = path.join(plugin.dir, "openclaw.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, contracts: { tools: ["preparation_probe"] } }),
    );
    const config = {
      plugins: { allow: [plugin.id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
    };
    const previous = createEmptyPluginRegistry();
    setActivePluginRegistry(previous);
    const registry = loadOpenClawPlugins({
      config,
      cache: false,
      activate: mode === "root",
      ...(mode === "replacement" ? { previousRegistry: previous, runtimeSideEffects: true } : {}),
    });
    expect(registry.plugins).toContainEqual(
      expect.objectContaining({ id: plugin.id, status: "loaded" }),
    );
    const start = () => startPluginServices({ registry, config });
    const services = await (mode === "replacement"
      ? withPluginRegistryPreparationScope(registry, start)
      : start());
    try {
      const observed = await late.promise;
      expect(observed).toEqual([
        { phase: "registration", ok: mode !== "replacement" },
        { phase: "service", ok: mode !== "replacement" },
        { phase: "late", ok: mode !== "replacement" },
      ]);
      expect(drainSystemEvents(sessionKey)).toEqual(
        mode === "replacement" ? [] : ["registration", "service", "late"],
      );
      if (mode === "replacement") {
        expect(getActivePluginRegistry()).toBe(previous);
        activatePluginRegistry(registry, null, "gateway-bindable", undefined, previous);
      }
      const tool = registry.tools[0]!.factory({ config });
      if (!tool || Array.isArray(tool)) {
        throw new Error("Expected the registered preparation probe");
      }
      await tool.execute("published", {});
      expect(drainSystemEvents(sessionKey)).toEqual(["published"]);
    } finally {
      await services.stop();
      await disposePluginRegistryInstances(registry);
    }
  },
);

it.each(["cold", "cached-discovery", "retained-discovery"] as const)(
  "prepares full context-engine registration without publication after %s",
  async (mode) => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "runtime-intent",
      body: `module.exports = { id: "runtime-intent", register(api) {
        if (api.registrationMode !== "full") return;
        api.registerContextEngine("runtime-intent", () => ({
          info: { id: "runtime-intent", name: "Runtime Intent" },
          ingest: async () => ({ ingested: true }),
          assemble: async () => ({ messages: [], estimatedTokens: 0, systemPromptAddition: "runtime-ready" }),
          compact: async () => ({ ok: true, compacted: false }),
        }));
      } };`,
    });
    const config: OpenClawConfig = {
      plugins: {
        allow: [plugin.id],
        load: { paths: [plugin.file] },
        slots: { memory: "none", contextEngine: plugin.id },
      },
    };
    const options = { config, activate: false };
    const published = createEmptyPluginRegistry();
    setActivePluginRegistry(published);
    const discovery = mode === "cold" ? undefined : loadOpenClawPlugins(options);
    expect(discovery?.contextEngines.has(plugin.id) ?? false).toBe(false);
    const prepared = loadOpenClawPlugins({
      ...options,
      runtimeSideEffects: true,
      ...(mode === "retained-discovery" ? { previousRegistry: discovery } : {}),
    });
    try {
      expect(getActivePluginRegistry()).toBe(published);
      const registration = prepared.contextEngines.get(plugin.id);
      expect(registration?.lifecycle).toBe("runtime");
      if (!registration) {
        throw new Error("Full-only context engine was not registered");
      }
      const engine = await withPluginRegistryPreparationScope(prepared, () =>
        registration.factory({ config }),
      );
      expect(await engine.assemble({ sessionId: "runtime-intent", messages: [] })).toMatchObject({
        systemPromptAddition: "runtime-ready",
      });
      if (mode === "cached-discovery") {
        expect(loadOpenClawPlugins(options)).toBe(discovery);
        expect(loadOpenClawPlugins({ ...options, runtimeSideEffects: false })).toBe(discovery);
        expect(loadOpenClawPlugins({ ...options, runtimeSideEffects: true })).toBe(prepared);
      }
      expect(getActivePluginRegistry()).toBe(published);
    } finally {
      await Promise.all(
        [prepared, ...(discovery ? [discovery] : [])].map((registry) =>
          disposePluginRegistryInstances(registry),
        ),
      );
    }
  },
);
