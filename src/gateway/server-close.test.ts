import type { Server as HttpServer } from "node:http";
import type { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import { createGatewayCloseHandler } from "./server-close.js";

function makeFakeWs(extra?: { terminateFn?: ReturnType<typeof vi.fn> }) {
  const terminate = extra?.terminateFn ?? vi.fn();
  return {
    terminate,
    close: vi.fn(),
  };
}

function makeWss(clients: ReturnType<typeof makeFakeWs>[] = []) {
  const wssClients = new Set(clients);
  return {
    clients: wssClients,
    close: vi.fn((cb: () => void) => {
      // Simulate wss completing immediately (all clients are gone or terminated).
      cb();
    }),
  } as unknown as WebSocketServer;
}

function makeHttpServer(opts?: { closeAllConnections?: boolean }) {
  const closeAllConnections = opts?.closeAllConnections !== false ? vi.fn() : undefined;
  const closeIdleConnections = vi.fn();
  return {
    close: vi.fn((cb: (err?: Error) => void) => cb()),
    closeAllConnections,
    closeIdleConnections,
  } as unknown as HttpServer & {
    closeIdleConnections?: () => void;
    closeAllConnections?: () => void;
  };
}

type CloseHandlerParams = Parameters<typeof createGatewayCloseHandler>[0];

function buildMinimalParams(overrides?: {
  wss?: WebSocketServer;
  httpServer?: ReturnType<typeof makeHttpServer>;
}): CloseHandlerParams {
  const wss = overrides?.wss ?? makeWss();
  const httpServer = overrides?.httpServer ?? makeHttpServer();
  return {
    bonjourStop: null,
    tailscaleCleanup: null,
    canvasHost: null,
    canvasHostServer: null,
    stopChannel: vi.fn(async () => {}),
    pluginServices: null,
    cron: { stop: vi.fn() },
    heartbeatRunner: { stop: vi.fn() },
    updateCheckStop: null,
    nodePresenceTimers: new Map(),
    broadcast: vi.fn(),
    tickInterval: setInterval(() => {}, 1_000_000),
    healthInterval: setInterval(() => {}, 1_000_000),
    dedupeCleanup: setInterval(() => {}, 1_000_000),
    agentUnsub: null,
    heartbeatUnsub: null,
    chatRunState: { clear: vi.fn() },
    clients: new Set<{ socket: { close: (code: number, reason: string) => void } }>(),
    configReloader: { stop: vi.fn(async () => {}) },
    browserControl: null,
    wss,
    httpServer: httpServer as unknown as HttpServer,
  } as unknown as CloseHandlerParams;
}

describe("createGatewayCloseHandler — wss.clients termination", () => {
  it("terminates all wss.clients connections before wss.close() to prevent restart-loop hang", async () => {
    const ws1 = makeFakeWs();
    const ws2 = makeFakeWs();
    const terminateOrder: string[] = [];

    ws1.terminate.mockImplementation(() => {
      terminateOrder.push("ws1.terminate");
    });
    ws2.terminate.mockImplementation(() => {
      terminateOrder.push("ws2.terminate");
    });

    const wss = makeWss([ws1, ws2]);
    const wssCloseOrder: string[] = [];
    wss.close = vi.fn((cb: () => void) => {
      wssCloseOrder.push("wss.close");
      cb();
    });

    const params = buildMinimalParams({ wss });
    const handler = createGatewayCloseHandler(params);
    await handler({ reason: "gateway restarting", restartExpectedMs: 1500 });

    // All clients must be terminated before wss.close() is called.
    expect(ws1.terminate).toHaveBeenCalledOnce();
    expect(ws2.terminate).toHaveBeenCalledOnce();
    expect(wss.close).toHaveBeenCalledOnce();
    expect(terminateOrder).toEqual(["ws1.terminate", "ws2.terminate"]);
    expect(wssCloseOrder).toEqual(["wss.close"]);
  });

  it("calls terminate even when wss.clients has connections not in params.clients", async () => {
    // A connection that arrived during the close sequence (e.g. upgrade handshake)
    // may be in wss.clients but not yet added to params.clients.
    const orphanWs = makeFakeWs();
    const wss = makeWss([orphanWs]);
    const params = buildMinimalParams({ wss });
    // params.clients is intentionally empty here

    const handler = createGatewayCloseHandler(params);
    await handler();

    expect(orphanWs.terminate).toHaveBeenCalledOnce();
  });

  it("tolerates terminate() throwing without aborting the shutdown", async () => {
    const faultyWs = makeFakeWs({
      terminateFn: vi.fn(() => {
        throw new Error("socket already destroyed");
      }),
    });
    const wss = makeWss([faultyWs]);
    const params = buildMinimalParams({ wss });

    const handler = createGatewayCloseHandler(params);
    // Should not throw
    await expect(handler()).resolves.toBeUndefined();
    expect(faultyWs.terminate).toHaveBeenCalledOnce();
  });

  it("calls closeAllConnections on httpServer when available", async () => {
    const httpServer = makeHttpServer({ closeAllConnections: true });
    const params = buildMinimalParams({ httpServer });

    const handler = createGatewayCloseHandler(params);
    await handler();

    expect(httpServer.closeAllConnections).toHaveBeenCalledOnce();
    expect(httpServer.closeIdleConnections).not.toHaveBeenCalled();
  });

  it("falls back to closeIdleConnections when closeAllConnections is unavailable", async () => {
    const httpServer = makeHttpServer({ closeAllConnections: false });
    const params = buildMinimalParams({ httpServer });

    const handler = createGatewayCloseHandler(params);
    await handler();

    expect(httpServer.closeIdleConnections).toHaveBeenCalledOnce();
  });
});
