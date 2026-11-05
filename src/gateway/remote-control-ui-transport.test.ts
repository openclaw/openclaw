import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "../../packages/gateway-client/src/websocket.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewayControlUiIngressRequestV1 } from "../plugins/gateway-ingress.types.js";
import { markGatewayIngressTransport, readGatewayIngressTransport } from "./ingress-attribution.js";
import type { GatewayControlUiIngressHost } from "./remote-control-ui-ingress-host.js";
import { createRemoteControlUiTransport } from "./remote-control-ui-transport.js";
import { createRemoteControlUiIngressTestContext } from "./remote-control-ui.test-support.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import type { RemoteControlUiIngressContext } from "./server/client-identity-types.js";
import { startWebSocketKeepalive } from "./websocket-keepalive.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

function websocketServer() {
  const server = new WebSocketServer({ noServer: true, maxPayload: MAX_PREAUTH_PAYLOAD_BYTES });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  return server;
}

const websocketRequest = {
  pathAndQuery: "/claw",
  origin: "https://ui.example.test",
  protocols: [],
  signal: new AbortController().signal,
};

function fixture(overrides: Partial<GatewayControlUiIngressHost> = {}) {
  let current = true;
  const context = createRemoteControlUiIngressTestContext({
    pluginId: "test-ingress",
    audienceId: "test-audience",
    publicOrigin: "https://ui.example.test",
    sandboxOrigin: "https://sandbox.example.test",
    operatorScopeCeiling: ["operator.read", "operator.write"],
    frameAncestors: ["https://chat.example.test"],
    signal: new AbortController().signal,
    assertCurrent() {
      if (!current) {
        throw new Error("Grant revoked");
      }
    },
  });
  const host: GatewayControlUiIngressHost = {
    signal: new AbortController().signal,
    controlUiBasePath: "/claw",
    getRuntimeConfig: () => ({}),
    getResolvedAuth: () => ({
      mode: "token",
      token: "synthetic-test-token",
      allowTailscale: false,
    }),
    handleRequest: async (_req, res) => {
      res.end("control-ui");
    },
    handleSandboxRequest: async (_req, res) => {
      res.end("sandbox-only");
    },
    handleUpgrade: async (_req, socket) => {
      socket.destroy();
    },
    ...overrides,
  };
  const transport = createRemoteControlUiTransport({ context, host });
  cleanups.push(() => transport.close());
  const input: GatewayControlUiIngressRequestV1 = {
    surface: "control-ui",
    method: "GET",
    pathAndQuery: "/claw/",
    headers: [["host", "ui.example.test"]],
    signal: new AbortController().signal,
  };
  return {
    transport,
    input,
    revoke: () => {
      current = false;
    },
  };
}

describe("remote Control UI memory transport", () => {
  it("passes real HTTP parsing, immutable remote provenance and sandbox selection through host owners", async () => {
    const { transport, input } = fixture({
      handleRequest: async (req, res) => {
        expect(req.url).toBe("/claw/?view=chat");
        expect(req.headers["x-diagnostic"]).toBe("synthetic");
        expect(readGatewayIngressTransport(req)?.kind).toBe("remote-forwarded");
        expect(() => markGatewayIngressTransport(req, { kind: "ordinary" })).toThrow(
          "already assigned",
        );
        res.setHeader("Content-Type", "text/html");
        res.end("<html>Control UI</html>");
      },
    });
    const result = await transport.request({
      ...input,
      pathAndQuery: "/claw/?view=chat",
      headers: [...input.headers, ["x-diagnostic", "synthetic"]],
    });
    expect(result.response.headers.get("content-type")).toBe("text/html");
    expect(await result.response.text()).toBe("<html>Control UI</html>");
    await result.closed;
    const sandbox = await transport.request({ ...input, surface: "sandbox" });
    expect(await sandbox.response.text()).toBe("sandbox-only");
    await sandbox.closed;
  });

  it("revalidates grant authority when a caller pulls already-buffered response bytes", async () => {
    const { transport, input, revoke } = fixture();
    const result = await transport.request(input);
    revoke();
    await expect(result.response.text()).rejects.toThrow("Grant revoked");
    await result.closed;
  });

  it("delivers an early HTTP rejection without waiting for the upload to finish", async () => {
    const cancelled = createDeferred();
    const { transport, input } = fixture({
      handleRequest: async (_req, res) => {
        res.writeHead(403);
        res.end("denied");
      },
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1));
      },
      cancel() {
        cancelled.resolve();
      },
    });
    const { response } = await transport.request({ ...input, method: "POST", body });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("denied");
    await cancelled.promise;
  });

  it("uses real WebSocket text/binary framing and fences stale message sends", async () => {
    const wss = websocketServer();
    const { transport, revoke } = fixture({
      handleUpgrade: async (req, socket, head) => {
        expect(readGatewayIngressTransport(req)?.kind).toBe("remote-forwarded");
        expect(req.headers.origin).toBe("https://ui.example.test");
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.on("message", (bytes, isBinary) => ws.send(bytes, { binary: isBinary }));
        });
      },
    });
    const { socket } = await transport.openWebSocket(websocketRequest);
    const reader = socket.messages[Symbol.asyncIterator]();
    await expect(
      socket.send({ kind: "binary", bytes: new Uint8Array(25 * 1024 * 1024 + 1) }),
    ).rejects.toThrow("exceeds 25 MiB");
    await socket.send({ kind: "text", text: "hello" });
    expect(await reader.next()).toMatchObject({ value: { kind: "text", text: "hello" } });
    await socket.send({ kind: "binary", bytes: Uint8Array.from([0, 1, 255]) });
    const binary = await reader.next();
    expect(binary.value?.kind).toBe("binary");
    if (binary.value?.kind === "binary") {
      expect(Array.from(binary.value.bytes)).toEqual([0, 1, 255]);
    }
    revoke();
    await expect(socket.send({ kind: "text", text: "blocked" })).rejects.toThrow("Grant revoked");
    await transport.close();
    await socket.closed;
  });

  it("gives upgraded sockets net.Socket timeouts so Gateway keepalive can arm them", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    try {
      const wss = websocketServer();
      const accepted = createDeferred<IncomingMessage["socket"]>();
      const missedPong = vi.fn();
      const { transport } = fixture({
        handleUpgrade: async (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, (ws) => {
            startWebSocketKeepalive(ws, missedPong, req.socket);
            accepted.resolve(req.socket);
          });
        },
      });
      await transport.openWebSocket(websocketRequest);
      const upgraded = await accepted.promise;
      // Before the fix, the first keepalive tick threw `transport.setTimeout is not a function`.
      expect(() => vi.advanceTimersByTime(25_000)).not.toThrow();
      expect(upgraded.timeout).toBe(25_000);
      const timedOut = vi.fn();
      upgraded.setTimeout(1_000, timedOut);
      vi.advanceTimersByTime(1_000);
      expect(timedOut).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps accepted WebSocket authority with the grant when the browser transport disconnects", async () => {
    const wss = websocketServer();
    const admitted = createDeferred<RemoteControlUiIngressContext>();
    const { transport, revoke } = fixture({
      handleUpgrade: async (req, socket, head) => {
        const provenance = readGatewayIngressTransport(req);
        if (provenance?.kind !== "remote-forwarded") {
          throw new Error("Missing remote provenance");
        }
        admitted.resolve(provenance.context);
        wss.handleUpgrade(req, socket, head, () => {});
      },
    });
    const browser = new AbortController();
    const { socket } = await transport.openWebSocket({
      pathAndQuery: "/claw",
      origin: "https://ui.example.test",
      protocols: [],
      signal: browser.signal,
    });
    const authority = await admitted.promise;
    browser.abort(new Error("Browser disconnected"));
    await socket.closed;
    expect(authority.signal.aborted).toBe(false);
    expect(() => authority.assertCurrent()).not.toThrow();
    revoke();
    expect(() => authority.assertCurrent()).toThrow("Grant revoked");
  });

  it("delivers the final buffered response chunk before normal transport completion", async () => {
    const { transport, input } = fixture({
      handleRequest: async (_req, res) => {
        await new Promise<void>((resolve, reject) => {
          res.write(new Uint8Array(128 * 1024).fill(1), (error) =>
            error ? reject(error) : resolve(),
          );
        });
        res.end(new Uint8Array(128 * 1024).fill(2));
      },
    });
    const result = await transport.request(input);
    const bytes = new Uint8Array(await result.response.arrayBuffer());
    expect(bytes.byteLength).toBe(256 * 1024);
    expect(bytes[0]).toBe(1);
    expect(bytes[bytes.byteLength - 1]).toBe(2);
    await result.closed;
  });

  it.each(["request", "response"] as const)(
    "bounds cumulative HTTP %s bytes across small streaming chunks",
    async (direction) => {
      const chunk = new Uint8Array(1024 * 1024);
      const { transport, input } = fixture({
        handleRequest: async (req, res) => {
          if (direction === "request") {
            const complete = once(req, "end");
            req.resume();
            await complete;
          } else {
            for (let index = 0; index < 101; index += 1) {
              await new Promise<void>((resolve, reject) => {
                res.write(chunk, (error) => (error ? reject(error) : resolve()));
              });
            }
          }
          res.end();
        },
      });
      let chunks = 0;
      const body =
        direction === "request"
          ? new ReadableStream<Uint8Array>({
              pull(controller) {
                if (chunks < 101) {
                  chunks += 1;
                  controller.enqueue(chunk);
                } else {
                  controller.close();
                }
              },
            })
          : undefined;
      const exchange = async () => {
        const result = await transport.request({ ...input, method: body ? "POST" : "GET", body });
        if (result.response.body) {
          await result.response.body.pipeTo(new WritableStream());
        }
        await result.closed;
      };
      await expect(exchange()).rejects.toThrow(`HTTP ${direction} exceeds 100 MiB`);
      await transport.close();
    },
  );
});
