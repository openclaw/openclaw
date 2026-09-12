// @vitest-environment node
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, createServer as createViteServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { getFreePort } from "../../../src/test-utils/ports.js";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
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
    const events: Array<{
      phase: string;
      event: string;
      code?: string | number;
      message?: string;
    }> = [];
    const proxyCloses: Promise<void>[] = [];
    const peerCloses: Promise<number>[] = [];
    const websocketCloses: Promise<number>[] = [];
    const pendingWrites: Promise<void>[] = [];
    const eventWait = new AbortController();
    let phase = "normal";
    let interruptUpstream = false;
    const recordError = (event: string, error: { message: string; code?: string }) => {
      events.push({
        phase,
        event,
        code: error.code,
        message: error.message,
      });
    };
    const closed = (socket: WebSocket, endpoint: string) => {
      const promise = new Promise<number>((resolve) => {
        socket.on("error", (error) => recordError(`${endpoint}-error`, error));
        socket.once("close", (code) => {
          events.push({ phase, event: `${endpoint}-close`, code });
          resolve(code);
        });
      });
      websocketCloses.push(promise);
      return promise;
    };
    const nextEvent = (socket: WebSocket, event: "open" | "message") => {
      const promise = once(socket, event, { signal: eventWait.signal });
      // Cleanup cancels every pending event, including a message armed before send fails.
      void promise.catch(() => undefined);
      return promise;
    };
    const withinDeadline = async <T>(promise: Promise<T>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(JSON.stringify(events))), 5_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
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
      peerCloses.push(closed(socket, "gateway"));
      socket.on("message", (data) => {
        if (interruptUpstream) {
          interruptUpstream = false;
          events.push({ phase, event: "gateway-terminate-requested" });
          socket.terminate();
        } else if (socket.readyState === WebSocket.OPEN) {
          socket.send(data);
        }
      });
    });
    let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
    let socket: WebSocket | undefined;
    await runQaGatewayFixture(
      async () => {
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
        vi.stubEnv("OPENCLAW_UI_DEV_GATEWAY_URL", upstreamUrl);
        const config = controlUiViteConfig({ command: "serve" });
        for (const options of Object.values(config.server?.proxy ?? {})) {
          if (typeof options === "string") {
            throw new Error("Expected configured development proxy options");
          }
          const configure = options.configure;
          options.configure = (proxy, resolved) => {
            configure?.(proxy, resolved);
            proxy.on("error", (error) => recordError("proxy-error", error));
            proxy.on("proxyReqWs", (request, _incoming, downstream) => {
              downstream.on("error", (error) => recordError("downstream-error", error));
              proxyCloses.push(
                new Promise((resolve) => {
                  downstream.once("close", () => {
                    events.push({ phase, event: "downstream-close" });
                    resolve();
                  });
                }),
              );
              request.once("upgrade", (_response, upstreamSocket) => {
                upstreamSocket.on("error", (error) => recordError("upstream-error", error));
                proxyCloses.push(
                  new Promise((resolve) => {
                    upstreamSocket.once("close", () => {
                      events.push({ phase, event: "upstream-close" });
                      resolve();
                    });
                  }),
                );
              });
            });
          };
        }
        const logger = createLogger("silent");
        logger.error = (message, options) => {
          recordError("vite-error", options?.error ?? new Error(message));
        };
        const uiPort = await getFreePort();
        const uiOrigin = `http://127.0.0.1:${uiPort}`;
        server = await createViteServer({
          ...config,
          configFile: false,
          root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
          logLevel: "silent",
          customLogger: logger,
          optimizeDeps: { noDiscovery: true, include: [] },
          server: { ...config.server, port: uiPort },
        });
        const gateway = createControlUiDevGateway(upstreamUrl)!.gateway;
        vi.stubGlobal("OPENCLAW_UI_DEV_GATEWAY", gateway);
        vi.stubGlobal("location", new URL(uiOrigin));
        await server.listen();
        expect(server.httpServer?.address()).toMatchObject({ address: "127.0.0.1" });
        const resourcePath = `${uiDevGatewayResourceBasePath()}/control-ui-config.json`;
        const denied = await fetch(`${uiOrigin}${resourcePath}`);
        expect(denied.status).toBe(401);
        const response = await fetch(`${uiOrigin}${resourcePath}`, {
          headers: { Authorization: "Bearer fixture-credential", Origin: uiOrigin },
        });
        expect(await response.json()).toEqual({
          owner: "gateway",
          path: "/control-ui-config.json",
        });
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
        const firstClose = closed(socket, "client");
        await withinDeadline(nextEvent(socket, "open"));
        const message = nextEvent(socket, "message");
        socket.send("normal-gateway-frame");
        expect(String((await withinDeadline(message))[0])).toBe("normal-gateway-frame");
        expect(requests.at(-1)).toEqual({ path: "/", origin: uiOrigin });

        events.push({ phase, event: "client-close-requested" });
        socket.close(1000, "fixture-reload");
        expect(await withinDeadline(firstClose)).toBe(1000);
        expect(await withinDeadline(peerCloses[0]!)).toBe(1000);
        await withinDeadline(Promise.all(proxyCloses));
        expect(events.filter(({ event }) => event.endsWith("-error"))).toEqual([]);

        phase = "upstream-abort";
        socket = new WebSocket(gatewayWebSocketTransportUrl(gateway.gatewayUrl), {
          origin: uiOrigin,
        });
        const interruptedClose = closed(socket, "client");
        await withinDeadline(nextEvent(socket, "open"));
        const reconnectedMessage = nextEvent(socket, "message");
        socket.send("reconnected-gateway-frame");
        expect(String((await withinDeadline(reconnectedMessage))[0])).toBe(
          "reconnected-gateway-frame",
        );
        interruptUpstream = true;
        const writes = Array.from(
          { length: 32 },
          () =>
            new Promise<void>((resolve) => {
              socket!.send(Buffer.alloc(64 * 1024), (error) => {
                if (error) {
                  recordError("client-write-error", error);
                }
                resolve();
              });
            }),
        );
        pendingWrites.push(...writes);
        expect(await withinDeadline(interruptedClose)).toBe(1006);
        expect(await withinDeadline(peerCloses[1]!)).toBe(1006);
        await withinDeadline(Promise.all([...proxyCloses, ...writes]));

        phase = "recovered";
        socket = new WebSocket(gatewayWebSocketTransportUrl(gateway.gatewayUrl), {
          origin: uiOrigin,
        });
        const recoveredClose = closed(socket, "client");
        await withinDeadline(nextEvent(socket, "open"));
        const recoveredMessage = nextEvent(socket, "message");
        socket.send("recovered-gateway-frame");
        expect(String((await withinDeadline(recoveredMessage))[0])).toBe("recovered-gateway-frame");
        socket.close(1000, "fixture-complete");
        expect(await withinDeadline(recoveredClose)).toBe(1000);
        expect(await withinDeadline(peerCloses[2]!)).toBe(1000);
        await withinDeadline(Promise.all(proxyCloses));
        const termination = events.findIndex(
          ({ event }) => event === "gateway-terminate-requested",
        );
        expect(termination).toBeGreaterThan(-1);
        for (const error of events.filter(({ event }) => event.endsWith("-error"))) {
          expect(events.indexOf(error), JSON.stringify(events)).toBeGreaterThan(termination);
          expect(error.phase, JSON.stringify(events)).toBe("upstream-abort");
          // Closing the transport can cancel queued client writes on macOS.
          const expectedCodes =
            error.event === "client-write-error"
              ? ["EPIPE", "ECONNRESET", "ECANCELED"]
              : ["EPIPE", "ECONNRESET"];
          expect(expectedCodes, JSON.stringify(events)).toContain(error.code);
        }
      },
      () => {
        eventWait.abort();
        socket?.terminate();
        for (const client of sockets.clients) {
          client.terminate();
        }
      },
      async () => {
        await server?.close();
      },
      () =>
        new Promise<void>((resolve) => {
          sockets.close(() => resolve());
        }),
      () => {
        upstream.closeAllConnections();
        return new Promise<void>((resolve) => {
          upstream.close(() => resolve());
        });
      },
      () => withinDeadline(Promise.all([...proxyCloses, ...websocketCloses, ...pendingWrites])),
    );
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
