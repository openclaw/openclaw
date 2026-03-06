import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignalSocketClient, type SignalSocketEvent } from "./socket-client.js";

/** Create a TCP server that speaks line-delimited JSON-RPC. */
function createMockServer() {
  const connections: net.Socket[] = [];
  const server = net.createServer((socket) => {
    connections.push(socket);
    socket.on("close", () => {
      const idx = connections.indexOf(socket);
      if (idx !== -1) {
        connections.splice(idx, 1);
      }
    });
  });

  const listen = (): Promise<number> =>
    new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as net.AddressInfo;
        resolve(addr.port);
      });
    });

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      for (const c of connections) {
        c.destroy();
      }
      server.close(() => resolve());
    });

  /** Set a handler that auto-replies to JSON-RPC requests. */
  const onRequest = (
    handler: (req: { id: string; method: string; params: unknown }) => unknown,
  ) => {
    server.on("connection", (socket) => {
      let buf = "";
      socket.on("data", (data) => {
        buf += data.toString("utf8");
        let idx = buf.indexOf("\n");
        while (idx !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) {
            try {
              const req = JSON.parse(line) as {
                id: string;
                method: string;
                params: unknown;
              };
              const result = handler(req);
              const response = JSON.stringify({
                jsonrpc: "2.0",
                result,
                id: req.id,
              });
              socket.write(`${response}\n`);
            } catch {
              // ignore parse errors in test
            }
          }
          idx = buf.indexOf("\n");
        }
      });
    });
  };

  /** Send a JSON-RPC notification (no id) to all connected clients. */
  const sendNotification = (method: string, params: unknown) => {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    for (const c of connections) {
      c.write(msg);
    }
  };

  /** Disconnect all connected clients. */
  const disconnectAll = () => {
    for (const c of connections) {
      c.destroy();
    }
  };

  return { server, listen, close, onRequest, sendNotification, disconnectAll, connections };
}

/** Wait until the mock server has at least `n` connections. */
async function waitForConnections(
  mock: ReturnType<typeof createMockServer>,
  n = 1,
  timeoutMs = 500,
): Promise<void> {
  const start = Date.now();
  while (mock.connections.length < n) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${n} server connections`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("SignalSocketClient", () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let client: SignalSocketClient;
  let port: number;

  beforeEach(async () => {
    mockServer = createMockServer();
    port = await mockServer.listen();
  });

  afterEach(async () => {
    client?.close();
    await mockServer.close();
  });

  it("connects and resolves a single request", async () => {
    mockServer.onRequest((req) => {
      expect(req.method).toBe("send");
      return { timestamp: 12345 };
    });

    client = new SignalSocketClient({
      host: "127.0.0.1",
      port,
      reconnect: false,
    });
    client.connect();
    await client.waitForConnect();

    const result = await client.request<{ timestamp: number }>("send", {
      recipient: ["+15550001111"],
      message: "hello",
    });
    expect(result).toEqual({ timestamp: 12345 });
  });

  it("handles concurrent requests with correct correlation", async () => {
    mockServer.onRequest((req) => {
      if (req.method === "send") {
        return { timestamp: 1 };
      }
      if (req.method === "sendTyping") {
        return { ok: true };
      }
      return null;
    });

    client = new SignalSocketClient({
      host: "127.0.0.1",
      port,
      reconnect: false,
    });
    client.connect();
    await client.waitForConnect();

    const [sendResult, typingResult] = await Promise.all([
      client.request<{ timestamp: number }>("send", { message: "hi" }),
      client.request<{ ok: boolean }>("sendTyping", { recipient: "+15550001111" }),
    ]);

    expect(sendResult).toEqual({ timestamp: 1 });
    expect(typingResult).toEqual({ ok: true });
  });

  it("receives event notifications interleaved with responses", async () => {
    const events: SignalSocketEvent[] = [];
    // Set up server that sends a notification between responses
    mockServer.server.on("connection", (socket) => {
      let buf = "";
      let reqCount = 0;
      socket.on("data", (data) => {
        buf += data.toString("utf8");
        let idx = buf.indexOf("\n");
        while (idx !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) {
            try {
              const req = JSON.parse(line) as { id: string; method: string };
              reqCount++;
              if (reqCount === 1) {
                // Send a notification before the response
                socket.write(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    method: "receive",
                    params: { envelope: { source: "+15550009999" } },
                  }) + "\n",
                );
              }
              // Then send the response
              socket.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  result: { ok: true },
                  id: req.id,
                }) + "\n",
              );
            } catch {
              // ignore
            }
          }
          idx = buf.indexOf("\n");
        }
      });
    });

    client = new SignalSocketClient({
      host: "127.0.0.1",
      port,
      reconnect: false,
      onEvent: (event) => events.push(event),
    });
    client.connect();
    await client.waitForConnect();

    const result = await client.request("send", { message: "test" });
    expect(result).toEqual({ ok: true });

    // Give the event a tick to be processed
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(1);
    expect(events[0].method).toBe("receive");
    expect(events[0].params).toEqual({ envelope: { source: "+15550009999" } });
  });

  it("rejects pending requests on timeout", async () => {
    // Server that never responds
    client = new SignalSocketClient({
      host: "127.0.0.1",
      port,
      reconnect: false,
    });
    client.connect();
    await client.waitForConnect();

    await expect(client.request("send", { message: "test" }, { timeoutMs: 50 })).rejects.toThrow(
      /timed out/,
    );
  });

  it("rejects all pending requests when connection drops", async () => {
    // No onRequest handler — server never responds, so the request stays pending
    client = new SignalSocketClient({
      host: "127.0.0.1",
      port,
      reconnect: false,
    });
    client.connect();
    await client.waitForConnect();
    await waitForConnections(mockServer);

    const promise = client.request("send", { message: "test" }, { timeoutMs: 5000 });

    // Give the write time to flush, then disconnect
    await new Promise((r) => setTimeout(r, 20));
    mockServer.disconnectAll();

    await expect(promise).rejects.toThrow(/connection lost/);
  });

  it("reconnects after disconnect when reconnect is enabled", async () => {
    let connectCount = 0;
    let disconnectCount = 0;
    mockServer.onRequest(() => ({ ok: true }));

    client = new SignalSocketClient({
      host: "127.0.0.1",
      port,
      reconnect: true,
      reconnectPolicy: { initialMs: 50, maxMs: 100, factor: 1, jitter: 0 },
      onConnect: () => {
        connectCount++;
      },
      onDisconnect: () => {
        disconnectCount++;
      },
    });
    client.connect();
    await client.waitForConnect();
    // Ensure server has the connection registered before we try to disconnect
    await waitForConnections(mockServer, 1);
    expect(connectCount).toBe(1);

    // Disconnect and wait for the close event to propagate
    mockServer.disconnectAll();
    while (client.isConnected) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(disconnectCount).toBe(1);

    // Wait for reconnection (backoff + connect)
    await client.waitForConnect();
    expect(connectCount).toBe(2);
    expect(client.isConnected).toBe(true);

    // Verify requests work after reconnect
    await waitForConnections(mockServer, 1);
    const result = await client.request("check", {});
    expect(result).toEqual({ ok: true });
  }, 10_000);

  it("rejects request when not connected", async () => {
    client = new SignalSocketClient({
      host: "127.0.0.1",
      port,
      reconnect: false,
    });
    // Don't call connect()

    await expect(client.request("send", {})).rejects.toThrow(/not connected/);
  });

  it("rejects request when closed", async () => {
    client = new SignalSocketClient({
      host: "127.0.0.1",
      port,
      reconnect: false,
    });
    client.connect();
    await client.waitForConnect();
    client.close();

    await expect(client.request("send", {})).rejects.toThrow(/closed/);
  });

  it("handles RPC error responses", async () => {
    mockServer.server.on("connection", (socket) => {
      let buf = "";
      socket.on("data", (data) => {
        buf += data.toString("utf8");
        let idx = buf.indexOf("\n");
        while (idx !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) {
            try {
              const req = JSON.parse(line) as { id: string };
              socket.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  error: { code: -32000, message: "rate limit exceeded" },
                  id: req.id,
                }) + "\n",
              );
            } catch {
              // ignore
            }
          }
          idx = buf.indexOf("\n");
        }
      });
    });

    client = new SignalSocketClient({
      host: "127.0.0.1",
      port,
      reconnect: false,
    });
    client.connect();
    await client.waitForConnect();

    await expect(client.request("send", {})).rejects.toThrow(/rate limit exceeded/);
  });

  it("waitForConnect resolves immediately when already connected", async () => {
    mockServer.onRequest(() => ({ ok: true }));
    client = new SignalSocketClient({
      host: "127.0.0.1",
      port,
      reconnect: false,
    });
    client.connect();
    await client.waitForConnect();

    // Second call should resolve immediately
    await client.waitForConnect();
    expect(client.isConnected).toBe(true);
  });

  it("waitForConnect rejects on abort", async () => {
    // Close the server so connection hangs
    await mockServer.close();

    client = new SignalSocketClient({
      host: "127.0.0.1",
      port: 1, // unreachable port
      reconnect: false,
    });
    client.connect();

    const controller = new AbortController();
    const promise = client.waitForConnect(controller.signal);
    controller.abort();

    await expect(promise).rejects.toThrow(/aborted/);
  });

  it("onEvent can be reassigned after construction", async () => {
    const events1: SignalSocketEvent[] = [];
    const events2: SignalSocketEvent[] = [];

    client = new SignalSocketClient({
      host: "127.0.0.1",
      port,
      reconnect: false,
      onEvent: (e) => events1.push(e),
    });
    client.connect();
    await client.waitForConnect();
    await waitForConnections(mockServer);

    mockServer.sendNotification("receive", { msg: "first" });
    await new Promise((r) => setTimeout(r, 30));
    expect(events1).toHaveLength(1);

    // Reassign onEvent
    client.onEvent = (e) => events2.push(e);
    mockServer.sendNotification("receive", { msg: "second" });
    await new Promise((r) => setTimeout(r, 30));
    expect(events1).toHaveLength(1); // No new events on old handler
    expect(events2).toHaveLength(1);
    expect(events2[0].params).toEqual({ msg: "second" });
  });
});
