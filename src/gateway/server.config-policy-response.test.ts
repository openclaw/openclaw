// Exercise launch-only origins through real Gateway HTTP, WS, and config reload.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { resetLogger } from "../logging/logger.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { GatewayClient } from "./client.js";
import { pickPrimaryLanIPv4 } from "./net.js";
import { startGatewayServerCore } from "./server-start.js";

type ConfigSnapshot = { hash: string; config: OpenClawConfig };
type ConfigAck = { hash: string; sentinel: { payload: { stats: { requiresRestart: boolean } } } };

describe("mapped-port origin lifecycle", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let server: Awaited<ReturnType<typeof startGatewayServerCore>> | undefined;
  const clients: GatewayClient[] = [];
  beforeEach(async () => {
    state = await createOpenClawTestState({
      label: "config-policy-response",
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
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.stopAndWait()));
    await server?.close();
    server = undefined;
    await state.cleanup();
    resetLogger();
    clearPluginMetadataLifecycleCaches();
  });

  it("seeds from effective trusted-proxy launch authentication before startup validation", async () => {
    await state.writeConfig({
      gateway: {
        mode: "local",
        bind: "lan",
        auth: { mode: "none" },
        trustedProxies: ["127.0.0.1"],
      },
      logging: { level: "silent", consoleLevel: "silent" },
    });
    server = await startGatewayServerCore(await getFreePort(), {
      bind: "lan",
      publishedPort: 25432,
      auth: {
        mode: "trusted-proxy",
        trustedProxy: { userHeader: "x-auth-user", allowLoopback: true },
      },
    });
    await server.startupSettled;
  });

  it("keeps the mapped origin through public-origin rotation, then honors an explicit deny list", async () => {
    const token = "config-response-old-token";
    const origin = "https://writer.example.test";
    const nextOrigin = "https://retained.example.test";
    const mappedOrigin = "http://localhost:25432";
    await state.writeConfig({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: { mode: "token", token },
        controlUi: { enabled: true },
        reload: { mode: "hybrid" },
      },
      logging: { level: "silent", consoleLevel: "silent" },
      agents: { defaults: { workspace: state.workspaceDir } },
    });
    const port = await getFreePort();
    server = await startGatewayServerCore(port, {
      controlUiEnabled: true,
      bind: "lan",
      publishedPort: 25432,
    });
    await server.startupSettled;
    const connect = async (
      credential: string,
      browser = false,
      browserOrigin = origin,
      host = "127.0.0.1",
    ) => {
      const closed = createDeferredCore();
      const connected = createDeferredCore();
      let didClose = false;
      const client = new GatewayClient({
        url: `ws://${host}:${port}`,
        env: { ...process.env, OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1" },
        token: credential,
        clientName: browser ? "openclaw-control-ui" : "gateway-client",
        clientVersion: "1.0.0",
        mode: browser ? "webchat" : "backend",
        ...(browser ? { origin: browserOrigin } : {}),
        deviceIdentity: browser
          ? loadOrCreateDeviceIdentity({
              path: state.path("browser", "client", "credentials.sqlite"),
            })
          : null,
        scopes: ["operator.admin", "operator.read", "operator.write"],
        hostDeps: {
          loadDeviceAuthToken: () => null,
          storeDeviceAuthToken: () => {},
          clearDeviceAuthToken: () => {},
        },
        onHelloOk: () => connected.resolve(),
        onConnectError: (error) => connected.reject(error),
        onClose: (code, reason) => {
          didClose = true;
          client.stop();
          connected.reject(new Error(`closed ${code}: ${reason}`));
          closed.resolve();
        },
      });
      clients.push(client);
      client.start();
      await connected.promise;
      return { client, closed: closed.promise, didClose: () => didClose };
    };
    const writer = await connect(token);
    const initial = await writer.client.request<ConfigSnapshot>("config.get");
    await writer.client.request("config.patch", {
      baseHash: initial.hash,
      raw: JSON.stringify({ gateway: { publicOrigin: origin } }),
    });
    const mappedHost = pickPrimaryLanIPv4();
    if (!mappedHost) {
      throw new Error("Published-port proof requires a non-loopback IPv4 interface.");
    }
    const avatarPreflight = async (browserOrigin: string) => {
      const response = await fetch(`http://${mappedHost}:${port}/api/users/fixture/avatar`, {
        method: "OPTIONS",
        headers: { Origin: browserOrigin },
      });
      await response.arrayBuffer();
      return {
        status: response.status,
        origin: response.headers.get("access-control-allow-origin"),
      };
    };
    // Pair locally, then use a real non-loopback socket: dev fallback cannot mask a missing grant.
    await connect(token, true, mappedOrigin);
    const mapped = await connect(token, true, mappedOrigin, mappedHost);
    const pairResponse = await fetch(
      `http://${mappedHost}:${port}/__openclaw__/browser-pair/start`,
      {
        method: "POST",
        headers: { Origin: mappedOrigin, "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(pairResponse.status).toBe(400);
    expect(await pairResponse.text()).not.toContain("origin_not_allowed");
    expect(await avatarPreflight(mappedOrigin)).toEqual({ status: 204, origin: mappedOrigin });
    const before = await writer.client.request<ConfigSnapshot>("config.get");
    const response = await writer.client.request<ConfigAck>("config.patch", {
      baseHash: before.hash,
      raw: JSON.stringify({ gateway: { publicOrigin: nextOrigin } }),
    });
    expect(response.hash).not.toBe(before.hash);
    expect((await mapped.client.request<ConfigSnapshot>("config.get")).hash).toBe(response.hash);
    await expect(connect(token, true, origin)).rejects.toThrow(/origin not allowed/);
    await connect(token, true, nextOrigin);
    expect(await avatarPreflight(mappedOrigin)).toEqual({ status: 204, origin: mappedOrigin });
    expect(await avatarPreflight(nextOrigin)).toEqual({ status: 204, origin: nextOrigin });
    expect(await avatarPreflight(origin)).toEqual({ status: 403, origin: null });
    await writer.client.request("config.patch", {
      baseHash: response.hash,
      raw: JSON.stringify({ gateway: { controlUi: { allowedOrigins: [] } } }),
      replacePaths: ["gateway.controlUi.allowedOrigins"],
    });
    await mapped.closed;
    expect(await avatarPreflight(mappedOrigin)).toEqual({ status: 403, origin: null });
  });
});
