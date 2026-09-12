// @vitest-environment node
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { getFreePort } from "../../../src/test-utils/ports.js";
import { createControlUiDevGateway } from "../../config/control-ui-dev-gateway.ts";
import controlUiViteConfig from "../../vite.config.ts";
import {
  gatewayWebSocketTransportUrl,
  hasSameOriginGatewayTransport,
  isConfiguredUiDevGateway,
  uiDevGatewayResourceBasePath,
  uiDevGatewayResourceUrl,
} from "../dev-gateway.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("configured UI development Gateway", () => {
  it("proxies HTTP and WebSocket resources without replacing auth, Origin, or Vite", async () => {
    const requests: Array<{ path: string; authorization?: string; origin?: string }> = [];
    const upstream = createServer((request, response) => {
      requests.push({
        path: request.url ?? "",
        authorization: request.headers.authorization,
        origin: request.headers.origin,
      });
      if (request.headers.authorization !== "Bearer fixture-credential") {
        response.writeHead(401).end();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Set-Cookie", [
        "fixture=opaque; Path=/__openclaw__/plugins/control-ui/demo/; HttpOnly; Secure; SameSite=Strict",
        "other=opaque; Path=/api/demo/; HttpOnly",
      ]);
      response.end(JSON.stringify({ owner: "gateway", path: request.url }));
    });
    const sockets = new WebSocketServer({ server: upstream });
    sockets.on("connection", (socket, request) => {
      requests.push({ path: request.url ?? "", origin: request.headers.origin });
      socket.on("message", (data) => socket.send(data));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    vi.stubEnv("OPENCLAW_UI_DEV_GATEWAY_URL", upstreamUrl);
    const config = controlUiViteConfig({ command: "serve" });
    const uiPort = await getFreePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    const server = await createViteServer({
      ...config,
      configFile: false,
      root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { ...config.server, port: uiPort },
    });
    const gateway = createControlUiDevGateway(upstreamUrl)!.gateway;
    vi.stubGlobal("OPENCLAW_UI_DEV_GATEWAY", gateway);
    vi.stubGlobal("location", new URL(uiOrigin));
    let socket: WebSocket | undefined;
    try {
      await server.listen();
      expect(server.httpServer?.address()).toMatchObject({ address: "127.0.0.1" });
      const resourcePath = `${uiDevGatewayResourceBasePath()}/control-ui-config.json`;
      const denied = await fetch(`${uiOrigin}${resourcePath}`);
      expect(denied.status).toBe(401);
      const response = await fetch(`${uiOrigin}${resourcePath}`, {
        headers: { Authorization: "Bearer fixture-credential", Origin: uiOrigin },
      });
      expect(await response.json()).toEqual({ owner: "gateway", path: "/control-ui-config.json" });
      expect(requests.at(-1)).toEqual({
        path: "/control-ui-config.json",
        authorization: "Bearer fixture-credential",
        origin: uiOrigin,
      });
      expect(response.headers.getSetCookie()).toEqual([
        `fixture=opaque; Path=${gateway.proxyPath}/__openclaw__/plugins/control-ui/demo/; HttpOnly; Secure; SameSite=Strict`,
        `other=opaque; Path=${gateway.proxyPath}/api/demo/; HttpOnly`,
      ]);
      const plugin = await fetch(
        `${uiOrigin}${uiDevGatewayResourceUrl("/plugins/demo/custom-resource")}`,
        {
          headers: { Authorization: "Bearer fixture-credential" },
        },
      );
      expect(await plugin.json()).toEqual({
        owner: "gateway",
        path: "/plugins/demo/custom-resource",
      });

      const gatewayRequests = requests.length;
      const vite = await fetch(`${uiOrigin}/@vite/client`);
      expect(vite.status).toBe(200);
      expect(await vite.text()).toContain("vite-hmr");
      expect(requests).toHaveLength(gatewayRequests);

      const previousGateway = createControlUiDevGateway("http://127.0.0.1:1")!.gateway;
      const retired = await fetch(
        `${uiOrigin}${previousGateway.proxyPath}/control-ui-config.json`,
        {
          headers: { Authorization: "Bearer retired-credential" },
        },
      );
      await retired.body?.cancel();
      expect(requests).toHaveLength(gatewayRequests);

      socket = new WebSocket(gatewayWebSocketTransportUrl(gateway.gatewayUrl), {
        origin: uiOrigin,
      });
      await once(socket, "open");
      const message = once(socket, "message");
      socket.send("normal-gateway-frame");
      expect(String((await message)[0])).toBe("normal-gateway-frame");
      expect(requests.at(-1)).toEqual({ path: "/", origin: uiOrigin });
    } finally {
      socket?.terminate();
      for (const client of sockets.clients) {
        client.terminate();
      }
      await server.close();
      await new Promise<void>((resolve) => {
        sockets.close(() => resolve());
      });
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => {
        upstream.close(() => resolve());
      });
    }
  });

  it("keeps logical Gateway identity while translating its resource base and socket", () => {
    const configured = createControlUiDevGateway("https://gateway.example/openclaw/")!.gateway;
    vi.stubGlobal("OPENCLAW_UI_DEV_GATEWAY", configured);
    vi.stubGlobal("location", new URL("http://localhost:5173/"));
    expect(configured.gatewayUrl).toBe("wss://gateway.example/openclaw");
    expect(isConfiguredUiDevGateway("wss://gateway.example/openclaw/")).toBe(true);
    expect(isConfiguredUiDevGateway("wss://other.example/openclaw")).toBe(false);
    expect(hasSameOriginGatewayTransport(configured.gatewayUrl)).toBe(true);
    expect(hasSameOriginGatewayTransport("wss://other.example/openclaw")).toBe(false);
    expect(gatewayWebSocketTransportUrl(configured.gatewayUrl)).toBe(
      `ws://localhost:5173${configured.proxyPath}/openclaw`,
    );
    expect(gatewayWebSocketTransportUrl("wss://other.example/openclaw")).toBe(
      "wss://other.example/openclaw",
    );
    expect(uiDevGatewayResourceBasePath()).toBe(`${configured.proxyPath}/openclaw`);
    const asset = uiDevGatewayResourceUrl("https://gateway.example/openclaw/avatar/main?v=2");
    expect(asset).toBe(`${configured.proxyPath}/openclaw/avatar/main?v=2`);
    expect(uiDevGatewayResourceUrl(asset)).toBe(asset);
    expect(uiDevGatewayResourceUrl("https://other.example/avatar/main")).toBe(
      "https://other.example/avatar/main",
    );
    expect(uiDevGatewayResourceUrl("http://[")).toBe("http://[");
  });

  it.each([
    "not a URL",
    "file:///tmp/gateway",
    Object.assign(new URL("http://fixture.invalid"), {
      username: "fixture",
      password: "credential",
    }).href,
    "http://localhost:18789?token=credential",
    "http://localhost:18789#token=credential",
  ])("rejects an invalid or credential-bearing dev target without echoing it (%#)", (target) => {
    expect(() => createControlUiDevGateway(target)).toThrow(/OPENCLAW_UI_DEV_GATEWAY_URL/);
    expect(() => createControlUiDevGateway(target)).not.toThrow(target);
  });

  it("does not enable the transport in bundled builds or unconfigured development", () => {
    vi.stubEnv("OPENCLAW_UI_DEV_GATEWAY_URL", "http://localhost:18789");
    expect(controlUiViteConfig({ command: "build" }).server?.proxy).toBeUndefined();
    vi.stubEnv("OPENCLAW_UI_DEV_GATEWAY_URL", "");
    expect(controlUiViteConfig({ command: "serve" }).server?.proxy).toBeUndefined();
    vi.stubGlobal("OPENCLAW_UI_DEV_GATEWAY", undefined);
    expect(gatewayWebSocketTransportUrl("ws://localhost:18789")).toBe("ws://localhost:18789");
    expect(uiDevGatewayResourceUrl("/avatar/main")).toBe("/avatar/main");
  });
});
