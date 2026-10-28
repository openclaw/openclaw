import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createGatewayWsClient } from "../../scripts/lib/gateway-ws-client.js";

async function makeClient(handler?: (ws: WebSocket) => void, openTimeoutMs = 8000) {
  const server = createServer();
  const sockets = new Set<Duplex>();
  let wss: WebSocketServer | undefined;
  let client: ReturnType<typeof createGatewayWsClient> | null = null;
  let closing = false;
  onTestFinished(async () => {
    closing = true;
    client?.close();
    // Join both peers and TCP sockets, including after a failed assertion.
    for (const peer of wss?.clients ?? []) {
      peer.terminate();
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    if (wss) {
      await promisify(wss.close.bind(wss))();
    }
    await promisify(server.close.bind(server))();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (closing) {
      socket.destroy();
    }
  });
  if (handler) {
    wss = new WebSocketServer({ server });
    wss.on("connection", handler);
  } else {
    // Leave upgrades open to exercise pre-handshake close and timeout paths.
    server.on("upgrade", () => {});
  }
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test websocket server did not get a TCP address");
  }
  client = createGatewayWsClient({
    url: `ws://127.0.0.1:${address.port}`,
    openTimeoutMs,
  });
  return client;
}

describe("createGatewayWsClient", () => {
  it.each([
    ["client closes", "gateway websocket client closed"],
    ["gateway closes", "gateway websocket closed (1011): boom"],
    ["socket errors", "socket exploded"],
  ])("rejects pending RPC requests when the %s", async (cause, error) => {
    const client = await makeClient((ws) => {
      if (cause === "gateway closes") {
        ws.on("message", () => ws.close(1011, "boom"));
      }
    });
    await client.waitOpen();
    const pending = client.request("health", {}, 1000);
    if (cause === "client closes") {
      client.close();
    } else if (cause === "socket errors") {
      client.ws.emit("error", new Error(error));
    }
    await expect(pending).rejects.toThrow(error);
  });

  it("rejects websocket closes before opening", async () => {
    const client = await makeClient(undefined, 1000);
    const opened = client.waitOpen();

    client.ws.emit("close", 1006, Buffer.from("bye"));

    await expect(opened).rejects.toThrow("closed before open (1006): bye");
  });

  it("terminates stalled websocket handshakes after the open timeout", async () => {
    const client = await makeClient(undefined, 5);
    await expect(client.waitOpen()).rejects.toThrow("ws open timeout");
    await vi.waitFor(() => expect(client.ws.readyState).toBe(WebSocket.CLOSED), {
      timeout: 1_000,
      interval: 10,
    });
  });
});
