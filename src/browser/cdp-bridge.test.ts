import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type WebSocket as WsClient, WebSocketServer } from "ws";
import { rawDataToString } from "../infra/ws.js";
import {
  rewriteCdpBridgePayload,
  startLocalCdpBridge,
  type LocalCdpBridgeServer,
} from "./cdp-bridge.js";

describe("cdp bridge", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      await close?.();
    }
  });

  async function closeHttpServer(server: HttpServer): Promise<void> {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 250)),
    ]);
  }

  async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
    for (const client of server.clients) {
      try {
        client.terminate();
      } catch {
        // ignore
      }
    }
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 250)),
    ]);
  }

  async function withWebSocket<T>(url: string, fn: (socket: WsClient) => Promise<T>): Promise<T> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    try {
      return await fn(socket);
    } finally {
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close();
      });
    }
  }

  it("forwards HTTP browserUrl requests through the bridge", async () => {
    const upstreamWss = new WebSocketServer({ noServer: true });
    const upstreamHttp = createServer((req, res) => {
      if (req.url === "/json/version") {
        const { port } = upstreamHttp.address() as { port: number };
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            Browser: "Chrome",
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/UPSTREAM`,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    upstreamHttp.on("upgrade", (req, socket, head) => {
      upstreamWss.handleUpgrade(req, socket, head, (ws) => {
        upstreamWss.emit("connection", ws, req);
      });
    });
    await new Promise<void>((resolve) => upstreamHttp.listen(0, "127.0.0.1", resolve));
    closers.push(
      async () => await closeWebSocketServer(upstreamWss),
      async () => await closeHttpServer(upstreamHttp),
    );

    const { port: upstreamPort } = upstreamHttp.address() as { port: number };
    const bridge = await startLocalCdpBridge({
      upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
      bindHost: "127.0.0.1",
      port: 0,
    });
    closers.push(bridge.stop);

    const res = await fetch(`${bridge.baseUrl}/json/version`);
    const payload = (await res.json()) as { Browser: string; webSocketDebuggerUrl: string };

    expect(payload.Browser).toBe("Chrome");
    expect(payload.webSocketDebuggerUrl).toContain("/devtools/browser/UPSTREAM");
  });

  it("rewrites websocket debugger URLs to the local bridge endpoint", () => {
    const payload = rewriteCdpBridgePayload({
      payload: {
        Browser: "Chrome",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/UPSTREAM",
      },
      upstreamUrl: "http://127.0.0.1:9222",
      localHttpBaseUrl: "http://127.0.0.1:18794",
    }) as { webSocketDebuggerUrl: string };

    expect(payload.webSocketDebuggerUrl).toBe("ws://127.0.0.1:18794/devtools/browser/UPSTREAM");
  });

  it("forwards websocket traffic for HTTP browserUrl upstreams", async () => {
    const upstreamWss = new WebSocketServer({ noServer: true });
    const upstreamHttp = createServer((_req, res) => {
      res.statusCode = 404;
      res.end("not found");
    });
    upstreamHttp.on("upgrade", (req, socket, head) => {
      upstreamWss.handleUpgrade(req, socket, head, (ws) => {
        upstreamWss.emit("connection", ws, req);
      });
    });
    upstreamWss.on("connection", (socket) => {
      socket.on("message", (data) => {
        socket.send(`upstream:${rawDataToString(data)}`);
      });
    });
    await new Promise<void>((resolve) => upstreamHttp.listen(0, "127.0.0.1", resolve));
    closers.push(
      async () => await closeWebSocketServer(upstreamWss),
      async () => await closeHttpServer(upstreamHttp),
    );

    const { port: upstreamPort } = upstreamHttp.address() as { port: number };
    const bridge = await startLocalCdpBridge({
      upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
      bindHost: "127.0.0.1",
      port: 0,
    });
    closers.push(bridge.stop);

    const reply = await withWebSocket(
      `ws://127.0.0.1:${bridge.port}/devtools/browser/UPSTREAM`,
      async (socket) =>
        await new Promise<string>((resolve, reject) => {
          socket.once("message", (data) => resolve(rawDataToString(data)));
          socket.once("error", reject);
          socket.send("ping");
        }),
    );

    expect(reply).toBe("upstream:ping");
  });

  it("forwards websocket traffic for direct wsEndpoint upstreams", async () => {
    const upstreamWss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    upstreamWss.on("connection", (socket) => {
      socket.on("message", (data) => {
        socket.send(`direct:${rawDataToString(data)}`);
      });
    });
    await new Promise<void>((resolve) => upstreamWss.once("listening", resolve));
    closers.push(async () => await closeWebSocketServer(upstreamWss));

    const upstreamPort = (upstreamWss.address() as { port: number }).port;
    const bridge: LocalCdpBridgeServer = await startLocalCdpBridge({
      upstreamUrl: `ws://127.0.0.1:${upstreamPort}/devtools/browser/DIRECT`,
      bindHost: "127.0.0.1",
      port: 0,
    });
    closers.push(bridge.stop);

    const reply = await withWebSocket(
      `ws://127.0.0.1:${bridge.port}/devtools/browser/DIRECT`,
      async (socket) =>
        await new Promise<string>((resolve, reject) => {
          socket.once("message", (data) => resolve(rawDataToString(data)));
          socket.once("error", reject);
          socket.send("pong");
        }),
    );

    expect(reply).toBe("direct:pong");
  });
});
