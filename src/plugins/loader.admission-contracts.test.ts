import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  createRuntimeConfigReader,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { drainSystemEvents } from "../infra/system-events.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { activatePluginRegistry } from "./loader-shared.js";
import {
  loadOpenClawPluginCliRegistry,
  loadOpenClawPlugins,
  loadPluginRegistryHandle,
} from "./loader.js";
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
import { getPluginRuntimeLoadContext } from "./runtime/load-context.js";
import { startPluginServices } from "./services.test-support.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

it("keeps effective enablement separate from reason-only CLI activation", async () => {
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
  const registry = await loadOpenClawPluginCliRegistry(options);
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
});

it("keeps scoped forced setup selection with a setup entry", () => {
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
  writePlugin({
    id: plugin.id,
    dir: plugin.dir,
    filename: "setup.cjs",
    body: `require("node:fs").writeFileSync(${JSON.stringify(setupMarker)}, "imported");
${channelSource}
module.exports = { plugin: channel };`,
  });
  writePluginMetadata({
    dir: plugin.dir,
    id: plugin.id,
    channels: ["admission-channel"],
    packageJson: {
      name: "@example/admission-setup",
      version: "1.0.0",
      openclaw: {
        extensions: ["./index.cjs"],
        setupEntry: "./setup.cjs",
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
  expect(fs.existsSync(setupMarker)).toBe(true);
  expect(fs.existsSync(fullMarker)).toBe(false);
});

it("keeps system routing bound to the replacement lifecycle owner", async () => {
  useNoBundledPlugins();
  const sessionKey = "preparation-replacement";
  const queueKey = `agent:main:${sessionKey}`;
  const event = "plugin-preparation-replacement";
  const late = createDeferredCore<Array<{ phase: string; ok: boolean }>>();
  const receive = (observed: Array<{ phase: string; ok: boolean }>) => late.resolve(observed);
  process.once(event, receive);
  onTestFinished(() => {
    process.off(event, receive);
    drainSystemEvents(queueKey);
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
    activate: false,
    previousRegistry: previous,
    runtimeSideEffects: true,
  });
  expect(registry.plugins).toContainEqual(
    expect.objectContaining({ id: plugin.id, status: "loaded" }),
  );
  const start = () => startPluginServices({ registry, config });
  const services = await withPluginRegistryPreparationScope(registry, start);
  try {
    const observed = await late.promise;
    expect(observed).toEqual([
      { phase: "registration", ok: false },
      { phase: "service", ok: false },
      { phase: "late", ok: false },
    ]);
    expect(drainSystemEvents(queueKey)).toEqual([]);
    expect(getActivePluginRegistry()).toBe(previous);
    activatePluginRegistry(registry, null, "gateway-bindable", undefined, previous);
    const tool = registry.tools[0]!.factory({ config });
    if (!tool || Array.isArray(tool)) {
      throw new Error("Expected the registered preparation probe");
    }
    await tool.execute("published", {});
    expect(drainSystemEvents(queueKey)).toEqual(["published"]);
  } finally {
    await services.stop();
    await disposePluginRegistryInstances(registry);
  }
});

it.each(["cached-discovery", "retained-discovery"] as const)(
  "prepares full context-engine registration without publication after %s",
  async (mode) => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "runtime-intent",
      registration: `if (api.registrationMode !== "full") return;
      api.registerContextEngine("runtime-intent", () => ({
        info: { id: "runtime-intent", name: "Runtime Intent" },
        ingest: async () => ({ ingested: true }),
        assemble: async () => ({ messages: [], estimatedTokens: 0, systemPromptAddition: "runtime-ready" }),
        compact: async () => ({ ok: true, compacted: false }),
      }));`,
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
    const discovery = loadOpenClawPlugins(options);
    expect(discovery.contextEngines.has(plugin.id)).toBe(false);
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
        [prepared, discovery].map((registry) => disposePluginRegistryInstances(registry)),
      );
    }
  },
);

describe("registry load modes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginStateStoreForTests();
    clearRuntimeConfigSnapshot();
  });

  it("keeps validation and full registry caches separate", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "cached-load-mode",
      registration: 'api.registerProvider({ id: "mode-provider", label: "Mode", auth: [] });',
    });
    const options = {
      config: {
        plugins: {
          allow: [plugin.id],
          load: { paths: [plugin.file] },
          slots: { memory: "none" },
        },
      },
    };
    const validation = loadPluginRegistryHandle({ ...options, mode: "validate" });
    const full = loadPluginRegistryHandle(options);

    expect(full.providers.map(({ provider }) => provider.id)).toEqual(["mode-provider"]);
    expect(validation.plugins).toContainEqual(
      expect.objectContaining({ id: plugin.id, status: "loaded" }),
    );
    expect(validation.providers).toEqual([]);
    expect(loadPluginRegistryHandle(options)).toBe(full);
    expect(loadPluginRegistryHandle({ ...options, mode: "full" })).toBe(full);
    expect(loadPluginRegistryHandle({ ...options, mode: "validate" })).toBe(validation);
  });
});

describe("registration config snapshot", () => {
  afterEach(resetConfigRuntimeState);

  it("keeps registered callbacks on their captured config while explicit runtime readers follow refresh", async () => {
    const root = makePluginLoaderTempDir();
    const event = `config-capture:${root}`;
    let registeredConfig: OpenClawConfig | undefined;
    const onRegistered = (config: OpenClawConfig) => {
      registeredConfig = config;
    };
    const plugin = writePlugin({
      id: "config-capture",
      dir: path.join(root, "plugin"),
      body: `module.exports = { id: 'config-capture', register(api) {
      process.emit(${JSON.stringify(event)}, api.config);
      api.registerTool(() => ({
        name: 'config_capture',
        description: api.config.agents.entries.ops.name,
        parameters: { type: 'object', properties: {} },
        execute() { return { content: [] }; }
      }), { name: 'config_capture' });
    } };`,
    });
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: plugin.id,
        configSchema: { type: "object", additionalProperties: false },
        contracts: { tools: ["config_capture"] },
      }),
    );
    const source: OpenClawConfig = {
      agents: { entries: { ops: { name: "registration snapshot" } } },
      gateway: { auth: { mode: "token", token: "${GATEWAY_TOKEN}" } },
      plugins: {
        allow: [plugin.id],
        load: { paths: [plugin.file] },
        slots: { memory: "none" },
      },
    };
    const runtime = structuredClone(source);
    runtime.gateway!.auth!.token = "synthetic-resolved-token";
    setRuntimeConfigSnapshot(runtime, source);
    process.on(event, onRegistered);
    try {
      await withEnvAsync(
        {
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        },
        async () => {
          const registry = loadOpenClawPlugins({
            config: runtime,
            cache: false,
            activate: false,
            runtimeSideEffects: true,
            throwOnLoadError: true,
          });
          try {
            expect(registeredConfig).toBe(getPluginRuntimeLoadContext(registry)?.config);
            if (!registeredConfig) {
              throw new Error("Expected fixture plugin registration");
            }
            const readCurrent = createRuntimeConfigReader(registeredConfig);
            expect(readCurrent()).toBe(runtime);
            runtime.agents!.entries!.ops!.name = "caller mutation";
            expect(registry.tools[0]?.factory({})).toMatchObject({
              description: "registration snapshot",
            });

            const replacement: OpenClawConfig = { ...runtime, gateway: { port: 19002 } };
            setRuntimeConfigSnapshot(replacement, source);
            expect(readCurrent()).toBe(replacement);
            expect(registry.tools[0]?.factory({})).toMatchObject({
              description: "registration snapshot",
            });
            expect(getPluginRuntimeLoadContext(registry)?.rawConfig).toBe(runtime);
          } finally {
            await disposePluginRegistryInstances(registry);
          }
        },
      );
    } finally {
      process.off(event, onRegistered);
    }
  });
});
