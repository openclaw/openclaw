import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { createGatewayRuntimeStateForTest } from "./test-helpers.server-runtime-state.js";

type Runtime = Awaited<ReturnType<typeof createGatewayRuntimeStateForTest>>;
type PluginRoute = ReturnType<typeof createEmptyPluginRegistry>["httpRoutes"][number];

async function listen(runtime: Runtime) {
  const server = runtime.httpServer;
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP gateway address");
  }
  return address.port;
}

function pluginRoute(path: string, overrides: Partial<PluginRoute> = {}): PluginRoute {
  return {
    path,
    auth: "plugin",
    match: "exact",
    handler: () => false,
    pluginId: path.split("/")[1] ?? path,
    source: "test",
    ...overrides,
  };
}

function upgradeHandler() {
  return vi.fn<NonNullable<PluginRoute["handleUpgrade"]>>((_req, socket) => {
    socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: demo\r\n\r\n");
    return true;
  });
}

function upgradeRegistry(pluginId: string) {
  const registry = createEmptyPluginRegistry();
  const handler = upgradeHandler();
  registry.httpRoutes.push(pluginRoute("/demo", { pluginId, handleUpgrade: handler }));
  return { registry, handler };
}

const noContent = (_req: IncomingMessage, res: ServerResponse) => {
  res.statusCode = 204;
  res.end();
  return true;
};

const expectHttpStatus = (port: number, path: string, status: number) =>
  expect(fetch(`http://127.0.0.1:${port}${path}`)).resolves.toMatchObject({ status });

function expectListen(params: Record<string, unknown>, call?: number) {
  const assertion = expect(mocks.listenGatewayHttpServer);
  if (call) {
    assertion.toHaveBeenNthCalledWith(call, expect.objectContaining(params));
  } else {
    assertion.toHaveBeenCalledWith(expect.objectContaining(params));
  }
}

const mocks = vi.hoisted(() => ({
  listenGatewayHttpServer: vi.fn(
    async (_params: {
      httpServer: { address: () => unknown };
      bindHost: string;
      port?: number;
      retryEaddrinuse?: boolean;
      serviceName?: string;
    }) => {},
  ),
  resolveGatewayListenHosts: vi.fn(async (_bindHost: string) => ["127.0.0.1"]),
  pluginsHttpModuleLoaded: vi.fn(),
}));

vi.mock("./server/http-listen.js", () => ({
  listenGatewayHttpServer: mocks.listenGatewayHttpServer,
}));

vi.mock("./net.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./net.js")>();
  return { ...actual, resolveGatewayListenHosts: mocks.resolveGatewayListenHosts };
});

vi.mock("./server/plugins-http.js", async (importOriginal) => {
  mocks.pluginsHttpModuleLoaded();
  return await importOriginal<typeof import("./server/plugins-http.js")>();
});

async function requestPluginUpgrade(port: number, path: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let response = "";
    const finish = () => resolve(response);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: demo\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += String(chunk);
    });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", reject);
    socket.setTimeout(2_000, () => {
      socket.destroy();
      reject(new Error(`plugin upgrade timed out for ${path}`));
    });
  });
}

describe("createGatewayRuntimeState", () => {
  beforeEach(() => {
    mocks.listenGatewayHttpServer.mockReset().mockImplementation(async (params) => {
      if (params.port !== 0) {
        return;
      }
      vi.spyOn(params.httpServer, "address").mockReturnValue({
        address: "127.0.0.1",
        family: "IPv4",
        port: params.serviceName === "Tailscale gateway ingress" ? 19_000 : 19_001,
      });
    });
    mocks.resolveGatewayListenHosts.mockReset().mockResolvedValue(["127.0.0.1"]);
    mocks.pluginsHttpModuleLoaded.mockClear();
  });

  afterEach(resetPluginRuntimeStateForTest);

  it("yields between buffered WebSocket messages without reordering them", async () => {
    const runtimeState = await createGatewayRuntimeStateForTest();
    const events: string[] = [];
    let sentinel: ReturnType<typeof setImmediate> | undefined;
    const received = new Promise<void>((resolve, reject) => {
      runtimeState.wss.once("connection", (socket, req) => {
        socket.once("error", reject);
        socket.on("message", (data) => {
          const message = rawDataToString(data);
          events.push(message);
          if (message === "a") {
            sentinel = setImmediate(() => events.push("yield"));
          } else {
            resolve();
          }
        });
        // Feed both masked text frames as one receive chunk through the real
        // upgraded socket, independent of TCP packet splitting/coalescing.
        req.socket.pause();
        req.socket.unshift(
          Buffer.from([0x81, 0x81, 1, 2, 3, 4, 0x60, 0x81, 0x81, 1, 2, 3, 4, 0x63]),
        );
        req.socket.resume();
      });
    });
    let client: WebSocket | undefined;
    try {
      const port = await listen(runtimeState);
      client = new WebSocket(`ws://127.0.0.1:${port}/`, {
        handshakeTimeout: 2_000,
      });
      await once(client, "open");
      await received;
      expect(events).toEqual(["a", "yield", "b"]);
    } finally {
      clearImmediate(sentinel);
      client?.terminate();
      for (const socket of runtimeState.wss.clients) {
        socket.terminate();
      }
      runtimeState.wss.close();
    }
  });

  it("keeps unrelated plugin HTTP routes cold for core HTTP and WebSocket requests", async () => {
    const registry = createEmptyPluginRegistry();
    const pluginUpgrade = upgradeHandler();
    registry.httpRoutes.push(
      pluginRoute("/unrelated"),
      pluginRoute("/plugin", { handleUpgrade: pluginUpgrade }),
    );
    const getGatewayRequestContext = vi.fn();
    const runtimeState = await createGatewayRuntimeStateForTest(registry, {
      getGatewayRequestContext,
    });
    runtimeState.wss.once("connection", (socket) => socket.close());
    const port = await listen(runtimeState);
    let gatewaySocket: WebSocket | undefined;
    try {
      await expectHttpStatus(port, "/missing", 404);
      expect(mocks.pluginsHttpModuleLoaded).not.toHaveBeenCalled();
      expect(getGatewayRequestContext).not.toHaveBeenCalled();

      gatewaySocket = new WebSocket(`ws://127.0.0.1:${port}/`, {
        handshakeTimeout: 2_000,
      });
      await once(gatewaySocket, "open");
      expect(mocks.pluginsHttpModuleLoaded).not.toHaveBeenCalled();
      expect(getGatewayRequestContext).not.toHaveBeenCalled();
      expect(pluginUpgrade).not.toHaveBeenCalled();

      await expect(requestPluginUpgrade(port, "/plugin")).resolves.toContain(
        "101 Switching Protocols",
      );
      expect(mocks.pluginsHttpModuleLoaded).toHaveBeenCalledTimes(1);
      expect(pluginUpgrade).toHaveBeenCalledTimes(1);
    } finally {
      gatewaySocket?.terminate();
    }
  });

  it("delegates directly after lazily loading the plugin HTTP handler", async () => {
    const registry = createEmptyPluginRegistry();
    const routes = registry.httpRoutes;
    routes.push(pluginRoute("/demo", { handler: noContent }));
    let routeReads = 0;
    Object.defineProperty(registry, "httpRoutes", {
      configurable: true,
      get: () => {
        routeReads++;
        return routes;
      },
    });
    const runtimeState = await createGatewayRuntimeStateForTest(registry);
    const port = await listen(runtimeState);
    routeReads = 0;
    await expectHttpStatus(port, "/demo", 204);
    const firstRequestReads = routeReads;

    routeReads = 0;
    await expectHttpStatus(port, "/demo", 204);

    expect(firstRequestReads).toBe(routeReads + 1);
  });

  it("returns a retryable response for plugin paths until startup sidecars are ready", async () => {
    const startupRegistry = createEmptyPluginRegistry();
    let runtimeRegistry = startupRegistry;
    let sidecarsReady = false;
    const pluginHandler = vi.fn(noContent);
    const runtimeState = await createGatewayRuntimeStateForTest(startupRegistry, {
      getPluginRouteRegistry: () => runtimeRegistry,
      isStartupPluginRuntimeReady: () => sidecarsReady,
    });
    const port = await listen(runtimeState);
    const startingResponse = await fetch(`http://127.0.0.1:${port}/slack/events`);
    expect(startingResponse.status).toBe(503);
    expect(startingResponse.headers.get("retry-after")).toBe("1");
    expect(startingResponse.headers.get("cache-control")).toBe("no-store");
    expect(await startingResponse.text()).toBe("Plugin runtime is starting");
    expect(pluginHandler).not.toHaveBeenCalled();

    await expectHttpStatus(port, "/healthz", 200);

    const loadedRegistry = createEmptyPluginRegistry();
    loadedRegistry.httpRoutes.push(pluginRoute("/slack/events", { handler: pluginHandler }));
    runtimeRegistry = loadedRegistry;
    sidecarsReady = true;

    await expectHttpStatus(port, "/slack/events", 204);
    expect(pluginHandler).toHaveBeenCalledTimes(1);
  });

  it("keeps a loaded plugin upgrade handler on the current route registry", async () => {
    const { registry: startupRegistry, handler: startupUpgrade } = upgradeRegistry("startup");
    let runtimeRegistry = startupRegistry;
    const runtimeState = await createGatewayRuntimeStateForTest(startupRegistry, {
      getPluginRouteRegistry: () => runtimeRegistry,
    });
    const port = await listen(runtimeState);
    await expect(requestPluginUpgrade(port, "/demo")).resolves.toContain("101 Switching Protocols");
    expect(startupUpgrade).toHaveBeenCalledTimes(1);

    const { registry: replacementRegistry, handler: replacementUpgrade } =
      upgradeRegistry("replacement");
    runtimeRegistry = createEmptyPluginRegistry();
    await expect(requestPluginUpgrade(port, "/demo")).resolves.not.toContain(
      "101 Switching Protocols",
    );
    expect(startupUpgrade).toHaveBeenCalledTimes(1);

    runtimeRegistry = replacementRegistry;

    await expect(requestPluginUpgrade(port, "/demo")).resolves.toContain("101 Switching Protocols");
    expect(startupUpgrade).toHaveBeenCalledTimes(1);
    expect(replacementUpgrade).toHaveBeenCalledTimes(1);
  });

  it("fails startup when the required IPv4 loopback alias cannot bind", async () => {
    const warn = vi.fn();
    mocks.resolveGatewayListenHosts.mockResolvedValue(["100.64.0.1", "127.0.0.1"]);
    mocks.listenGatewayHttpServer.mockImplementation(async ({ bindHost }) => {
      if (bindHost === "127.0.0.1") {
        throw new Error("loopback occupied");
      }
    });
    const runtimeState = await createGatewayRuntimeStateForTest(undefined, {
      bindHost: "100.64.0.1",
      log: { info: () => {}, warn },
    });

    await expect(runtimeState.startListening()).rejects.toThrow("loopback occupied");
    await expect(runtimeState.startListening()).rejects.toThrow("loopback occupied");
    expectListen({ bindHost: "127.0.0.1", retryEaddrinuse: false }, 1);
    expect(mocks.listenGatewayHttpServer).toHaveBeenCalledTimes(1);
    expect(runtimeState.httpBindHosts).toEqual([]);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("failed to bind loopback alias"));
  });

  it("keeps the optional IPv6 loopback alias non-fatal", async () => {
    const warn = vi.fn();
    mocks.resolveGatewayListenHosts.mockResolvedValue(["127.0.0.1", "::1"]);
    mocks.listenGatewayHttpServer.mockImplementation(async ({ bindHost }) => {
      if (bindHost === "::1") {
        throw new Error("IPv6 unavailable");
      }
    });
    const runtimeState = await createGatewayRuntimeStateForTest(undefined, {
      log: { info: () => {}, warn },
      port: 18789,
    });

    await expect(runtimeState.startListening()).resolves.toBeUndefined();
    expect(runtimeState.httpBindHosts).toEqual(["127.0.0.1"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to bind loopback alias ::1"));
  });

  it("leaves ordinary ingress closed when managed Tailscale routing fails", async () => {
    const routeFailure = new Error("route claim failed");
    const runtimeState = await createGatewayRuntimeStateForTest(undefined, {
      port: 18789,
      tailscaleMode: "serve",
      prepareManagedTailscaleIngress: async () => {
        throw routeFailure;
      },
    });

    await expect(runtimeState.startListening()).rejects.toBe(routeFailure);
    expect(mocks.listenGatewayHttpServer).toHaveBeenCalledTimes(1);
    expectListen({ bindHost: "127.0.0.1", port: 0, serviceName: "Tailscale gateway ingress" });
    expect(runtimeState.httpBindHosts).toEqual([]);
  });

  it.each([undefined, 19100])(
    "starts the normal sandbox host with configured port %s",
    async (sandboxPort) => {
      const runtimeState = await createGatewayRuntimeStateForTest(undefined, {
        cfg: { mcp: { apps: { enabled: true, sandboxPort } } },
        port: 18789,
      });

      expect(runtimeState.getMcpAppSandboxPort()).toBeUndefined();
      await runtimeState.startListening();

      expect(runtimeState.getMcpAppSandboxPort()).toBe(sandboxPort ?? 18790);
      expect(runtimeState.httpServers).toHaveLength(2);
      expectListen({ bindHost: "127.0.0.1", port: 18789 }, 1);
      expectListen(
        { bindHost: "127.0.0.1", port: sandboxPort ?? 18790, retryEaddrinuse: false },
        2,
      );
    },
  );

  it("keeps an update canary off the configured sandbox listener, including lazy acquisition", async () => {
    const runtimeState = await createGatewayRuntimeStateForTest(undefined, {
      cfg: { mcp: { apps: { enabled: true, sandboxPort: 18790 } } },
      port: 19000,
      updateCanary: true,
    });

    await runtimeState.startListening();

    expect(runtimeState.getMcpAppSandboxPort()).toBeUndefined();
    expect(runtimeState.httpServers).toHaveLength(1);
    await expect(runtimeState.ensureSandboxHostPort()).rejects.toThrow(
      "Sandbox host is disabled during update validation",
    );
    expect(mocks.listenGatewayHttpServer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ bindHost: "127.0.0.1", port: 19000 }),
    );
  });

  it("waits for every gateway bind host before freezing lazy sandbox listeners", async () => {
    mocks.resolveGatewayListenHosts.mockResolvedValue(["127.0.0.1", "::1"]);
    const { promise: secondBind, resolve: releaseSecondBind } = createDeferred();
    mocks.listenGatewayHttpServer.mockImplementation(async ({ bindHost, port }) => {
      if (bindHost === "::1" && port === 18789) {
        await secondBind;
      }
    });
    const runtimeState = await createGatewayRuntimeStateForTest(undefined, { port: 18789 });

    const starting = runtimeState.startListening();
    await vi.waitFor(() => expectListen({ bindHost: "::1", port: 18789 }));
    const ensuring = runtimeState.ensureSandboxHostPort();
    await Promise.resolve();
    expect(mocks.listenGatewayHttpServer).not.toHaveBeenCalledWith(
      expect.objectContaining({ port: 18790 }),
    );

    releaseSecondBind();
    await starting;
    await expect(ensuring).resolves.toBe(18790);
    expectListen({ bindHost: "127.0.0.1", port: 18790 });
    expectListen({ bindHost: "::1", port: 18790 });
  });

  it("retries lazy sandbox startup after an occupied port clears", async () => {
    let sandboxPortOccupied = true;
    mocks.listenGatewayHttpServer.mockImplementation(async ({ port }) => {
      if (port === 18790 && sandboxPortOccupied) {
        sandboxPortOccupied = false;
        throw new Error("sandbox port occupied");
      }
    });
    const runtimeState = await createGatewayRuntimeStateForTest(undefined, { port: 18789 });

    await expect(runtimeState.startListening()).resolves.toBeUndefined();
    await expect(runtimeState.ensureSandboxHostPort()).rejects.toThrow("sandbox port occupied");
    expect(runtimeState.httpServers).toHaveLength(1);

    await expect(runtimeState.ensureSandboxHostPort()).resolves.toBe(18790);
    expect(runtimeState.getMcpAppSandboxPort()).toBe(18790);
    expect(runtimeState.httpServers).toHaveLength(2);
    expect(mocks.listenGatewayHttpServer).toHaveBeenCalledTimes(3);
  });
});
