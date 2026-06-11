// Integration test for keepalive over REAL ws sockets (real ping/pong frames,
// real timers, real TCP on loopback). A connected-but-silent peer is simulated
// with client.pause(): the TCP connection stays ESTABLISHED but the client
// never reads the ping, so it never auto-pongs — exactly a half-open/dead peer.
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { startKeepAlive } from "../ws-connection.keepalive.js";

describe("keepalive integration (real ws sockets)", () => {
  let wss: WebSocketServer | undefined;
  let client: WebSocket | undefined;

  afterEach(async () => {
    client?.removeAllListeners();
    try {
      client?.terminate();
    } catch {
      /* already gone */
    }
    if (wss) {
      for (const c of wss.clients) {
        c.terminate();
      }
      await new Promise<void>((resolve) => {
        wss?.close(() => resolve());
      });
    }
    wss = undefined;
    client = undefined;
  });

  function startServer(onConnection: (socket: WebSocket) => void): Promise<number> {
    wss = new WebSocketServer({ port: 0 });
    wss.on("connection", onConnection);
    return new Promise<number>((resolve) => {
      wss?.on("listening", () => {
        const address = wss?.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
  }

  it("flags a connected-but-silent client as unresponsive within ~interval+timeout", async () => {
    const becameUnresponsive = new Promise<void>((resolve) => {
      void startServer((serverSocket) => {
        const handle = startKeepAlive(serverSocket, { intervalMs: 120, timeoutMs: 80 }, () =>
          resolve(),
        );
        serverSocket.on("close", () => handle.stop());
      }).then((port) => {
        client = new WebSocket(`ws://127.0.0.1:${port}`);
        client.on("open", () => {
          // Stop reading: TCP stays open, but the ping is never processed and
          // no auto-pong is sent — the gateway must detect this.
          client?.pause();
        });
      });
    });

    await becameUnresponsive; // resolves only if keepalive fired over a real socket
  }, 5000);

  it("keeps a responsive client open across several ping intervals", async () => {
    let unresponsive = false;
    const port = await startServer((serverSocket) => {
      const handle = startKeepAlive(serverSocket, { intervalMs: 60, timeoutMs: 40 }, () => {
        unresponsive = true;
      });
      serverSocket.on("close", () => handle.stop());
    });

    client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => {
      client?.on("open", () => resolve());
    });

    // A real client auto-pongs; it must stay open well past several intervals.
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });

    expect(unresponsive).toBe(false);
    expect(client.readyState).toBe(WebSocket.OPEN);
  }, 5000);
});
