// Exercise Labs through the same authenticated config RPC used by Settings.
import net from "node:net";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type {
  HelloOk,
  PluginsControlUiCatalog,
  PluginsUiDescriptorsResult,
} from "../../packages/gateway-protocol/src/index.js";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { prepareHostConfigSnapshot } from "../config/io.snapshot-preparation.js";
import { resetGatewayRestartStateForInProcessRestart } from "../infra/restart.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { GatewayClient } from "./client.js";
import { startGatewayServer } from "./server.js";

const TOKEN = "labs-hot-reload-synthetic-token";
const PLUGIN_ID = "labs-browser-fixture";
const RFB_VERSION = "RFB 003.008\n";
let state: OpenClawTestState | undefined;
let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
let client: GatewayClient | undefined;
let rfbServer: net.Server | undefined;
const rfbPeers = new Set<net.Socket>();
const observers: WebSocket[] = [];
const restartSignal = vi.fn();

afterEach(async () => {
  await runQaGatewayFixture(
    async () => resetGatewayRestartStateForInProcessRestart(),
    async () => {
      for (const observer of observers.splice(0)) {
        observer.terminate();
      }
      await client?.stopAndWait();
      client = undefined;
    },
    async () => {
      await server?.close();
      server = undefined;
    },
    async () => {
      for (const peer of rfbPeers) {
        peer.destroy();
      }
      if (rfbServer) {
        await new Promise<void>((resolve) => {
          rfbServer!.close(() => resolve());
        });
        rfbServer = undefined;
      }
    },
    () => resetGatewayRestartStateForInProcessRestart(),
    () => process.off("SIGUSR1", restartSignal),
    () => state?.cleanup(),
    () => resetLogger(),
    () => clearPluginMetadataLifecycleCaches(),
  );
});

it("applies all Labs switches through config.patch without restarting the Gateway", async () => {
  state = await createOpenClawTestState({
    label: "labs-hot-reload",
    env: {
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });
  setLoggerOverride({ level: "silent", consoleLevel: "silent" });
  process.on("SIGUSR1", restartSignal);

  rfbServer = net.createServer((socket) => {
    rfbPeers.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => rfbPeers.delete(socket));
    socket.write(RFB_VERSION);
    socket.once("data", () => socket.write(Buffer.from([1, 2])));
  });
  await new Promise<void>((resolve, reject) => {
    rfbServer!.once("error", reject);
    rfbServer!.listen(0, "127.0.0.1", resolve);
  });
  const rfbAddress = rfbServer.address();
  if (!rfbAddress || typeof rfbAddress === "string") {
    throw new Error("expected synthetic VNC server address");
  }

  const pluginPath = state.statePath("fixtures", PLUGIN_ID);
  await state.writeJson(`fixtures/${PLUGIN_ID}/package.json`, {
    name: PLUGIN_ID,
    type: "commonjs",
    openclaw: { extensions: ["./index.js"] },
  });
  await state.writeJson(`fixtures/${PLUGIN_ID}/openclaw.plugin.json`, {
    id: PLUGIN_ID,
    name: "Labs browser fixture",
    activation: { onStartup: true },
    configSchema: { type: "object", additionalProperties: false },
    controlUi: { entry: "dist/control-ui/index.js" },
  });
  await state.writeText(
    `fixtures/${PLUGIN_ID}/dist/control-ui/index.js`,
    `export default { id: "${PLUGIN_ID}" };`,
  );
  await state.writeText(
    `fixtures/${PLUGIN_ID}/index.js`,
    `module.exports = { id: "${PLUGIN_ID}", register(api) {
      const instance = require("node:crypto").randomUUID();
      api.session.controls.registerControlUiDescriptor({
        id: "summary", surface: "widget", label: "Labs summary"
      });
      api.registerGatewayMethod("labsFixture.identity", ({ client, respond }) => {
        respond(true, { instance, connId: client.connId });
      }, { scope: "operator.read" });
    } };`,
  );
  const labsPatch = (enabled: boolean) => ({
    tools: {
      codeMode: { enabled: enabled ? "auto" : false },
      toolSearch: { enabled, mode: "directory" },
    },
    gateway: { controlUi: { experimental: { customPlugins: enabled } } },
    desktop: { host: { enabled } },
    cloudWorkers: { desktop: enabled },
  });
  await state.writeConfig({
    ...labsPatch(false),
    agents: { entries: { main: {} } },
    desktop: { host: { enabled: false, port: rfbAddress.port } },
    plugins: {
      allow: [PLUGIN_ID],
      slots: { memory: "none" },
      load: { paths: [pluginPath] },
      entries: { [PLUGIN_ID]: { enabled: true } },
    },
  });
  const port = await getFreePort();
  const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));
  server = await startGatewayServer(port, {
    auth: { mode: "token", token: TOKEN },
    prepareConfigSnapshot: prepareHostConfigSnapshot,
    controlUiEnabled: false,
    hotReloadRecovery,
  });
  const connected = createDeferredCore<HelloOk>();
  const hellos: HelloOk[] = [];
  const connectionClosed = vi.fn();
  client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token: TOKEN,
    clientName: "gateway-client",
    clientVersion: "1.0.0",
    platform: "test",
    mode: "backend",
    deviceIdentity: null,
    scopes: ["operator.admin"],
    hostDeps: {
      loadDeviceAuthToken: () => null,
      storeDeviceAuthToken: () => {},
      clearDeviceAuthToken: () => {},
    },
    onHelloOk: (hello) => {
      hellos.push(hello);
      connected.resolve(hello);
    },
    onConnectError: (error) => connected.reject(error),
    onClose: connectionClosed,
  });
  client.start();
  const hello = await withTestTimeout(connected.promise, 10_000, "Gateway connect timeout");
  await server.startupSettled;
  const gateway = client;
  const identity = await gateway.request("labsFixture.identity", {});

  const assertPluginUi = async (enabled: boolean) => {
    const catalog = await gateway.request<PluginsControlUiCatalog>("plugins.controlUi.list", {});
    expect(catalog.plugins.some((entry) => entry.pluginId === PLUGIN_ID)).toBe(enabled);
    expect(catalog.diagnostics).toEqual(
      enabled
        ? []
        : [
            expect.objectContaining({
              pluginId: PLUGIN_ID,
              code: "custom-plugin-ui-disabled",
            }),
          ],
    );
    const descriptors = await gateway.request<PluginsUiDescriptorsResult>(
      "plugins.uiDescriptors",
      {},
    );
    expect(descriptors.controlUiWidgetKinds?.some((entry) => entry.pluginId === PLUGIN_ID)).toBe(
      enabled,
    );
  };
  const observeHost = () =>
    gateway.request<{ wsPath: string; transport: string; auth: string }>("desktop.observe", {
      source: { kind: "host" },
    });
  const connectObserver = async (wsPath: string) => {
    const observer = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
    observers.push(observer);
    const banner = new Promise<string>((resolve, reject) => {
      observer.once("message", (data) => resolve(rawDataToString(data)));
      observer.once("error", reject);
      observer.once("close", () => reject(new Error("desktop closed before VNC banner")));
    });
    expect(await withTestTimeout(banner, 5_000, "VNC banner timeout")).toBe(RFB_VERSION);
    return observer;
  };
  const assertWorkerDesktop = async (enabled: boolean) => {
    for (const [method, params] of [
      ["worker.desktop.observe", { environmentId: "missing-labs-worker" }],
      ["worker.desktop.launch", { environmentId: "missing-labs-worker", app: "browser" }],
      [
        "desktop.launch",
        { source: { kind: "environment", environmentId: "missing-labs-worker" }, app: "browser" },
      ],
    ] as const) {
      await expect(gateway.request(method, params)).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining(
          enabled ? "Unknown worker environment: missing-labs-worker" : "is disabled",
        ),
      });
    }
  };

  await assertPluginUi(false);
  await expect(observeHost()).rejects.toMatchObject({
    message: expect.stringContaining("disabled"),
  });
  let activeObserver: WebSocket | undefined;
  for (const enabled of [true, false, true]) {
    const config = await gateway.request<{ hash: string }>("config.get", {});
    const patch = await gateway.request<{
      restart?: unknown;
      sentinel: { payload: { stats: { requiresRestart: boolean } } };
    }>("config.patch", { raw: JSON.stringify(labsPatch(enabled)), baseHash: config.hash });
    expect(patch.sentinel.payload.stats.requiresRestart).toBe(false);
    expect(patch.restart).toBeUndefined();
    await assertPluginUi(enabled);
    await assertWorkerDesktop(enabled);
    if (enabled) {
      const observed = await observeHost();
      expect(observed).toMatchObject({ transport: "rfb", auth: "vnc-password" });
      activeObserver = await connectObserver(observed.wsPath);
    } else {
      await expect.poll(() => activeObserver?.readyState).toBe(WebSocket.CLOSED);
      await expect(observeHost()).rejects.toMatchObject({
        message: expect.stringContaining("disabled"),
      });
    }
    expect(await gateway.request("labsFixture.identity", {})).toEqual(identity);
    expect(hellos.map((entry) => entry.server.connId)).toEqual([hello.server.connId]);
    expect(connectionClosed).not.toHaveBeenCalled();
    expect(hotReloadRecovery).not.toHaveBeenCalled();
    expect(restartSignal).not.toHaveBeenCalled();
  }
  expect(hello.features.methods).toEqual(
    expect.arrayContaining(["desktop.launch", "worker.desktop.observe", "worker.desktop.launch"]),
  );
});
