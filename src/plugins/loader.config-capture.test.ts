import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import {
  createRuntimeConfigReader,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "./loader.test-fixtures.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { disposePluginRegistryInstances } from "./runtime.js";
import {
  buildPluginRuntimeLoadOptions,
  getPluginRuntimeLoadContext,
  getReusablePluginRuntimeActivation,
} from "./runtime/load-context.js";

afterEach(() => {
  resetConfigRuntimeState();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

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

it.each([false, true])(
  "retains scoped registration facts with an empty provider scope=%s",
  async (empty) => {
    const root = makePluginLoaderTempDir();
    const id = "scoped-config";
    const plugin = writePlugin({
      id,
      dir: path.join(root, id),
      filename: "index.cjs",
      configSchema: {
        type: "object",
        properties: { credential: { type: "object", required: ["source", "provider", "id"] } },
        required: ["credential"],
      },
      body: `module.exports = { id: "scoped-config", register(api) {
      api.registerProvider({ id: "scoped-config", label: api.pluginConfig.credential, auth: [] });
    } };`,
    });
    const manifestPath = path.join(plugin.dir, "openclaw.plugin.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(manifestPath, "utf8")),
        configContracts: { secretInputs: { paths: [{ path: "credential", expected: "string" }] } },
      }),
    );
    const env = {
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      SCOPED_ENV: "explicit",
    };
    const workspaceDir = path.join(root, "workspace");
    const config: OpenClawConfig = {
      env: { vars: { SCOPED_ENV: "configured", SCOPED_ADDED: "configured-only" } },
      plugins: {
        allow: [id],
        load: { paths: [plugin.file] },
        slots: { memory: "none" },
        entries: { [id]: { enabled: true, config: { credential: "synthetic-resolved-fixture" } } },
      },
    };
    const source: OpenClawConfig = {
      ...config,
      plugins: {
        ...config.plugins,
        entries: {
          [id]: {
            enabled: true,
            config: {
              credential: { source: "store", provider: "default", id: "SYNTHETIC_KEY" },
            },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(config, source);
    await using cache = createPluginCache();
    await withEnvAsync(env, () =>
      withPluginCache(cache, async () => {
        const metadataSnapshot = loadPluginMetadataSnapshot({
          config,
          env,
          workspaceDir,
          allowCurrent: false,
        });
        const options = {
          config,
          activationSourceConfig: source,
          env,
          workspaceDir,
          metadataSnapshot,
          onlyPluginIds: empty ? [] : [id],
          preferBuiltPluginArtifacts: true,
          resolveRawConfigEnvVars: true,
          activate: false,
          throwOnLoadError: true,
        };
        const registry = loadOpenClawPlugins(options);
        const actual = getPluginRuntimeLoadContext(registry);
        expect(actual).toBeDefined();
        if (!actual) {
          throw new Error("Missing scoped loader facts");
        }
        expect(actual.metadataSnapshot).toBe(metadataSnapshot);
        expect(actual.rawConfig).toBe(config);
        expect(actual.config.plugins?.allow).toEqual([id]);
        expect(actual.config.plugins?.entries?.[id]?.config).toEqual({
          credential: "synthetic-resolved-fixture",
        });
        expect(actual.activationSourceConfig.plugins?.entries?.[id]?.config).toEqual(
          source.plugins?.entries?.[id]?.config,
        );
        expect(actual.env).not.toBe(env);
        expect(actual.env.SCOPED_ENV).toBe("explicit");
        expect(actual.env.SCOPED_ADDED).toBe("configured-only");
        expect(actual.preferBuiltPluginArtifacts).toBe(true);
        expect(buildPluginRuntimeLoadOptions(actual).metadataSnapshot).toBe(metadataSnapshot);
        expect(registry.providers.map(({ provider }) => provider.label)).toEqual(
          empty ? [] : ["synthetic-resolved-fixture"],
        );
        const request = { config, env: actual.env, workspaceDir, metadataSnapshot };
        expect(getReusablePluginRuntimeActivation(registry, request)?.config).toBe(actual.config);
        for (const changed of [
          { config: { ...config, plugins: { ...config.plugins, allow: [] } } },
          { config: { ...config, plugins: { ...config.plugins, deny: [id] } } },
          { env: { ...actual.env, SCOPED_ENV: "changed" } },
          { workspaceDir: path.join(root, "other-workspace") },
          { metadataSnapshot: { ...metadataSnapshot } },
        ]) {
          expect(
            getReusablePluginRuntimeActivation(registry, { ...request, ...changed }),
          ).toBeUndefined();
        }
        if (!empty) {
          const cachedOptions = { ...options, env: actual.env, resolveRawConfigEnvVars: false };
          const cached = loadOpenClawPlugins(cachedOptions);
          expect(loadOpenClawPlugins(cachedOptions)).toBe(cached);
          const newInventory = loadOpenClawPlugins({
            ...cachedOptions,
            metadataSnapshot: { ...metadataSnapshot },
          });
          expect(newInventory).not.toBe(cached);
          expect(getPluginRuntimeLoadContext(cached)?.metadataSnapshot).toBe(metadataSnapshot);
          const invalidSource = loadOpenClawPlugins({
            ...cachedOptions,
            activationSourceConfig: config,
            throwOnLoadError: false,
          });
          expect(invalidSource).not.toBe(cached);
          expect(invalidSource.plugins.find((record) => record.id === id)?.status).toBe("error");
          expect(getPluginRuntimeLoadContext(invalidSource)?.registrationConfigKey).not.toBe(
            actual.registrationConfigKey,
          );
        }
      }),
    );
  },
);

it("pins supplied inventory without relabeling a conflicting explicit source", async () => {
  const root = makePluginLoaderTempDir();
  const id = "inventory-owner";
  const sources = ["A", "B"].map((label) =>
    writePlugin({
      id,
      dir: path.join(root, label),
      filename: "index.cjs",
      body: `module.exports = { id: "inventory-owner", register(api) {
      api.registerProvider({ id: "inventory-owner", label: ${JSON.stringify(label)}, auth: [] });
    } };`,
    }),
  );
  const env = {
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  const config: OpenClawConfig = { plugins: { allow: [id], slots: { memory: "none" } } };
  await using cache = createPluginCache();
  await withEnvAsync(env, () =>
    withPluginCache(cache, async () => {
      const snapshots = sources.map((source) =>
        loadPluginMetadataSnapshot({
          config: { ...config, plugins: { ...config.plugins, load: { paths: [source.file] } } },
          env,
          allowCurrent: false,
        }),
      );
      const [metadataA, metadataB] = snapshots;
      if (!metadataA || !metadataB) {
        throw new Error("Missing fixture inventory");
      }
      const options = { config, env, onlyPluginIds: [id], activate: false, throwOnLoadError: true };
      const admitted = loadOpenClawPlugins({ ...options, metadataSnapshot: metadataA });
      expect(admitted.providers.map(({ provider }) => provider.label)).toEqual(["A"]);
      const replacement = loadOpenClawPlugins({ ...options, metadataSnapshot: metadataB });
      expect(replacement.providers.map(({ provider }) => provider.label)).toEqual(["B"]);
      const conflicting = loadOpenClawPlugins({
        ...options,
        metadataSnapshot: metadataA,
        manifestRegistry: metadataB.manifestRegistry,
      });
      expect(conflicting.providers.map(({ provider }) => provider.label)).toEqual(["B"]);
      expect(getPluginRuntimeLoadContext(conflicting)?.metadataSnapshot).toBeUndefined();
      expect(getPluginRuntimeLoadContext(admitted)?.metadataSnapshot).toBe(metadataA);
    }),
  );
});
