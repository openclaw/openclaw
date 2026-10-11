import { once } from "node:events";
import { maxHeaderSize } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "../../packages/gateway-client/src/websocket.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { GatewayControlUiIngressRequestV1 } from "../plugins/gateway-ingress.types.js";
import { markGatewayIngressTransport, readGatewayIngressTransport } from "./ingress-attribution.js";
import type { RemoteControlUiIngressContext } from "./remote-control-ui-context.js";
import type { GatewayControlUiIngressHost } from "./remote-control-ui-ingress-host.js";
import { createRemoteControlUiTransport } from "./remote-control-ui-transport.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

function fixture(
  overrides: Partial<GatewayControlUiIngressHost> = {},
  byteLimit = 32 * 1024 * 1024,
) {
  let current = true;
  let reserved = 0;
  const context: RemoteControlUiIngressContext = {
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
    trackWork: (work) => work,
  };
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
  const transport = createRemoteControlUiTransport({
    context,
    host,
    reserveBytes(bytes) {
      if (reserved + bytes > byteLimit) {
        throw new Error("Plugin buffer quota exceeded");
      }
      reserved += bytes;
      return () => {
        reserved -= bytes;
      };
    },
  });
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
    reserved: () => reserved,
  };
}

describe("remote Control UI memory transport", () => {
  it("releases operation deadlines when HTTP construction rejects malformed headers", async () => {
    const { transport, input } = fixture();
    vi.useFakeTimers();
    try {
      await expect(
        transport.request({ ...input, headers: [...input.headers, ["x-synthetic", "\u0100"]] }),
      ).rejects.toThrow("Invalid character in header content");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await transport.close();
      vi.useRealTimers();
    }
  });

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
    await result.completion;
    const sandbox = await transport.request({ ...input, surface: "sandbox" });
    expect(await sandbox.response.text()).toBe("sandbox-only");
    await sandbox.completion;
  });

  it("refuses response publication when a live grant becomes stale during awaited handler work", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const { transport, input, revoke } = fixture({
      handleRequest: async (_req, res) => {
        entered.resolve();
        await release.promise;
        res.end("private response");
      },
    });
    const pending = transport.request(input);
    await awaitGateBeforeSettlement(
      entered.promise,
      pending,
      "HTTP request did not reach its host handler",
    );
    const rejection = expect(pending).rejects.toThrow("Grant revoked");
    revoke();
    release.resolve();
    await rejection;
  });

  it("revalidates grant authority when a caller pulls already-buffered response bytes", async () => {
    const { transport, input, revoke } = fixture();
    const result = await transport.request(input);
    revoke();
    await expect(result.response.text()).rejects.toThrow("Grant revoked");
    await result.completion;
  });

  it("cancels reads immediately and keeps completion pending until the handler settles", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const { transport, input } = fixture({
      handleRequest: async (_req, res) => {
        res.write("first bytes");
        entered.resolve();
        await release.promise;
      },
    });
    const pending = transport.request(input);
    await awaitGateBeforeSettlement(
      entered.promise,
      pending,
      "HTTP request did not reach its host handler",
    );
    const result = await pending;
    let completed = false;
    void result.completion.then(() => {
      completed = true;
    });
    await result.response.body?.cancel();
    expect(completed).toBe(false);
    release.resolve();
    await result.completion;
    await transport.close();
    await expect(transport.request(input)).rejects.toThrow("closed");
  });

  it("joins asynchronous request-body cancellation before completing handle closure", async () => {
    const cancelStarted = createDeferred();
    const cancelFinished = createDeferred();
    const disconnected = createDeferred();
    const events: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1));
      },
      async cancel() {
        cancelStarted.resolve();
        await cancelFinished.promise;
        events.push("body-cancelled");
      },
    });
    const { transport, input } = fixture({
      handleRequest: async (req, res) => {
        req.socket.once("close", () => disconnected.resolve());
        res.write("first response bytes");
      },
    });
    const result = await transport.request({ ...input, method: "POST", body });
    const closing = transport.close().then(() => {
      events.push("handle-closed");
    });
    try {
      await cancelStarted.promise;
      await disconnected.promise;
      expect(events).toEqual([]);
    } finally {
      cancelFinished.resolve();
    }
    await closing;
    await result.completion;
    expect(events).toEqual(["body-cancelled", "handle-closed"]);
  });

  it.each(["http", "websocket"] as const)(
    "settles owned %s admission before rejecting a cancelled opening operation",
    async (kind) => {
      const entered = createDeferred();
      const disconnected = createDeferred();
      const release = createDeferred();
      const events: string[] = [];
      const { transport, input } = fixture({
        handleRequest: async (req) => {
          req.socket.once("close", () => disconnected.resolve());
          entered.resolve();
          await release.promise;
          events.push("handler-settled");
        },
        handleUpgrade: async (_req, socket) => {
          socket.once("close", () => disconnected.resolve());
          entered.resolve();
          await release.promise;
          events.push("handler-settled");
        },
      });
      const browser = new AbortController();
      const pending =
        kind === "http"
          ? transport.request({ ...input, signal: browser.signal })
          : transport.openWebSocket({
              pathAndQuery: "/claw",
              origin: "https://ui.example.test",
              protocols: [],
              signal: browser.signal,
            });
      const rejected = pending.then(
        () => {
          throw new Error("Cancelled admission unexpectedly succeeded");
        },
        (error: unknown) => {
          events.push("rejected");
          return error;
        },
      );
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "Request did not reach admission",
        );
        browser.abort(new Error("Browser disconnected during admission"));
        await disconnected.promise;
        expect(events).toEqual([]);
      } finally {
        release.resolve();
      }
      expect(await rejected).toMatchObject({ message: "Browser disconnected during admission" });
      expect(events).toEqual(["handler-settled", "rejected"]);
    },
  );

  it("uses real WebSocket text/binary framing and fences stale message sends", async () => {
    const wss = new WebSocketServer({ noServer: true });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          wss.close(() => resolve());
        }),
    );
    const { transport, revoke, reserved } = fixture({
      handleUpgrade: async (req, socket, head) => {
        expect(readGatewayIngressTransport(req)?.kind).toBe("remote-forwarded");
        expect(req.headers.origin).toBe("https://ui.example.test");
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.on("message", (bytes, isBinary) => ws.send(bytes, { binary: isBinary }));
        });
      },
    });
    const { socket } = await transport.openWebSocket({
      pathAndQuery: "/claw",
      origin: "https://ui.example.test",
      protocols: [],
      signal: new AbortController().signal,
    });
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
    expect(reserved()).toBe(0);
  });

  it("closes a WebSocket whose unread messages exceed the bounded receive queue", async () => {
    const wss = new WebSocketServer({ noServer: true });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          wss.close(() => resolve());
        }),
    );
    const { transport, reserved } = fixture({
      handleUpgrade: async (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => {
          for (let index = 0; index < 65; index += 1) {
            ws.send("message");
          }
        });
      },
    });
    const opened = transport.openWebSocket({
      pathAndQuery: "/claw",
      origin: "https://ui.example.test",
      protocols: [],
      signal: new AbortController().signal,
    });
    await expect(
      opened.then(async ({ socket }) => {
        await socket.closed;
        await socket.messages[Symbol.asyncIterator]().next();
      }),
    ).rejects.toThrow("receive queue is full");
    await transport.close();
    expect(reserved()).toBe(0);
  });

  it("bounds WebSocket output bursts before the native socket can enqueue them", async () => {
    const wss = new WebSocketServer({ noServer: true });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          wss.close(() => resolve());
        }),
    );
    const chunk = new Uint8Array(32 * 1024);
    let peakBufferedBytes = 0;
    const { transport, reserved } = fixture(
      {
        handleUpgrade: async (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, (ws) => {
            for (let index = 0; index < 4; index += 1) {
              ws.send(chunk);
              peakBufferedBytes = Math.max(peakBufferedBytes, socket.writableLength);
            }
          });
        },
      },
      96 * 1024,
    );
    await expect(
      transport.openWebSocket({
        pathAndQuery: "/claw",
        origin: "https://ui.example.test",
        protocols: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Plugin buffer quota exceeded");
    expect(peakBufferedBytes).toBeLessThanOrEqual(96 * 1024);
    await transport.close();
    expect(reserved()).toBe(0);
  });

  it("transfers a maximum-sized WebSocket frame within the plugin buffer budget", async () => {
    const wss = new WebSocketServer({ noServer: true });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          wss.close(() => resolve());
        }),
    );
    const { transport, reserved } = fixture(
      {
        handleUpgrade: async (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, (ws) => {
            ws.on("message", (bytes, binary) => ws.send(bytes, { binary }));
          });
        },
      },
      64 * 1024 * 1024,
    );
    const { socket } = await transport.openWebSocket({
      pathAndQuery: "/claw",
      origin: "https://ui.example.test",
      protocols: [],
      signal: new AbortController().signal,
    });
    await socket.send({ kind: "binary", bytes: new Uint8Array(25 * 1024 * 1024) });
    const message = await socket.messages[Symbol.asyncIterator]().next();
    expect(message.value?.kind).toBe("binary");
    if (message.value?.kind === "binary") {
      expect(message.value.bytes.byteLength).toBe(25 * 1024 * 1024);
    }
    await transport.close();
    expect(reserved()).toBe(0);
  });

  it("retains a final WebSocket response and its quota until the closed socket is drained", async () => {
    const wss = new WebSocketServer({ noServer: true });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          wss.close(() => resolve());
        }),
    );
    const { transport, reserved } = fixture({
      handleUpgrade: async (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.send("final response");
          ws.close();
        });
      },
    });
    const { socket, completion } = await transport.openWebSocket({
      pathAndQuery: "/claw",
      origin: "https://ui.example.test",
      protocols: [],
      signal: new AbortController().signal,
    });
    let completed = false;
    void completion.then(() => {
      completed = true;
    });
    await socket.closed;
    expect(completed).toBe(false);
    expect(reserved()).toBeGreaterThan(0);
    const reader = socket.messages[Symbol.asyncIterator]();
    expect(await reader.next()).toMatchObject({ value: { kind: "text", text: "final response" } });
    await completion;
    expect(reserved()).toBe(0);
    expect(await reader.next()).toMatchObject({ done: true });
  });

  it("keeps accepted WebSocket authority with the grant when the browser transport disconnects", async () => {
    const wss = new WebSocketServer({ noServer: true });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          wss.close(() => resolve());
        }),
    );
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

  it("settles a remotely closed WebSocket immediately when no messages remain", async () => {
    const wss = new WebSocketServer({ noServer: true });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          wss.close(() => resolve());
        }),
    );
    const { transport, reserved } = fixture({
      handleUpgrade: async (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => ws.close());
      },
    });
    const { socket, completion } = await transport.openWebSocket({
      pathAndQuery: "/claw",
      origin: "https://ui.example.test",
      protocols: [],
      signal: new AbortController().signal,
    });
    await socket.closed;
    await completion;
    expect(reserved()).toBe(0);
  });

  it("bounds retained response bytes through the plugin-wide quota", async () => {
    const { transport, input, reserved } = fixture(
      {
        handleRequest: async (_req, res) => {
          res.end(Buffer.alloc(2048));
        },
      },
      1024,
    );
    await expect(transport.request(input).then((result) => result.response.text())).rejects.toThrow(
      "Plugin buffer quota exceeded",
    );
    await transport.close();
    expect(reserved()).toBe(0);
  });

  it("bounds response bursts before Node can enqueue their body bytes", async () => {
    const chunk = new Uint8Array(32 * 1024);
    let peakBufferedBytes = 0;
    const { transport, input, reserved } = fixture(
      {
        handleRequest: async (_req, res) => {
          res.cork();
          for (let index = 0; index < 4; index += 1) {
            res.write(chunk);
            peakBufferedBytes = Math.max(peakBufferedBytes, res.writableLength);
          }
          res.end();
        },
      },
      96 * 1024,
    );
    await expect(transport.request(input)).rejects.toThrow("Plugin buffer quota exceeded");
    // Node's public response length includes headers, whose parser limit is separate from body quota.
    expect(peakBufferedBytes).toBeLessThanOrEqual(96 * 1024 + maxHeaderSize);
    await transport.close();
    expect(reserved()).toBe(0);
  });

  it("cancels native pipe output at quota without throwing into its producer", async () => {
    const source = new PassThrough();
    const mounted = createDeferred();
    const { transport, input, reserved } = fixture(
      {
        handleRequest: async (_req, res) => {
          source.pipe(res);
          mounted.resolve();
        },
      },
      96 * 1024,
    );
    try {
      const pending = transport.request(input);
      await awaitGateBeforeSettlement(mounted.promise, pending, "Request did not attach its pipe");
      let synchronousError: unknown;
      try {
        source.end(new Uint8Array(128 * 1024));
      } catch (error) {
        synchronousError = error;
      }
      await expect(pending).rejects.toThrow("Plugin buffer quota exceeded");
      expect(synchronousError).toBeUndefined();
      expect(reserved()).toBe(0);
    } finally {
      source.destroy();
      await transport.close();
    }
  });

  it("delivers the final buffered response chunk before normal transport completion", async () => {
    const { transport, input, reserved } = fixture({
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
    await result.completion;
    expect(reserved()).toBe(0);
  });

  it("refuses an upload chunk larger than the plugin buffer quota", async () => {
    const { transport, input, reserved } = fixture(
      {
        handleRequest: async (req, res) => {
          const complete = once(req, "end");
          req.resume();
          await complete;
          res.end("accepted");
        },
      },
      96 * 1024,
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(128 * 1024));
        controller.close();
      },
    });
    await expect(
      transport
        .request({ ...input, method: "POST", body })
        .then((result) => result.response.text()),
    ).rejects.toThrow("Plugin buffer quota exceeded");
    await transport.close();
    expect(reserved()).toBe(0);
  });

  it.each(["request", "response"] as const)(
    "bounds cumulative HTTP %s bytes across small streaming chunks",
    async (direction) => {
      const chunk = new Uint8Array(1024 * 1024);
      const { transport, input, reserved } = fixture({
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
        await result.completion;
      };
      await expect(exchange()).rejects.toThrow(`HTTP ${direction} exceeds 100 MiB`);
      await transport.close();
      expect(reserved()).toBe(0);
    },
  );

  it("releases buffered stream reservations when an unread response is closed", async () => {
    const { transport, input, reserved } = fixture({
      handleRequest: async (_req, res) => {
        for (let index = 0; index < 8; index += 1) {
          res.write(Buffer.alloc(128 * 1024));
        }
        res.end();
      },
    });
    const result = await transport.request(input);
    expect(reserved()).toBeGreaterThan(0);
    await transport.close();
    await result.completion;
    expect(reserved()).toBe(0);
  });
});
