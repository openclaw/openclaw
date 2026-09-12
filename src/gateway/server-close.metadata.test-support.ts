// Shared real Gateway metadata/cache fixture; spies live only during acquisition.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginMetadataSnapshotCache, withPluginCache } from "../plugins/plugin-cache.js";
import { getPluginValueInstance } from "../plugins/plugin-instance-scope.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { getPluginSetupModuleLoader } from "../plugins/plugin-setup-module.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayKernel } from "./server-kernel.js";
import type { GatewayServer } from "./server-public.js";
import { startGatewayServerCore } from "./server-start.js";

export async function createGatewayMetadataCloseFixture(label: string) {
  const original = captureActivePluginRegistrySnapshot();
  const state = await createOpenClawTestState({
    label,
    layout: "home",
    env: {
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      VITEST: "1",
    },
  });
  const pluginId = "metadata-fixture";
  const rootDir = state.path(pluginId);
  await fs.mkdir(rootDir);
  await fs.writeFile(
    path.join(rootDir, "package.json"),
    JSON.stringify({
      name: pluginId,
      version: "1.0.0",
      type: "commonjs",
      openclaw: { extensions: ["./index.cjs"] },
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      activation: { onStartup: true },
      configSchema: { type: "object", properties: {} },
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "index.cjs"),
    `module.exports = { id: ${JSON.stringify(pluginId)}, register() {} };`,
  );
  const source = path.join(rootDir, "callback.cjs");
  const dependency = path.join(rootDir, "lazy.mjs");
  const event = `${label}-setup`;
  const listeners = process.listenerCount(event);
  const writeCallback = async (value: string) => {
    await fs.writeFile(dependency, `export const value = ${JSON.stringify(value)};`);
    await fs.writeFile(
      source,
      `module.exports = (lifecycle) => {
        const listener = () => {};
        process.on(${JSON.stringify(event)}, listener);
        lifecycle.onDispose(() => process.off(${JSON.stringify(event)}, listener));
        return async () => (await import("./lazy.mjs")).value;
      };`,
    );
  };
  await writeCallback("captured");
  const config: OpenClawConfig = {
    agents: { defaults: { workspace: state.workspaceDir } },
    plugins: {
      allow: [pluginId],
      entries: { [pluginId]: { enabled: true } },
      load: { paths: [rootDir] },
      slots: { memory: "none" },
    },
  };
  const kernels = new Map<number, Awaited<ReturnType<typeof createGatewayKernel>>>();
  const servers: GatewayServer[] = [];
  const create = createGatewayKernel;
  setActivePluginRegistry(createEmptyPluginRegistry());
  return {
    state,
    config,
    kernels,
    pluginId,
    rootDir,
    dependency,
    event,
    listeners,
    writeCallback,
    loadCallback(metadata: PluginMetadataSnapshot) {
      const record = metadata.manifestRegistry.plugins.find((entry) => entry.id === pluginId);
      assert(record);
      return withPluginCache(getPluginMetadataSnapshotCache(metadata), () => {
        const setup = getPluginSetupModuleLoader(record, source, rootDir);
        const initialize = setup(source);
        assert(typeof initialize === "function");
        const owner = getPluginValueInstance(initialize);
        assert(owner);
        const callback = setup.initialize(() => initialize(owner.lifecycle));
        assert(typeof callback === "function");
        return callback;
      });
    },
    async start(port: number) {
      const token = `metadata-close-token-${port}`;
      await state.writeConfig({
        ...config,
        gateway: {
          port,
          auth: { mode: "token", token },
          controlUi: { enabled: false },
          reload: { mode: "off" },
        },
      });
      const factory = vi
        .spyOn(await import("./server-kernel.js"), "createGatewayKernel")
        .mockImplementation(async (...args) => {
          const kernel = await create(...args);
          kernels.set(args[0] ?? 18789, kernel);
          return kernel;
        });
      let server: GatewayServer;
      try {
        server = await startGatewayServerCore(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        servers.push(server);
      } finally {
        factory.mockRestore();
      }
      await server.startupSettled;
      return server;
    },
    async cleanup() {
      for (const server of servers.toReversed()) {
        await server.close().catch(() => {});
      }
      restoreActivePluginRegistrySnapshot(original);
      await state.cleanup();
    },
  };
}
