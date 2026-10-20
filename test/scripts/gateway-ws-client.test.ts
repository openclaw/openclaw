import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createGatewayWsClient } from "../../scripts/lib/gateway-ws-client.js";

let server: Server | undefined;
let wss: WebSocketServer | undefined;

afterEach(async () => {
  // A failed assertion can skip client.close(); wss.close() waits for those peers.
  for (const client of wss?.clients ?? []) {
    client.terminate();
  }
  if (wss) {
    await new Promise<void>((resolve) => {
      wss!.close(() => resolve());
    });
  }
  wss = undefined;
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
    });
  }
  server = undefined;
});

async function listen(handler: (ws: WebSocket) => void): Promise<string> {
  server = createServer();
  wss = new WebSocketServer({ server });
  wss.on("connection", handler);
  return listenServer(server);
}

async function listenServer(httpServer: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("test websocket server did not get a TCP address");
  }
  return `ws://127.0.0.1:${address.port}`;
}

async function openClient(handler: (ws: WebSocket) => void = () => {}) {
  const client = createGatewayWsClient({ url: await listen(handler) });
  await client.waitOpen();
  return client;
}

async function listenStalledUpgrade(): Promise<{ close: () => Promise<void>; url: string }> {
  const stalledServer = createServer();
  const sockets = new Set<Duplex>();
  let closing = false;
  stalledServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
    if (closing) {
      socket.destroy();
    }
  });
  stalledServer.on("upgrade", (_req, socket) => {
    // Keep the socket open without completing the websocket handshake.
    sockets.add(socket);
    if (closing) {
      socket.destroy();
    }
  });
  const url = await listenServer(stalledServer);
  return {
    close: async () => {
      closing = true;
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        stalledServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
    url,
  };
}

describe("createGatewayWsClient", () => {
  it("rejects pending RPC requests when the client closes", async () => {
    const client = await openClient();

    const pending = client.request("health", {}, 1000);
    client.close();

    await expect(pending).rejects.toThrow("gateway websocket client closed");
  });

  it("rejects pending RPC requests when the gateway closes the socket", async () => {
    const client = await openClient((ws) => {
      ws.on("message", () => {
        ws.close(1011, "boom");
      });
    });

    await expect(client.request("health", {}, 1000)).rejects.toThrow(
      "gateway websocket closed (1011): boom",
    );
    client.close();
  });

  it("rejects pending RPC requests when the socket errors", async () => {
    const client = await openClient();

    const pending = client.request("health", {}, 1000);
    client.ws.emit("error", new Error("socket exploded"));

    await expect(pending).rejects.toThrow("socket exploded");
    client.close();
  });

  it("rejects websocket closes before opening", async () => {
    const stalled = await listenStalledUpgrade();
    const client = createGatewayWsClient({ openTimeoutMs: 1000, url: stalled.url });
    const opened = client.waitOpen();

    client.ws.emit("close", 1006, Buffer.from("bye"));

    try {
      await expect(opened).rejects.toThrow("closed before open (1006): bye");
    } finally {
      client.close();
      await stalled.close();
    }
  });

  it("terminates stalled websocket handshakes after the open timeout", async () => {
    const stalled = await listenStalledUpgrade();
    const client = createGatewayWsClient({ openTimeoutMs: 5, url: stalled.url });
    try {
      await expect(client.waitOpen()).rejects.toThrow("ws open timeout");
      await waitFor(() => client.ws.readyState === WebSocket.CLOSED);
    } finally {
      client.close();
      await stalled.close();
    }
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}
