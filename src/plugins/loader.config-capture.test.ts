import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { loadPreparedInboundPluginRegistry } from "../agents/prepared-model-runtime.inbound-registry.js";
import { prepareOwnedPluginLoadContext } from "../agents/prepared-model-runtime.plugin-context.js";
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
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import {
  clearActivePluginRegistry,
  disposePluginRegistryInstances,
  setActivePluginRegistry,
} from "./runtime.js";
import { getPluginRuntimeLoadContext } from "./runtime/load-context.js";

afterEach(() => {
  resetConfigRuntimeState();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it("keeps registered callbacks on their captured config while explicit runtime readers follow refresh", async () => {
  const root = makePluginLoaderTempDir();
  const event = `config-capture:${root}`;
  let registeredConfig: OpenClawConfig | undefined;
  let registrations = 0;
  const onRegistered = (config: OpenClawConfig) => {
    registeredConfig = config;
    registrations++;
  };
  const plugin = writePlugin({
    id: "config-capture",
    dir: path.join(root, "plugin"),
    body: `module.exports = { id: 'config-capture', register(api) {
      process.emit(${JSON.stringify(event)}, api.config);
      api.registerTool((ctx) => ({
        name: 'config_capture',
        description: api.config.agents.entries.ops.name,
        parameters: { type: 'object', properties: {} },
        execute() { return { content: [], details: {
          workspaceDir: ctx.workspaceDir,
          model: api.config.agents.defaults.model,
          token: api.config.gateway.auth.token,
        } }; }
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
    agents: {
      defaults: { model: "fixture/initial" },
      entries: { ops: { name: "registration snapshot" } },
    },
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
        const metadataSnapshot = loadPluginMetadataSnapshot({ config: runtime });
        expect(metadataSnapshot.workspaceDir).toBeUndefined();
        const registry = loadOpenClawPlugins({
          config: runtime,
          workspaceDir: root,
          manifestRegistry: metadataSnapshot.manifestRegistry,
          discovery: metadataSnapshot.discovery,
          cache: false,
          activate: false,
          runtimeSideEffects: true,
          throwOnLoadError: true,
        });
        const registries = [registry];
        try {
          expect(registeredConfig).toBe(getPluginRuntimeLoadContext(registry)?.config);
          if (!registeredConfig) {
            throw new Error("Expected fixture plugin registration");
          }
          const readCurrent = createRuntimeConfigReader(registeredConfig);
          expect(readCurrent()).toBe(runtime);
          prepareOwnedPluginLoadContext(
            { config: runtime, workspaceDir: root },
            process.env,
            registry,
            metadataSnapshot,
          );
          setActivePluginRegistry(registry, undefined, "gateway-bindable", root);
          for (const workspaceDir of [root, path.join(root, "other-workspace"), root]) {
            const inbound = loadPreparedInboundPluginRegistry(
              { config: runtime, workspaceDir, allowGatewaySubagentBinding: true },
              metadataSnapshot,
            );
            expect(inbound).toBe(registry);
            expect(getPluginRuntimeLoadContext(registry)?.workspaceDir).toBe(root);
            const tool = inbound.tools[0]?.factory({ workspaceDir });
            if (!tool || Array.isArray(tool)) {
              throw new Error("Expected one config capture tool");
            }
            expect(await tool.execute("inbound", {})).toMatchObject({
              details: {
                workspaceDir,
                model: "fixture/initial",
                token: "synthetic-resolved-token",
              },
            });
          }
          expect(registrations).toBe(1);
          runtime.agents!.entries!.ops!.name = "caller mutation";
          expect(registry.tools[0]?.factory({})).toMatchObject({
            description: "registration snapshot",
          });

          const replacement: OpenClawConfig = {
            ...runtime,
            agents: { ...runtime.agents, defaults: { model: "fixture/next" } },
            gateway: { auth: { mode: "token", token: "synthetic-rotated-token" } },
          };
          setRuntimeConfigSnapshot(replacement, source);
          expect(readCurrent()).toBe(replacement);
          expect(registry.tools[0]?.factory({})).toMatchObject({
            description: "registration snapshot",
          });
          expect(getPluginRuntimeLoadContext(registry)?.rawConfig).toBe(runtime);
          const refreshed = loadPreparedInboundPluginRegistry(
            { config: replacement, workspaceDir: root, allowGatewaySubagentBinding: true },
            metadataSnapshot,
          );
          registries.push(refreshed);
          expect(refreshed).not.toBe(registry);
          const tool = refreshed.tools[0]?.factory({ workspaceDir: root });
          if (!tool || Array.isArray(tool)) {
            throw new Error("Expected one refreshed config capture tool");
          }
          expect(await tool.execute("refreshed", {})).toMatchObject({
            details: {
              workspaceDir: root,
              model: "fixture/next",
              token: "synthetic-rotated-token",
            },
          });
          expect(registrations).toBe(2);
        } finally {
          await clearActivePluginRegistry();
          for (const owned of registries.toReversed()) {
            await disposePluginRegistryInstances(owned);
          }
        }
      },
    );
  } finally {
    process.off(event, onRegistered);
  }
});
