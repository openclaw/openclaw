import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { rawDataToString } from "../infra/ws.js";
import { createTargetViaCdp, evaluateJavaScript, normalizeCdpWsUrl, snapshotAria } from "./cdp.js";

describe("cdp", () => {
  let httpServer: ReturnType<typeof createServer> | null = null;
  let wsServer: WebSocketServer | null = null;

  const startWsServer = async () => {
    wsServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wsServer?.once("listening", resolve));
    return (wsServer.address() as { port: number }).port;
  };

  const startWsServerWithMessages = async (
    onMessage: (
      msg: { id?: number; method?: string; params?: Record<string, unknown> },
      socket: WebSocket,
    ) => void,
  ) => {
    const wsPort = await startWsServer();
    if (!wsServer) {
      throw new Error("ws server not initialized");
    }
    wsServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(rawDataToString(data)) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
        };
        onMessage(msg, socket);
      });
    });
    return wsPort;
  };

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!httpServer) {
        return resolve();
      }
      httpServer.close(() => resolve());
      httpServer = null;
    });
    await new Promise<void>((resolve) => {
      if (!wsServer) {
        return resolve();
      }
      wsServer.close(() => resolve());
      wsServer = null;
    });
  });

  it("creates a target via the browser websocket", async () => {
    const wsPort = await startWsServerWithMessages((msg, socket) => {
      if (msg.method !== "Target.createTarget") {
        return;
      }
      socket.send(
        JSON.stringify({
          id: msg.id,
          result: { targetId: "TARGET_123" },
        }),
      );
    });

    httpServer = createServer((req, res) => {
      if (req.url === "/json/version") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/browser/TEST`,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });

    await new Promise<void>((resolve) => httpServer?.listen(0, "127.0.0.1", resolve));
    const httpPort = (httpServer.address() as { port: number }).port;

    const created = await createTargetViaCdp({
      cdpUrl: `http://127.0.0.1:${httpPort}`,
      url: "https://example.com",
    });

    expect(created.targetId).toBe("TARGET_123");
  });

  it("blocks private navigation targets by default", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await expect(
        createTargetViaCdp({
          cdpUrl: "http://127.0.0.1:9222",
          url: "http://127.0.0.1:8080",
        }),
      ).rejects.toBeInstanceOf(SsrFBlockedError);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("allows private navigation targets when explicitly configured", async () => {
    const wsPort = await startWsServerWithMessages((msg, socket) => {
      if (msg.method !== "Target.createTarget") {
        return;
      }
      expect(msg.params?.url).toBe("http://127.0.0.1:8080");
      socket.send(
        JSON.stringify({
          id: msg.id,
          result: { targetId: "TARGET_LOCAL" },
        }),
      );
    });

    httpServer = createServer((req, res) => {
      if (req.url === "/json/version") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/browser/TEST`,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });

    await new Promise<void>((resolve) => httpServer?.listen(0, "127.0.0.1", resolve));
    const httpPort = (httpServer.address() as { port: number }).port;

    const created = await createTargetViaCdp({
      cdpUrl: `http://127.0.0.1:${httpPort}`,
      url: "http://127.0.0.1:8080",
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(created.targetId).toBe("TARGET_LOCAL");
  });

  it("evaluates javascript via CDP", async () => {
    const wsPort = await startWsServerWithMessages((msg, socket) => {
      if (msg.method === "Runtime.enable") {
        socket.send(JSON.stringify({ id: msg.id, result: {} }));
        return;
      }
      if (msg.method === "Runtime.evaluate") {
        expect(msg.params?.expression).toBe("1+1");
        socket.send(
          JSON.stringify({
            id: msg.id,
            result: { result: { type: "number", value: 2 } },
          }),
        );
      }
    });

    const res = await evaluateJavaScript({
      wsUrl: `ws://127.0.0.1:${wsPort}`,
      expression: "1+1",
    });

    expect(res.result.type).toBe("number");
    expect(res.result.value).toBe(2);
  });

  it("captures an aria snapshot via CDP", async () => {
    const wsPort = await startWsServerWithMessages((msg, socket) => {
      if (msg.method === "Accessibility.enable") {
        socket.send(JSON.stringify({ id: msg.id, result: {} }));
        return;
      }
      if (msg.method === "Accessibility.getFullAXTree") {
        socket.send(
          JSON.stringify({
            id: msg.id,
            result: {
              nodes: [
                {
                  nodeId: "1",
                  role: { value: "RootWebArea" },
                  name: { value: "" },
                  childIds: ["2"],
                },
                {
                  nodeId: "2",
                  role: { value: "button" },
                  name: { value: "OK" },
                  backendDOMNodeId: 42,
                  childIds: [],
                },
              ],
            },
          }),
        );
      }
    });

    const snap = await snapshotAria({ wsUrl: `ws://127.0.0.1:${wsPort}` });
    expect(snap.nodes.length).toBe(2);
    expect(snap.nodes[0]?.role).toBe("RootWebArea");
    expect(snap.nodes[1]?.role).toBe("button");
    expect(snap.nodes[1]?.name).toBe("OK");
    expect(snap.nodes[1]?.backendDOMNodeId).toBe(42);
    expect(snap.nodes[1]?.depth).toBe(1);
  });

  it("normalizes loopback websocket URLs for remote CDP hosts", () => {
    const normalized = normalizeCdpWsUrl(
      "ws://127.0.0.1:9222/devtools/browser/ABC",
      "http://example.com:9222",
    );
    expect(normalized).toBe("ws://example.com:9222/devtools/browser/ABC");
  });

  it("propagates auth and query params onto normalized websocket URLs", () => {
    const normalized = normalizeCdpWsUrl(
      "ws://127.0.0.1:9222/devtools/browser/ABC",
      "https://user:pass@example.com?token=abc",
    );
    expect(normalized).toBe("wss://user:pass@example.com/devtools/browser/ABC?token=abc");
  });

  it("upgrades ws to wss when CDP uses https", () => {
    const normalized = normalizeCdpWsUrl(
      "ws://production-sfo.browserless.io",
      "https://production-sfo.browserless.io?token=abc",
    );
    expect(normalized).toBe("wss://production-sfo.browserless.io/?token=abc");
  });
});
