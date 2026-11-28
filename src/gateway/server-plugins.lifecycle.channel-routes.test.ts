/** Real Gateway channel account routes across another plugin's config hot reload. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { waitForGatewayStartup } from "../../test/helpers/gateway-startup.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import * as configFileSource from "../config/source-file.js";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { createWatcherMock } from "./config-reload.watcher.test-support.js";
import {
  installInstanceBindingProbeCoordinator,
  writeInstanceBindingProbePlugin,
} from "./server-plugins.lifecycle.test-fixtures.js";
import {
  closePluginGateway,
  configurePluginGateway,
  installInstanceBindingConfigIo,
  startPluginGateway,
  writeJson,
  type PluginServer,
  type PluginSocket,
} from "./server-plugins.lifecycle.test-support.js";
import { loadGatewayTestConfig } from "./test-helpers.config-runtime.js";
import { connectWebchatClient, installGatewayTestHooks, rpcReq } from "./test-helpers.server.js";

// Fixtures must register real plugins after the shared helpers install their mocks.
vi.doUnmock("../plugins/loader.js");
installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
installInstanceBindingConfigIo();

async function useGatewayGraphPluginRuntime(): Promise<void> {
  // Keep the real lazy runtime on this server fixture's mocked Vitest graph.
  const runtimeModule = await import("../plugins/runtime/index.js");
  const nativeModule = await import("../plugins/native-module-require.js");
  const nativeLoad = nativeModule.tryNativeRequireModule;
  const runtimePaths = new Set([
    path.resolve("src/plugins/runtime/index.ts"),
    path.resolve("dist/plugins/runtime/index.js"),
  ]);
  const runtimeLoader = vi
    .spyOn(nativeModule, "tryNativeRequireModule")
    .mockImplementation((modulePath, options) =>
      runtimePaths.has(modulePath)
        ? { ok: true, moduleExport: runtimeModule }
        : nativeLoad(modulePath, options),
    );
  onTestFinished(() => runtimeLoader.mockRestore());
}

async function writeConfiguredPlugin(bundledRoot: string): Promise<void> {
  const pluginDir = path.join(bundledRoot, "relay-config");
  await fs.mkdir(pluginDir, { recursive: true });
  await writeJson(path.join(pluginDir, "package.json"), {
    name: "relay-config",
    type: "commonjs",
    main: "index.js",
    openclaw: { extensions: ["./index.js"] },
    peerDependencies: { openclaw: ">=2026.1.1" },
  });
  await writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
    id: "relay-config",
    activation: { onStartup: true },
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: { relayBaseUrl: { type: "string" } },
    },
  });
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `module.exports = { id: "relay-config", register(api) {
  const instance = require("node:crypto").randomUUID();
  const relayBaseUrl = api.pluginConfig?.relayBaseUrl ?? null;
  api.registerGatewayMethod("relayConfig.probe", ({ context, respond }) => {
    respond(true, { instance, relayBaseUrl, reloadSettled: context.isConfigReloadSettled() });
  }, { scope: "operator.read" });
} };`,
  );
}

const channelId = "route-reload";
let server: PluginServer | undefined;
let socket: PluginSocket | undefined;

afterEach(async () => {
  try {
    await closePluginGateway(server, socket);
  } finally {
    server = undefined;
    socket = undefined;
  }
});

it(
  "keeps a running channel account's HTTP route served across another plugin's config hot reload",
  { timeout: 240_000 },
  async () => {
    let starts = 0;
    const channelPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: channelId,
        config: {
          listAccountIds: () => ["default"],
          defaultAccountId: () => "default",
          resolveAccount: (_cfg, accountId) => ({ accountId }),
          isEnabled: () => true,
          isConfigured: () => true,
        },
      }),
      gateway: {
        // A channel that serves its account over HTTP registers the route when the account starts.
        async startAccount({ accountId, abortSignal, setStatus }) {
          starts += 1;
          const unregister = registerPluginHttpRoute({
            path: "/route-reload",
            match: "prefix",
            auth: "plugin",
            pluginId: "instance-binding-probe",
            accountId,
            throwOnFailure: true,
            handler: (_req, res) => {
              const registry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
              res.setHeader(
                "x-route-registry",
                registry === getActivePluginRegistry() ? "current" : "stale",
              );
              res.end("alive");
              return true;
            },
          });
          setStatus({ accountId, running: true, connected: true, lifecycle: "ready" });
          try {
            await new Promise<void>((resolve) => {
              if (abortSignal.aborted) {
                resolve();
                return;
              }
              abortSignal.addEventListener("abort", () => resolve(), { once: true });
            });
          } finally {
            unregister();
          }
        },
      },
    };
    const coordinator = installInstanceBindingProbeCoordinator();
    coordinator.channel = channelPlugin;
    const bundledRoot = tempDirs.make("openclaw-channel-route-reload-");
    await writeInstanceBindingProbePlugin(bundledRoot, coordinator.channelName, channelId);
    await writeConfiguredPlugin(bundledRoot);
    const configPath = configurePluginGateway(bundledRoot, true);
    const config = loadGatewayTestConfig();
    config.plugins = {
      enabled: true,
      allow: ["instance-binding-probe", "relay-config"],
      slots: { memory: "none" },
      entries: {
        "instance-binding-probe": { enabled: true },
        "relay-config": { enabled: true, config: { relayBaseUrl: "https://relay0.test" } },
      },
    };
    await writeJson(configPath, config);
    await useGatewayGraphPluginRuntime();
    const createConfigFileAdapter = configFileSource.createConfigFileAdapter;
    const watchSpy = vi
      .spyOn(configFileSource, "createConfigFileAdapter")
      .mockImplementation((options) => {
        if (options.path !== configPath) {
          return createConfigFileAdapter(options);
        }
        // Explicit writes own reloads.
        const watcher = createWatcherMock();
        const adapter = watcher.attach(options);
        return {
          ...adapter,
          async start() {
            await adapter.start();
            queueMicrotask(() => watcher.emit("ready"));
          },
        };
      });
    onTestFinished(() => watchSpy.mockRestore());
    const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));
    const started = await startPluginGateway({ hotReloadRecovery });
    server = started.server;
    const port = started.port;
    await server.startupSettled;
    await waitForGatewayStartup(port);
    socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
    const connected = socket;
    const probeRoute = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/route-reload/inbound`, {
        method: "POST",
      });
      return {
        status: response.status,
        body: await response.text(),
        registry: response.headers.get("x-route-registry"),
      };
    };
    // Registration precedes watcher settlement; poll only the read, never the mutation.
    const settledRelay = async () =>
      await vi.waitUntil(
        async () => {
          const result = await rpcReq<{
            instance: string;
            relayBaseUrl: string | null;
            reloadSettled: boolean;
          }>(connected, "relayConfig.probe", {});
          expect(result.ok, result.error?.message).toBe(true);
          assert.ok(result.payload);
          return result.payload.reloadSettled ? result.payload : false;
        },
        { timeout: 60_000, interval: 100 },
      );
    const routeKeys = () =>
      (getActivePluginRegistry()?.httpRoutes ?? [])
        .map((route) => `${route.pluginId ?? ""} ${route.match} ${route.path}`)
        .toSorted();
    const alive = { status: 200, body: "alive", registry: "current" };

    await expect.poll(() => starts, { timeout: 30_000 }).toBe(1);
    expect(await probeRoute()).toEqual(alive);
    const routesBefore = routeKeys();
    expect(routesBefore).toContain("instance-binding-probe prefix /route-reload");
    let previousInstance = (await settledRelay()).instance;

    for (let round = 1; round <= 3; round++) {
      const registryBefore = getActivePluginRegistry();
      const current = await rpcReq<{ hash: string }>(connected, "config.get", {});
      const changed = await rpcReq(connected, "config.patch", {
        raw: JSON.stringify({
          plugins: {
            entries: { "relay-config": { config: { relayBaseUrl: `https://relay${round}.test` } } },
          },
        }),
        baseHash: current.payload?.hash,
      });
      expect(changed.ok, changed.error?.message).toBe(true);
      await expect
        .poll(async () => (await settledRelay()).relayBaseUrl, { timeout: 60_000 })
        .toBe(`https://relay${round}.test`);
      // The reload is real: the configured plugin registered again into a new registry.
      const reloaded = await settledRelay();
      expect(reloaded.instance).not.toBe(previousInstance);
      expect(getActivePluginRegistry()).not.toBe(registryBefore);
      previousInstance = reloaded.instance;
      expect({ round, ...(await probeRoute()) }).toEqual({ round, ...alive });
      expect(routeKeys()).toEqual(routesBefore);
      expect(starts).toBe(1);
    }

    // Stopping the account still removes the route from the registry it was carried into.
    const stopped = await rpcReq(connected, "channels.stop", {
      channel: channelId,
      accountId: "default",
    });
    expect(stopped.ok, stopped.error?.message).toBe(true);
    await expect.poll(async () => (await probeRoute()).status, { timeout: 30_000 }).toBe(404);
    expect(hotReloadRecovery).not.toHaveBeenCalled();
  },
);
