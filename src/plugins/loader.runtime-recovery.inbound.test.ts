import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createPreparedInboundRegistryLoader } from "../agents/prepared-model-runtime.inbound-registry.js";
import { prepareOwnedPluginLoadContext } from "../agents/prepared-model-runtime.plugin-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  getCurrentPluginMetadataSnapshot,
  setGatewayPluginMetadataSnapshot,
} from "./current-plugin-metadata-snapshot.js";
import { selectCurrentPluginMetadataCache } from "./current-plugin-metadata-state.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "./loader.test-fixtures.js";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  getProcessPluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { capturePluginRuntimeRecovery } from "./plugin-runtime-artifact-binding.js";
import type { PluginRegistry } from "./registry-types.js";
import {
  clearActivePluginRegistry,
  disposePluginRegistryInstances,
  setActivePluginRegistry,
} from "./runtime.js";

afterEach(resetPluginLoaderTestStateForTest);

function resolveProbe(registry: PluginRegistry) {
  const tool = registry.tools
    .find((entry) => entry.names.includes("recovery_inbound_probe"))
    ?.factory({});
  if (!tool || Array.isArray(tool)) {
    throw new Error("Expected one recovered inbound probe tool");
  }
  return tool;
}

it.each(["installed", "bundled-cjs", "bundled-mjs"] as const)(
  "publishes fresh %s recovery for inbound work without another registration",
  async (kind) => {
    const root = makePluginLoaderTempDir();
    const bundled = kind !== "installed";
    const extension = kind === "bundled-mjs" ? "mjs" : "cjs";
    const bundledDir = path.join(root, "bundled");
    const id = "recovery-inbound";
    const evaluatedEvent = `recovery-inbound-evaluated-${kind}`;
    const registeredEvent = `recovery-inbound-registered-${kind}`;
    const evaluated = vi.fn();
    const registered = vi.fn();
    process.on(evaluatedEvent, evaluated);
    process.on(registeredEvent, registered);
    const plugin = writePlugin({
      id,
      dir: path.join(bundled ? bundledDir : root, id),
      filename: `index.${extension}`,
      configSchema: {
        type: "object",
        properties: { marker: { type: "string" }, fail: { type: "boolean" } },
      },
      body: `process.emit(${JSON.stringify(evaluatedEvent)});
        let registrations = 0;
        ${extension === "mjs" ? "export default" : "module.exports ="} {
          id: ${JSON.stringify(id)},
          register(api) {
            const registration = ++registrations;
            process.emit(${JSON.stringify(registeredEvent)});
            const lifetime = new AbortController();
            api.lifecycle.onDispose(() => lifetime.abort());
            if (api.pluginConfig.fail) throw new Error('replacement registration failed');
            api.registerTool({ name: 'recovery_inbound_probe', description: 'Read recovered owner',
              parameters: { type: 'object', properties: {} },
              execute() {
                lifetime.signal.throwIfAborted();
                return { content: [{ type: 'text', text: api.pluginConfig.marker + ':' + registration }] };
              }
            });
          }
        };`,
    });
    const config: OpenClawConfig = {
      plugins: {
        allow: [id],
        slots: { memory: "none" },
        ...(!bundled ? { load: { paths: [plugin.dir] } } : {}),
        entries: { [id]: { enabled: true, config: { marker: "original", fail: false } } },
      },
    };
    const manifestPath = path.join(plugin.dir, "openclaw.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, contracts: { tools: ["recovery_inbound_probe"] } }),
    );
    const registries: PluginRegistry[] = [];
    const previousCache = getProcessPluginCache();
    await using operationCache = createPluginCache();
    await using publishedCache = createPluginCache();
    try {
      await withEnvAsync(
        {
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundled ? bundledDir : undefined,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: bundled ? undefined : "1",
        },
        async () => {
          const metadata = withPluginCache(publishedCache, () =>
            loadPluginMetadataSnapshot({ config, workspaceDir: root }),
          );
          bindPluginMetadataSnapshotCache(metadata, publishedCache);
          const options = {
            config,
            workspaceDir: root,
            manifestRegistry: metadata.manifestRegistry,
            discovery: metadata.discovery,
            activate: false,
            cache: false,
            runtimeSideEffects: true,
            throwOnLoadError: true,
          };
          const previous = withPluginCache(publishedCache, () => loadOpenClawPlugins(options));
          registries.push(previous);
          const oldRecord = previous.plugins.find((record) => record.id === id)!;
          expect(oldRecord.origin).toBe(bundled ? "bundled" : "config");
          const oldInstance = getPluginInstance(oldRecord)!;
          const oldTool = resolveProbe(previous);
          expect(await oldTool.execute("previous", {})).toMatchObject({
            content: [{ text: "original:1" }],
          });
          const recovery = capturePluginRuntimeRecovery(oldRecord)!;
          try {
            await disposePluginRegistryInstances(previous);
            const candidate = withPluginCache(operationCache, () =>
              loadOpenClawPlugins({
                ...options,
                config: {
                  plugins: {
                    ...config.plugins,
                    entries: {
                      [id]: { enabled: true, config: { marker: "replacement", fail: true } },
                    },
                  },
                },
                previousRegistry: previous,
                throwOnLoadError: false,
              }),
            );
            registries.push(candidate);
            expect(candidate.plugins.find((record) => record.id === id)?.error).toContain(
              "replacement registration failed",
            );
            await disposePluginRegistryInstances(candidate);
            if (!bundled) {
              fs.writeFileSync(
                plugin.file,
                "throw new Error('current package must not run during recovery');",
              );
            }
            await withPluginCache(operationCache, async () => {
              const restored = loadOpenClawPlugins({
                ...options,
                previousRegistry: previous,
                moduleRecoveries: new Map([[id, recovery]]),
              });
              registries.push(restored);
              const restoredRecord = restored.plugins.find((record) => record.id === id)!;
              expect(restoredRecord).not.toBe(oldRecord);
              expect(getPluginInstance(restoredRecord)).not.toBe(oldInstance);
              prepareOwnedPluginLoadContext(
                { config, workspaceDir: root },
                process.env,
                restored,
                metadata,
              );
              setActivePluginRegistry(restored, undefined, "gateway-bindable", root);
              setGatewayPluginMetadataSnapshot(metadata, { config, workspaceDir: root });
              expect(
                getCurrentPluginMetadataSnapshot({
                  config,
                  workspaceDir: root,
                  allowWorkspaceScopedSnapshot: true,
                }),
              ).toBeUndefined();
              const restoredTool = resolveProbe(restored);
              const expected = { content: [{ text: bundled ? "original:3" : "original:1" }] };
              expect(await restoredTool.execute("recovered", {})).toMatchObject(expected);
              expect(() => oldTool.execute("retired", {})).toThrow(/reloaded or disabled/);
              expect(registered).toHaveBeenCalledTimes(3);
              expect(evaluated).toHaveBeenCalledTimes(bundled ? 1 : 3);

              const loadInbound = createPreparedInboundRegistryLoader();
              for (let pass = 0; pass < 2; pass++) {
                const inbound = loadInbound(
                  { config, workspaceDir: root, allowGatewaySubagentBinding: true },
                  metadata,
                );
                expect(inbound).toBe(restored);
                expect(inbound.tools[0]).toBe(restored.tools[0]);
                expect(await resolveProbe(inbound).execute("inbound", {})).toMatchObject(expected);
              }
              expect(registered).toHaveBeenCalledTimes(3);
              expect(evaluated).toHaveBeenCalledTimes(bundled ? 1 : 3);
            });
          } finally {
            recovery.module.dispose();
          }
        },
      );
    } finally {
      await clearActivePluginRegistry();
      for (const registry of registries.toReversed()) {
        await disposePluginRegistryInstances(registry);
      }
      selectCurrentPluginMetadataCache(previousCache);
      process.off(evaluatedEvent, evaluated);
      process.off(registeredEvent, registered);
    }
  },
);
