import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { EventEmitter, once } from "node:events";
import {
  type ClientRequest,
  createServer,
  IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  type AddressInfo,
  connect as connectSocket,
  Server as NetServer,
  type Socket,
} from "node:net";
import type { Duplex } from "node:stream";
import { connect as connectTLS } from "node:tls";
import { fileURLToPath } from "node:url";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  PROXY_FIXTURE_CERTIFICATE,
  PROXY_FIXTURE_KEY,
} from "../src/test-helpers/proxy-tls-fixture.js";
import { startQaGatewayRpcProxy } from "./fixtures/qa-gateway-rpc-proxy.mjs";
import {
  acquireGatewayTestWebSocket,
  closeGatewayTestWebSocket,
} from "./helpers/gateway-websocket.js";
import { createDeferred, withTestTimeout } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

type Proxy = Awaited<ReturnType<typeof startQaGatewayRpcProxy>>;

async function fixtureControl(
  proxy: Proxy,
  action: string,
  method?: string,
  selector?: Record<string, string>,
  connection?: number,
) {
  const response = await fetch(proxy.controlUrl, {
    method: "POST",
    headers: { "x-qa-fixture-token": "proxy-control-fixture" },
    body: JSON.stringify({ action, method, selector, connection }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ReturnType<Proxy["snapshot"]>;
}

async function expectFixtureControlRejected(
  proxy: Proxy,
  action: string,
  method?: string,
  selector?: Record<string, string>,
  connection?: number,
) {
  const response = await fetch(proxy.controlUrl, {
    method: "POST",
    headers: { "x-qa-fixture-token": "proxy-control-fixture" },
    body: JSON.stringify({ action, method, selector, connection }),
  });
  const body = await response.text();
  expect(response.status).toBe(500);
  expect(body).toBe("fixture control failed");
}

async function withProxy(
  holdUpgrade: boolean,
  body: (fixture: {
    proxy: Proxy;
    front: WebSocket;
    upstream: Promise<WebSocket>;
    upgrade: Promise<Duplex>;
    server: ReturnType<typeof createServer>;
    backendConnections: () => number;
    reconnect: () => Promise<{ front: WebSocket; upstream: Promise<WebSocket> }>;
    connectPeer: () => Promise<{ front: WebSocket; upstream: Promise<WebSocket> }>;
  }) => Promise<void>,
  captureReadiness = false,
  rejectUpgrade = false,
  mediaPaths: ReadonlySet<string> = new Set(),
  observeMobileHandoff = false,
  observeNativeActions = false,
  tls = false,
) {
  const server = createServer();
  const sockets = new Set<Duplex>();
  const peers = new Set<WebSocket>();
  const backend = new WebSocketServer({ noServer: true });
  const upgrade = createDeferred<Duplex>();
  const upstream = createDeferred<WebSocket>();
  let nextUpstream = upstream;
  let backendConnections = 0;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    upgrade.resolve(socket);
    if (rejectUpgrade) {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nX-Fixture-Private: private-header-marker\r\nContent-Length: 19\r\n\r\nprivate-body-marker",
      );
    } else if (holdUpgrade) {
      socket.on("end", () => socket.end());
      socket.resume();
    } else {
      backend.handleUpgrade(request, socket, head, (ws) => {
        backendConnections += 1;
        peers.add(ws);
        ws.once("close", () => peers.delete(ws));
        nextUpstream.resolve(ws);
      });
    }
  });
  let proxy: Proxy | undefined;
  let front: WebSocket | undefined;
  const additionalFronts = new Set<WebSocket>();
  const clientOptions = tls ? { ca: PROXY_FIXTURE_CERTIFICATE } : undefined;
  await runQaGatewayFixture(
    async () => {
      const listening = once(server, "listening");
      server.listen(0, "127.0.0.1");
      await listening;
      proxy = await startQaGatewayRpcProxy({
        backendPort: (server.address() as AddressInfo).port,
        repoRoot: fileURLToPath(new URL("../", import.meta.url)),
        upstreamHeaders: { "x-qa-private": "private-header-marker" },
        captureReadiness,
        observeMobileHandoff,
        observeNativeActions,
        mediaPaths,
        token: "proxy-control-fixture",
        ...(tls ? { tls: { cert: PROXY_FIXTURE_CERTIFICATE, key: PROXY_FIXTURE_KEY } } : {}),
      });
      front = new WebSocket(proxy.url, clientOptions);
      await acquireGatewayTestWebSocket(front, 5000);
      const proxyURL = proxy.url;
      await body({
        proxy,
        front,
        upstream: upstream.promise,
        upgrade: upgrade.promise,
        server,
        backendConnections: () => backendConnections,
        reconnect: async () => {
          if (front) {
            await closeGatewayTestWebSocket(front);
          }
          nextUpstream = createDeferred<WebSocket>();
          front = new WebSocket(proxyURL, clientOptions);
          await acquireGatewayTestWebSocket(front, 5000);
          return { front, upstream: nextUpstream.promise };
        },
        connectPeer: async () => {
          nextUpstream = createDeferred<WebSocket>();
          const additional = new WebSocket(proxyURL, clientOptions);
          additionalFronts.add(additional);
          await acquireGatewayTestWebSocket(additional, 5000);
          return { front: additional, upstream: nextUpstream.promise };
        },
      });
    },
    async () => {
      await Promise.all([...additionalFronts].map(closeGatewayTestWebSocket));
      if (front) {
        await closeGatewayTestWebSocket(front);
      }
    },
    async () => {
      if (proxy) {
        await proxy.stop();
      }
    },
    async () => {
      await Promise.all([...peers].map(closeGatewayTestWebSocket));
      await Promise.all(
        [...sockets].map(async (socket) => {
          const closed = once(socket, "close");
          socket.destroy();
          await closed;
        }),
      );
      await new Promise<void>((resolve) => {
        backend.close(() => resolve());
      });
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
}

function expectTraceOrder(trace: ReturnType<Proxy["snapshot"]>["firstConnection"], tags: string[]) {
  let previous = -1;
  for (const tag of tags) {
    const index = trace.findIndex((entry) => entry.tag === tag);
    expect(index, tag).toBeGreaterThan(previous);
    previous = index;
  }
}

function holdCloseNotification(owner: EventEmitter, order: string[], tag = "outbound-close") {
  const entered = createDeferred();
  const delivered = createDeferred();
  const originalEmit = owner.emit.bind(owner);
  let released = false;
  let resume: (() => boolean) | undefined;
  // Termination and socket closure still run. Hold only this owner's final
  // notification so listener/server shutdown cannot stand in for its lifetime.
  const emit = vi.spyOn(owner, "emit").mockImplementation((event, ...args) => {
    if (event !== "close") {
      return Reflect.apply(originalEmit, owner, [event, ...args]);
    }
    const notify = () => {
      const result = Reflect.apply(originalEmit, owner, [event, ...args]);
      order.push(tag);
      delivered.resolve();
      return result;
    };
    entered.resolve();
    if (released) {
      return notify();
    }
    resume = notify;
    return owner.listenerCount("close") > 0;
  });
  return {
    entered: entered.promise,
    delivered: delivered.promise,
    release() {
      released = true;
      const notify = resume;
      resume = undefined;
      notify?.();
    },
    restore: () => emit.mockRestore(),
  };
}

function observeProxyOutboundClose(server: Server) {
  const backendURL = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const closed = createDeferred();
  let outbound: WebSocket | undefined;
  const onClose = () => closed.resolve();
  const captureOutbound = (socket: WebSocket) => {
    outbound = socket;
    socket.once("close", onClose);
  };
  const originalTerminate = Object.getOwnPropertyDescriptor(WebSocket.prototype, "terminate")
    ?.value as WebSocket["terminate"] | undefined;
  assert(typeof originalTerminate === "function");
  const terminate = vi
    .spyOn(WebSocket.prototype, "terminate")
    .mockImplementation(function (this: WebSocket) {
      if (!outbound && this.url === backendURL) {
        captureOutbound(this);
      }
      originalTerminate.call(this);
    });
  return {
    closed: closed.promise,
    dispose() {
      terminate.mockRestore();
      outbound?.off("close", onClose);
    },
  };
}

function observeProxyServerClose(proxyURL: string) {
  const port = Number(new URL(proxyURL).port);
  const closed = createDeferred();
  let observed: Server | undefined;
  const onClose = () => closed.resolve();
  const onRequest = (message: unknown) => {
    const { server } = message as { server: Server };
    const address = server.address();
    if (!observed && address && typeof address !== "string" && address.port === port) {
      observed = server;
      server.once("close", onClose);
    }
  };
  subscribe("http.server.request.start", onRequest);
  return {
    closed: closed.promise,
    dispose() {
      unsubscribe("http.server.request.start", onRequest);
      observed?.off("close", onClose);
    },
  };
}

async function closeBackendServer(server: Server) {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("QA Gateway proxy first-connection diagnostics", () => {
  it.each([false, true])(
    "keeps mobile handoff bearers private with observation=%s",
    async (observe) => {
      await withProxy(
        false,
        async ({ proxy, front, upstream }) => {
          const back = await upstream;
          const send = async (socket: WebSocket, receiver: WebSocket, frame: object) => {
            const received = once(receiver, "message");
            const bytes = JSON.stringify(frame);
            socket.send(bytes);
            expect(String((await received)[0])).toBe(bytes);
          };
          await send(front, back, {
            type: "req",
            id: "node",
            method: "connect",
            params: {
              client: { id: "openclaw-ios" },
              device: { id: "fixture-device" },
              role: "node",
              auth: { bootstrapToken: "private-bootstrap-marker" },
            },
          });
          await send(back, front, {
            type: "res",
            id: "node",
            ok: true,
            payload: {
              auth: {
                method: "bootstrap-token",
                role: "node",
                scopes: [],
                deviceToken: "private-node-marker",
                deviceTokens: [
                  {
                    role: "operator",
                    deviceToken: "private-operator-marker",
                    scopes: ["operator.read", "operator.write"],
                  },
                ],
              },
            },
          });
          await send(front, back, {
            type: "req",
            id: "operator",
            method: "connect",
            params: {
              device: { id: "fixture-device" },
              role: "operator",
              auth: { token: "private-operator-marker" },
            },
          });
          await send(front, back, { type: "req", id: "profile", method: "users.self", params: {} });
          await send(back, front, {
            type: "res",
            id: "profile",
            ok: true,
            payload: {
              profile: { id: "fixture-profile", email: "private-email-marker" },
            },
          });
          const events = proxy.snapshot().events;
          expect(JSON.stringify(events)).not.toContain("private-");
          if (observe) {
            expect(events).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  kind: "connect-request",
                  role: "node",
                  usesBootstrapToken: true,
                }),
                expect.objectContaining({
                  kind: "connect-success",
                  authMethod: "bootstrap-token",
                  handoffRoles: ["node", "operator"],
                }),
                expect.objectContaining({
                  kind: "connect-request",
                  role: "operator",
                  operatorHandoffMatched: true,
                }),
                expect.objectContaining({
                  kind: "native-profile",
                  requestId: "profile",
                  profileId: "fixture-profile",
                }),
              ]),
            );
          } else {
            expect(
              events.some(
                (event) => "operatorHandoffMatched" in event || event.kind === "native-profile",
              ),
            ).toBe(false);
          }
        },
        false,
        false,
        new Set(),
        observe,
      );
    },
  );

  it.each([false, true])(
    "bounds installed-action selector evidence with observation=%s",
    async (observe) => {
      await withProxy(
        false,
        async ({ proxy, front, upstream }) => {
          const back = await upstream;
          for (const frame of [
            {
              type: "req",
              id: "send",
              method: "chat.send",
              expectedProfileId: "fixture-profile",
              params: {
                sessionKey: "fixture-session",
                message: "private-question",
                token: "private-token",
              },
            },
            {
              type: "req",
              id: "history",
              method: "chat.history",
              params: {
                inputRunIds: Array.from({ length: 17 }, (_, i) => `run-${i}`),
                sessionKey: "x".repeat(513),
              },
            },
            { type: "req", id: "wait", method: "agent.wait", params: { runId: "run-0" } },
          ]) {
            const received = once(back, "message");
            const bytes = JSON.stringify(frame);
            front.send(bytes);
            expect(String((await received)[0])).toBe(bytes);
          }
          const returned = once(front, "message");
          back.send(
            JSON.stringify({
              type: "res",
              id: "wait",
              ok: true,
              payload: { status: "timeout", terminalReply: { text: "private-answer" } },
            }),
          );
          await returned;
          const events = proxy.snapshot().events.filter((event) => event.kind.startsWith("rpc-"));
          expect(JSON.stringify(events)).not.toContain("private-");
          if (!observe) {
            expect(events).toEqual([]);
            return;
          }
          expect(events).toEqual([
            expect.objectContaining({
              kind: "rpc-request",
              requestId: "send",
              sessionKey: "fixture-session",
              expectedProfileId: "fixture-profile",
            }),
            expect.objectContaining({
              kind: "rpc-request",
              requestId: "history",
              sessionKey: undefined,
              inputRunIds: Array.from({ length: 16 }, (_, i) => `run-${i}`),
              inputRunIdsTruncated: true,
            }),
            expect.objectContaining({ kind: "rpc-request", requestId: "wait", runId: "run-0" }),
            expect.objectContaining({
              kind: "rpc-response",
              requestId: "wait",
              status: "timeout",
              ok: true,
            }),
          ]);
        },
        false,
        false,
        new Set(),
        false,
        observe,
      );
    },
  );

  it("joins an ordinary outbound HTTP close after the listener has closed", async () => {
    const path = "/ordinary-stop-without-headers";
    const received = createDeferred<ServerResponse>();
    const captured = createDeferred<ClientRequest>();
    const order: string[] = [];
    const sockets = new Set<Duplex>();
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === path) {
        received.resolve(response);
      }
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    let backendPort: number;
    let proxy: Proxy | undefined;
    let observer: ReturnType<typeof observeProxyServerClose> | undefined;
    let gate: ReturnType<typeof holdCloseNotification> | undefined;
    let stopped: Promise<void> | undefined;
    let backendClosing: Promise<void> | undefined;
    const closeBackend = () => (backendClosing ??= closeBackendServer(server));
    let response: Promise<unknown> | undefined;
    const abort = new AbortController();
    const onRequest = (message: unknown) => {
      const { request } = message as { request: ClientRequest };
      if (
        !gate &&
        request.method === "GET" &&
        request.path === path &&
        request.getHeader("host") === `127.0.0.1:${backendPort}`
      ) {
        gate = holdCloseNotification(request, order);
        captured.resolve(request);
      }
    };
    subscribe("http.client.request.start", onRequest);
    await runQaGatewayFixture(
      async () => {
        const listening = once(server, "listening");
        server.listen(0, "127.0.0.1");
        await listening;
        backendPort = (server.address() as AddressInfo).port;
        proxy = await startQaGatewayRpcProxy({
          backendPort,
          repoRoot: fileURLToPath(new URL("../", import.meta.url)),
        });
        observer = observeProxyServerClose(proxy.url);
        response = fetch(new URL(path, proxy.controlUrl), { signal: abort.signal })
          .then((value) => value.arrayBuffer())
          .catch(() => undefined);
        const outbound = await withTestTimeout(
          captured.promise,
          5000,
          "outbound HTTP not captured",
        );
        expect(
          (await withTestTimeout(received.promise, 5000, "backend did not receive ordinary GET"))
            .headersSent,
        ).toBe(false);
        expect(proxy.snapshot().firstConnection).toEqual([]);
        expect(proxy.snapshot().media).toEqual({
          requests: 0,
          matched: 0,
          completed: 0,
          succeeded: 0,
        });
        assert(gate);
        stopped = proxy.stop();
        void stopped.then(
          () => order.push("stop"),
          () => order.push("stop-error"),
        );
        expect(proxy.stop()).toBe(stopped);
        await withTestTimeout(
          Promise.all([gate.entered, observer.closed]),
          5000,
          "HTTP socket and proxy listener did not close",
        );
        expect(outbound.destroyed).toBe(true);
        expect(outbound.socket?.destroyed).toBe(true);
        // Join a real backend terminal after the proxy's other terminals. This
        // leaves the selected notification held without a sleep-based assertion.
        await withTestTimeout(closeBackend(), 5000, "backend did not close");
        expect(order).toEqual([]);
        gate.release();
        await gate.delivered;
        await stopped;
        expect(order).toEqual(["outbound-close", "stop"]);
        expect(proxy.stop()).toBe(stopped);
      },
      () => {
        unsubscribe("http.client.request.start", onRequest);
        gate?.release();
        abort.abort();
      },
      async () => {
        stopped ??= proxy?.stop();
        await response;
        await stopped;
        if (gate) {
          await gate.delivered;
        }
      },
      () => {
        gate?.restore();
        observer?.dispose();
      },
      async () => {
        const closing = closeBackend();
        await Promise.all(
          [...sockets].map(async (socket) => {
            const closed = new Promise<void>((resolve) => {
              socket.once("close", resolve);
            });
            socket.destroy();
            await closed;
          }),
        );
        await closing;
      },
    );
  });

  it.each([false, true])(
    "joins the outbound WebSocket close with frontend already closed=%s",
    async (frontClosedFirst) => {
      await withProxy(false, async ({ proxy, front, upstream, server }) => {
        const backend = await upstream;
        const backendClosed = new Promise<void>((resolve) => {
          backend.once("close", resolve);
        });
        const backendURL = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`;
        const captured = createDeferred<WebSocket>();
        const order: string[] = [];
        let gate: ReturnType<typeof holdCloseNotification> | undefined;
        let terminatingState: number | undefined;
        let stopped: Promise<void> | undefined;
        let backendClosing: Promise<void> | undefined;
        const closeBackend = () => (backendClosing ??= closeBackendServer(server));
        const originalTerminate = Object.getOwnPropertyDescriptor(WebSocket.prototype, "terminate")
          ?.value as WebSocket["terminate"] | undefined;
        assert(typeof originalTerminate === "function");
        const terminate = vi
          .spyOn(WebSocket.prototype, "terminate")
          .mockImplementation(function (this: WebSocket) {
            if (!gate && this.url === backendURL) {
              terminatingState = this.readyState;
              gate = holdCloseNotification(this, order);
              captured.resolve(this);
            }
            originalTerminate.call(this);
          });
        const observer = observeProxyServerClose(proxy.url);
        await runQaGatewayFixture(
          async () => {
            await fixtureControl(proxy, "snapshot");
            const marker = JSON.stringify({ type: "event", event: "fixture-ready" });
            const received = once(backend, "message");
            front.send(marker);
            expect(
              (
                await withTestTimeout(received, 5000, "proxy did not forward the ready frame")
              )[0].toString(),
            ).toBe(marker);
            if (frontClosedFirst) {
              await closeGatewayTestWebSocket(front);
              await withTestTimeout(captured.promise, 5000, "outbound WebSocket not captured");
              assert(gate);
              await withTestTimeout(gate.entered, 5000, "outbound close was not reached");
              expect(
                proxy.snapshot().firstConnection.some(({ tag }) => tag === "front-close"),
              ).toBe(true);
            }
            stopped = proxy.stop();
            void stopped.then(
              () => order.push("stop"),
              () => order.push("stop-error"),
            );
            expect(proxy.stop()).toBe(stopped);
            const outbound = await withTestTimeout(
              captured.promise,
              5000,
              "outbound WebSocket not captured",
            );
            assert(gate);
            expect(terminatingState).toBe(WebSocket.OPEN);
            await withTestTimeout(
              Promise.all([gate.entered, observer.closed, backendClosed]),
              5000,
              "WebSocket sockets and proxy listener did not close",
            );
            await closeGatewayTestWebSocket(front);
            expect(outbound.readyState).toBe(WebSocket.CLOSED);
            expect(backend.readyState).toBe(WebSocket.CLOSED);
            await withTestTimeout(closeBackend(), 5000, "backend listener did not close");
            expect(order).toEqual([]);
            gate.release();
            await gate.delivered;
            await stopped;
            expect(order).toEqual(["outbound-close", "stop"]);
            expect(proxy.stop()).toBe(stopped);
          },
          () => {
            terminate.mockRestore();
            gate?.release();
          },
          () => closeGatewayTestWebSocket(front),
          async () => {
            stopped ??= proxy.stop();
            await stopped;
            if (gate) {
              await gate.delivered;
            }
          },
          () => {
            gate?.restore();
            observer.dispose();
          },
          () => closeBackend(),
        );
      });
    },
  );

  it.each([false, true])(
    "closes admission while an aborted media iterator is still settling (overlap=%s)",
    async (overlap) => {
      const firstChunk = createDeferred();
      const abortEntered = createDeferred();
      const releaseAbort = createDeferred();
      const originalIterator = IncomingMessage.prototype[Symbol.asyncIterator];
      const iteratorSpy = vi
        .spyOn(IncomingMessage.prototype, Symbol.asyncIterator)
        .mockImplementation(function (this: IncomingMessage) {
          const iterator = originalIterator.call(this);
          if (this.headers["x-qa-stop-media"] !== "held") {
            return iterator;
          }
          const next = iterator.next.bind(iterator);
          iterator.next = async () => {
            try {
              const result = await next();
              if (!result.done) {
                firstChunk.resolve();
              }
              return result;
            } catch (error) {
              abortEntered.resolve();
              await releaseAbort.promise;
              throw error;
            }
          };
          return iterator;
        });
      await runQaGatewayFixture(
        () =>
          withProxy(
            false,
            async ({ proxy, upstream, server, backendConnections }) => {
              await upstream;
              server.on("request", (request, response) => {
                if (request.url === "/ordinary-media") {
                  response.writeHead(200).end("ordinary media");
                  return;
                }
                response.writeHead(200, { "x-qa-stop-media": "held" });
                response.write("partial media");
              });
              await fixtureControl(proxy, "hold-response", "media.get");
              const media = fetch(new URL("/held-media", proxy.controlUrl))
                .then((response) => response.arrayBuffer())
                .catch(() => undefined);
              let attempted: WebSocket | undefined;
              let stop: Promise<void> | undefined;
              const ordinaryAbort = new AbortController();
              let ordinary: Promise<string> | undefined;
              await runQaGatewayFixture(
                async () => {
                  await withTestTimeout(
                    firstChunk.promise,
                    5000,
                    "media iterator did not receive a chunk",
                  );
                  if (overlap) {
                    ordinary = fetch(new URL("/ordinary-media", proxy.controlUrl), {
                      signal: ordinaryAbort.signal,
                    }).then((response) => response.text());
                    expect(
                      await withTestTimeout(ordinary, 5000, "overlapping media was held"),
                    ).toBe("ordinary media");
                  }
                  const connections = backendConnections();
                  stop = proxy.stop();
                  expect(proxy.stop()).toBe(stop);
                  let stopped = false;
                  void stop.then(
                    () => {
                      stopped = true;
                    },
                    () => {
                      stopped = true;
                    },
                  );
                  await withTestTimeout(
                    abortEntered.promise,
                    5000,
                    "media abort did not reach the iterator",
                  );
                  expect(stopped).toBe(false);
                  attempted = new WebSocket(proxy.url);
                  await expect(acquireGatewayTestWebSocket(attempted, 5000)).rejects.toMatchObject({
                    code: "ECONNREFUSED",
                  });
                  expect(backendConnections()).toBe(connections);
                  expect(stopped).toBe(false);
                  releaseAbort.resolve();
                  await stop;
                  expect(proxy.stop()).toBe(stop);
                },
                () => {
                  releaseAbort.resolve();
                  ordinaryAbort.abort();
                  stop ??= proxy.stop();
                  void stop.catch(() => undefined);
                },
                async () => {
                  if (attempted) {
                    await closeGatewayTestWebSocket(attempted);
                  }
                },
                async () => {
                  await Promise.allSettled([media, ordinary]);
                  await stop;
                },
              );
            },
            false,
            false,
            new Set(["/held-media", "/ordinary-media"]),
          ),
        () => {
          releaseAbort.resolve();
          iteratorSpy.mockRestore();
        },
      );
    },
  );

  it("relays challenge and connect bytes unchanged", async () => {
    await withProxy(false, async ({ proxy, front, upstream }) => {
      const back = await upstream;
      const challenge = Buffer.from(
        '{"type":"event", "event":"connect.challenge","payload":{"nonce":"private-nonce-marker"}}',
      );
      const challengeReceived = once(front, "message");
      back.send(challenge);
      expect((await challengeReceived)[0]).toEqual(challenge);

      const connect = Buffer.from(
        '{"type":"req", "id":"fixture","method":"connect","params":{"private":"private-payload-marker"}}',
      );
      const connectReceived = once(back, "message");
      front.send(connect);
      expect((await connectReceived)[0]).toEqual(connect);
      expect(proxy.snapshot().events).toContainEqual(
        expect.objectContaining({ kind: "connect-request", connection: 1 }),
      );
      const trace = proxy.snapshot().firstConnection;
      expectTraceOrder(trace, [
        "upstream-create-start",
        "upstream-create-return",
        "upstream-upgrade",
        "upstream-open",
      ]);
      expect(JSON.stringify(trace)).not.toContain("private-");
      expect(proxy.readinessSnapshot()).toEqual({ truncated: false, connections: [] });
    });
  });

  it.each([
    { frontClosedFirst: false, captureReadiness: false },
    { frontClosedFirst: true, captureReadiness: false },
    { frontClosedFirst: false, captureReadiness: true },
    { frontClosedFirst: true, captureReadiness: true },
  ])(
    "joins a CONNECTING request with frontend already closed=$frontClosedFirst, readiness=$captureReadiness",
    async ({ frontClosedFirst, captureReadiness }) => {
      // The proxy starts its upgrade before withProxy enters the body. Observe
      // public request starts, then select the exact backend authority below.
      const upgrades: ClientRequest[] = [];
      const onRequest = (message: unknown) => {
        const { request } = message as { request: ClientRequest };
        if (
          request.method === "GET" &&
          request.path === "/" &&
          request.getHeader("upgrade") === "websocket"
        ) {
          upgrades.push(request);
        }
      };
      subscribe("http.client.request.start", onRequest);
      await runQaGatewayFixture(
        () =>
          withProxy(
            true,
            async ({ proxy, front, upgrade, server }) => {
              const socket = await upgrade;
              const backendClosed = new Promise<void>((resolve) => {
                socket.once("close", resolve);
              });
              const authority = `127.0.0.1:${(server.address() as AddressInfo).port}`;
              const requests = upgrades.filter(
                (request) => request.getHeader("host") === authority,
              );
              expect(requests).toHaveLength(1);
              const outbound = requests[0];
              assert(outbound);
              unsubscribe("http.client.request.start", onRequest);
              expect(outbound.destroyed).toBe(false);
              const order: string[] = [];
              const gate = holdCloseNotification(outbound, order);
              const observer = observeProxyServerClose(proxy.url);
              const backClosed = createDeferred();
              let back: WebSocket | undefined;
              let terminatingState: number | undefined;
              let stopped: Promise<void> | undefined;
              let backendClosing: Promise<void> | undefined;
              const closeBackend = () => (backendClosing ??= closeBackendServer(server));
              const captureBack = (capturedSocket: WebSocket) => {
                back = capturedSocket;
                terminatingState = capturedSocket.readyState;
                capturedSocket.once("close", () => backClosed.resolve());
              };
              const originalTerminate = Object.getOwnPropertyDescriptor(
                WebSocket.prototype,
                "terminate",
              )?.value as WebSocket["terminate"] | undefined;
              assert(typeof originalTerminate === "function");
              const terminate = vi
                .spyOn(WebSocket.prototype, "terminate")
                .mockImplementation(function (this: WebSocket) {
                  if (!back && this.url === `ws://${authority}/`) {
                    captureBack(this);
                  }
                  originalTerminate.call(this);
                });
              await runQaGatewayFixture(
                async () => {
                  await fixtureControl(proxy, "snapshot");
                  if (frontClosedFirst) {
                    await closeGatewayTestWebSocket(front);
                    await withTestTimeout(
                      Promise.all([backClosed.promise, gate.entered]),
                      5000,
                      "CONNECTING WebSocket did not close before its request notification",
                    );
                    expect(back?.readyState).toBe(WebSocket.CLOSED);
                    expect(
                      proxy.snapshot().firstConnection.some(({ tag }) => tag === "front-close"),
                    ).toBe(true);
                  }
                  stopped = proxy.stop();
                  void stopped.then(
                    () => order.push("stop"),
                    () => order.push("stop-error"),
                  );
                  expect(proxy.stop()).toBe(stopped);
                  await withTestTimeout(
                    Promise.all([gate.entered, backClosed.promise, observer.closed, backendClosed]),
                    5000,
                    "CONNECTING sockets and proxy listener did not close",
                  );
                  await closeGatewayTestWebSocket(front);
                  expect(terminatingState).toBe(WebSocket.CONNECTING);
                  expect(back?.readyState).toBe(WebSocket.CLOSED);
                  expect(outbound.destroyed).toBe(true);
                  expect(outbound.socket?.destroyed).toBe(true);
                  // Start this real terminal only after the proxy terminal; a
                  // simultaneous barrier could run before an underjoined stop.
                  await withTestTimeout(closeBackend(), 5000, "backend listener did not close");
                  expect(order).toEqual([]);
                  gate.release();
                  await gate.delivered;
                  await stopped;
                  expect(order).toEqual(["outbound-close", "stop"]);

                  const localTermination = frontClosedFirst ? "front-close" : "stop";
                  const trace = proxy.snapshot().firstConnection;
                  expect(trace).toEqual(
                    expect.arrayContaining([
                      expect.objectContaining({
                        tag: "upstream-terminate",
                        state: "CONNECTING",
                        localTermination,
                      }),
                      expect.objectContaining({
                        tag: "upstream-error",
                        localTermination,
                        errorCode: "none",
                      }),
                    ]),
                  );
                  expectTraceOrder(trace, [
                    "upstream-create-start",
                    "upstream-create-return",
                    ...(frontClosedFirst ? ["front-close"] : []),
                    "upstream-terminate",
                    "upstream-error",
                  ]);
                  expect(trace).not.toEqual(
                    expect.arrayContaining([expect.objectContaining({ tag: "upstream-upgrade" })]),
                  );
                  expect(trace.filter(({ tag }) => tag.endsWith("-terminate"))).toHaveLength(2);
                  if (captureReadiness) {
                    expect(proxy.readinessSnapshot().connections[0]?.handshake).toMatchObject({
                      requestReadyMs: expect.any(Number),
                      requestFinishedMs: expect.any(Number),
                    });
                  } else {
                    expect(proxy.readinessSnapshot().connections).toEqual([]);
                  }
                },
                () => {
                  terminate.mockRestore();
                  gate.release();
                },
                () => closeGatewayTestWebSocket(front),
                async () => {
                  stopped ??= proxy.stop();
                  await stopped;
                  await gate.delivered;
                },
                () => {
                  gate.restore();
                  observer.dispose();
                },
                () => closeBackend(),
              );
            },
            captureReadiness,
          ),
        () => unsubscribe("http.client.request.start", onRequest),
      );
    },
  );

  it("records an independent upstream failure before local frontend termination", async () => {
    await withProxy(true, async ({ proxy, front, upgrade }) => {
      const socket = await upgrade;
      expect(front.readyState).toBe(WebSocket.OPEN);
      const frontendClosed = once(front, "close");
      const upstreamClosed = once(socket, "close");
      socket.destroy();
      await Promise.all([frontendClosed, upstreamClosed]);
      await proxy.stop();

      const trace = proxy.snapshot().firstConnection;
      expect(trace).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tag: "upstream-error",
            localTermination: "none",
            errorCode: "ECONNRESET",
          }),
          expect.objectContaining({
            tag: "front-terminate",
            state: "OPEN",
            localTermination: "upstream-error",
          }),
        ]),
      );
      expectTraceOrder(trace, ["upstream-create-return", "upstream-error", "front-terminate"]);
      expect(trace.filter(({ tag }) => tag.endsWith("-terminate"))).toHaveLength(2);
      expect(trace.length).toBeLessThanOrEqual(16);
      for (const entry of trace) {
        expect(Object.keys(entry)).toEqual(expect.arrayContaining(["elapsedMs", "tag"]));
        expect(
          Object.keys(entry).every((key) =>
            ["tag", "elapsedMs", "state", "localTermination", "errorCode"].includes(key),
          ),
        ).toBe(true);
      }
      const evidence = JSON.stringify(trace);
      expect(evidence).not.toMatch(/private-|127\.0\.0\.1|socket hang up|Error:/);
    });
  });
});

describe("QA Gateway proxy readiness diagnostics", () => {
  async function exchange(
    front: WebSocket,
    back: WebSocket,
    ordinal: number,
    method: string,
    ok: boolean,
  ) {
    const id = `private-request-${ordinal}`;
    const request = Buffer.from(
      JSON.stringify({
        type: "req",
        id,
        method,
        expectedProfileId: "private-profile",
        params: { token: "private-token" },
      }),
    );
    const received = once(back, "message");
    front.send(request);
    expect((await received)[0]).toEqual(request);
    const response = Buffer.from(
      JSON.stringify({
        type: "res",
        id,
        ok,
        payload: { token: "private-response" },
        error: {
          code: "private-code",
          message: "private-message",
          details: { url: "https://private.example" },
        },
      }),
    );
    const returned = once(front, "message");
    back.send(response);
    expect((await returned)[0]).toEqual(response);
  }

  it("freezes private history request owners without changing bytes or exposing IDs", async () => {
    await withProxy(
      false,
      async ({ proxy, front, upstream, reconnect }) => {
        const back = await upstream;
        await exchange(front, back, 1, "connect", true);
        await exchange(front, back, 2, "chat.history", true);
        const frozen = proxy.captureHistoryRequestMatcher();
        expect(frozen("private-request-2")).toEqual({
          status: "matched",
          connection: 1,
          request: 2,
        });
        expect(frozen("absent")).toEqual({ status: "unknown" });
        expect(frozen(undefined)).toEqual({ status: "unknown" });
        expect(frozen("x".repeat(129))).toEqual({ status: "unknown" });
        // A same-connection reuse and later reconnection must not mutate the old snapshot.
        await exchange(front, back, 2, "chat.history", true);
        expect(proxy.captureHistoryRequestMatcher()("private-request-2")).toEqual({
          status: "unknown",
        });
        const second = await reconnect();
        await exchange(second.front, await second.upstream, 3, "chat.history", true);
        expect(proxy.captureHistoryRequestMatcher()("private-request-3")).toEqual({
          status: "matched",
          connection: 2,
          request: 1,
        });
        expect(frozen("private-request-3")).toEqual({ status: "unknown" });
        expect(frozen("private-request-2")).toEqual({
          status: "matched",
          connection: 1,
          request: 2,
        });
        const third = await reconnect();
        await exchange(third.front, await third.upstream, 3, "chat.history", true);
        expect(proxy.captureHistoryRequestMatcher()("private-request-3")).toEqual({
          status: "unknown",
        });
        expect(JSON.stringify(proxy.readinessSnapshot())).not.toMatch(
          /private|requestId|127\.0\.0\.1|token|payload/,
        );
      },
      true,
    );
  });

  it("keeps malformed or missing history IDs unknown while forwarding the original bytes", async () => {
    await withProxy(
      false,
      async ({ proxy, front, upstream }) => {
        const back = await upstream;
        for (const id of [undefined, 42, "", "x".repeat(129)]) {
          const raw = Buffer.from(JSON.stringify({ type: "req", id, method: "chat.history" }));
          const received = once(back, "message");
          front.send(raw);
          expect((await received)[0]).toEqual(raw);
          expect(proxy.captureHistoryRequestMatcher()(id)).toEqual({ status: "unknown" });
        }
        expect(JSON.stringify(proxy.readinessSnapshot())).not.toContain("x".repeat(129));
      },
      true,
    );
  });

  it("distinguishes a locally written upgrade request from an upstream HTTP upgrade", async () => {
    await withProxy(
      true,
      async ({ proxy, upgrade }) => {
        await upgrade;
        await expect
          .poll(() => proxy.readinessSnapshot().connections[0]?.handshake.requestFinishedMs)
          .toBeTypeOf("number");
        const connection = proxy.readinessSnapshot().connections[0];
        assert(connection);
        expect(connection.handshake).toMatchObject({
          requestReadyMs: expect.any(Number),
          socketAssigned: { elapsedMs: expect.any(Number), connecting: expect.any(Boolean) },
          tcpConnectedMs: expect.any(Number),
          requestFinishedMs: expect.any(Number),
        });
        expect(connection.handshake.httpResponse).toBeUndefined();
        expect(connection.lifecycle).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ tag: "upstream-upgrade" })]),
        );
        expect(connection.lifecycle).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ tag: "upstream-open" })]),
        );
      },
      true,
    );
  });

  it("records a non-upgrade HTTP status without suppressing the default WebSocket abort", async () => {
    await withProxy(
      false,
      async ({ proxy, front }) => {
        await expect.poll(() => front.readyState).toBe(WebSocket.CLOSED);
        await proxy.stop();
        const connection = proxy.readinessSnapshot().connections[0];
        assert(connection);
        const httpResponse = connection.handshake.httpResponse;
        assert(httpResponse);
        expect(httpResponse).toEqual({
          elapsedMs: expect.any(Number),
          statusCode: 503,
        });
        expect(connection.lifecycle).toContainEqual(
          expect.objectContaining({ tag: "upstream-error", localTermination: "none" }),
        );
        expect(connection.lifecycle).toContainEqual(
          expect.objectContaining({ tag: "upstream-close" }),
        );
        expect(connection.lifecycle).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ tag: "upstream-open" })]),
        );
        expect(JSON.stringify(connection)).not.toMatch(/private|127\.0\.0\.1|503 Service/);
        httpResponse.statusCode = 500;
        expect(proxy.readinessSnapshot().connections[0]?.handshake.httpResponse?.statusCode).toBe(
          503,
        );
      },
      true,
      true,
    );
  });

  it("retains pairing-retry requests and a pending method without private wire data", async () => {
    await withProxy(
      false,
      async ({ proxy, front, upstream, reconnect }) => {
        await exchange(front, await upstream, 1, "connect", false);
        const second = await reconnect();
        const back = await second.upstream;
        await exchange(second.front, back, 2, "connect", true);
        await exchange(second.front, back, 3, "users.self", true);
        const received = once(back, "message");
        second.front.send(
          JSON.stringify({ type: "req", id: "private-pending", method: "chat.history" }),
        );
        await received;
        await expect
          .poll(() => proxy.readinessSnapshot().connections[1]?.requests[1]?.frontWrite?.outcome)
          .toBe("ok");
        await closeGatewayTestWebSocket(second.front);
        await proxy.stop();
        const snapshot = proxy.readinessSnapshot();
        expect(snapshot.truncated).toBe(false);
        expect(snapshot.connections.map(({ connection }) => connection)).toEqual([1, 2]);
        const [firstConnection, secondConnection] = snapshot.connections;
        assert(firstConnection && secondConnection);
        const socketAssigned = secondConnection.handshake.socketAssigned;
        assert(socketAssigned);
        expect(firstConnection.requests[0]).toMatchObject({
          ordinal: 1,
          method: "connect",
          response: { outcome: "error", code: "other" },
          upstreamWrite: { outcome: "ok" },
          frontWrite: { outcome: "ok" },
        });
        expect(secondConnection.requests).toEqual([
          expect.objectContaining({
            ordinal: 1,
            method: "connect",
            response: expect.objectContaining({ outcome: "ok", code: "none" }),
          }),
          expect.objectContaining({
            ordinal: 2,
            method: "users.self",
            response: expect.objectContaining({ outcome: "ok", code: "none" }),
          }),
          expect.objectContaining({
            ordinal: 3,
            method: "chat.history",
            upstreamWrite: expect.objectContaining({ outcome: "ok" }),
          }),
        ]);
        expect(secondConnection.requests[2].response).toBeUndefined();
        expect(secondConnection.lifecycle).toContainEqual(
          expect.objectContaining({ tag: "front-close" }),
        );
        expect(JSON.stringify(snapshot)).not.toMatch(
          /private|127\.0\.0\.1|requestId|profileId|token|payload|https:/,
        );
        firstConnection.requests[0].response!.code = "none";
        secondConnection.lifecycle[0].elapsedMs = -1;
        socketAssigned.elapsedMs = -1;
        expect(proxy.readinessSnapshot().connections[0]?.requests[0].response?.code).toBe("other");
        expect(
          proxy.readinessSnapshot().connections[1]?.lifecycle[0].elapsedMs,
        ).toBeGreaterThanOrEqual(0);
        expect(
          proxy.readinessSnapshot().connections[1]?.handshake.socketAssigned?.elapsedMs,
        ).toBeGreaterThanOrEqual(0);
      },
      true,
    );
  });

  it("distinguishes queued requests from an upstream write attempt", async () => {
    await withProxy(
      true,
      async ({ proxy, front, upgrade }) => {
        await upgrade;
        front.send(JSON.stringify({ type: "req", id: "private-queued", method: "users.self" }));
        await expect.poll(() => proxy.readinessSnapshot().connections[0]?.requests.length).toBe(1);
        const request = proxy.readinessSnapshot().connections[0]?.requests[0];
        assert(request);
        expect(request.queued).toBe(true);
        expect(request.upstreamStartedMs).toBeUndefined();
        expect(request.upstreamWrite).toBeUndefined();
        expect(request.response).toBeUndefined();
      },
      true,
    );
  });

  it("caps connections and requests without dropping forwarded bytes or clearing saturation", async () => {
    await withProxy(
      false,
      async ({ proxy, front, upstream, reconnect }) => {
        let pair = { front, upstream };
        for (let connection = 1; connection <= 5; connection++) {
          const back = await pair.upstream;
          for (let request = 1; request <= 34; request++) {
            await exchange(
              pair.front,
              back,
              request,
              connection === 1 && request === 1 ? "chat.history" : "health",
              true,
            );
          }
          if (connection < 5) {
            pair = await reconnect();
          }
        }
        await closeGatewayTestWebSocket(pair.front);
        await proxy.stop();
        const snapshot = proxy.readinessSnapshot();
        expect(snapshot.truncated).toBe(true);
        expect(snapshot.connections).toHaveLength(4);
        for (const connection of snapshot.connections) {
          expect(connection.truncated).toBe(true);
          expect(connection.requests).toHaveLength(32);
          expect(connection.lifecycle.length).toBeLessThanOrEqual(16);
          expect(
            connection.requests.every(
              ({ response }: { response?: { outcome: "ok" | "error" } }) =>
                response?.outcome === "ok",
            ),
          ).toBe(true);
        }
        expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(64 * 1024);
        expect(proxy.snapshot().events).toEqual([]);
        expect(proxy.readinessSnapshot().truncated).toBe(true);
        expect(proxy.captureHistoryRequestMatcher()("private-request-1")).toEqual({
          status: "unknown",
        });
      },
      true,
    );
  });
});

describe("QA Gateway proxy held responses", () => {
  it("keeps the first media response reserved while another response completes", async () => {
    const firstChunk = createDeferred();
    const firstBody = Buffer.from("first media response");
    const ordinaryBody = "ordinary media response";
    const originalIterator = IncomingMessage.prototype[Symbol.asyncIterator];
    const iteratorSpy = vi
      .spyOn(IncomingMessage.prototype, Symbol.asyncIterator)
      .mockImplementation(function (this: IncomingMessage) {
        const iterator = originalIterator.call(this);
        if (this.headers["x-qa-overlap-media"] === "first") {
          const next = iterator.next.bind(iterator);
          iterator.next = async () => {
            const result = await next();
            if (!result.done) {
              firstChunk.resolve();
            }
            return result;
          };
        }
        return iterator;
      });
    await runQaGatewayFixture(
      () =>
        withProxy(
          false,
          async ({ proxy, upstream, server }) => {
            await upstream;
            let firstResponse: ServerResponse | undefined;
            server.on("request", (request, response) => {
              if (request.url === "/first-media") {
                firstResponse = response;
                response.writeHead(200, { "x-qa-overlap-media": "first" });
                response.write(firstBody.subarray(0, 1));
              } else {
                response.writeHead(200).end(ordinaryBody);
              }
            });
            const abort = new AbortController();
            const clients: Promise<unknown>[] = [];
            const readMedia = (path: string) => {
              const reading = fetch(new URL(path, proxy.controlUrl), { signal: abort.signal }).then(
                async (response) => Buffer.from(await response.arrayBuffer()),
              );
              clients.push(reading);
              void reading.catch(() => undefined);
              return reading;
            };
            await runQaGatewayFixture(
              async () => {
                await fixtureControl(proxy, "hold-response", "media.get");
                const first = readMedia("/first-media");
                await withTestTimeout(
                  firstChunk.promise,
                  5000,
                  "first media body did not enter the collector",
                );
                const held = fixtureControl(proxy, "wait-held");
                clients.push(held);
                void held.catch(() => undefined);
                const overlapping = await fetch(proxy.controlUrl, {
                  method: "POST",
                  headers: { "x-qa-fixture-token": "proxy-control-fixture" },
                  body: JSON.stringify({ action: "hold-response", method: "media.get" }),
                  signal: abort.signal,
                });
                expect(overlapping.status).toBe(500);
                await overlapping.text();
                const ordinary = readMedia("/ordinary-media");
                expect(
                  await withTestTimeout(
                    Promise.race([
                      ordinary,
                      held.then(() => {
                        throw new Error("another response replaced the buffering media hold");
                      }),
                    ]),
                    5000,
                    "overlapping media response did not complete",
                  ),
                ).toEqual(Buffer.from(ordinaryBody));
                expect(proxy.snapshot().heldResponse).toBeUndefined();
                assert(firstResponse);
                firstResponse.end(firstBody.subarray(1));
                const expected = {
                  method: "media.get",
                  ok: true,
                  sizeBytes: firstBody.length,
                  sha256: createHash("sha256").update(firstBody).digest("hex"),
                };
                expect((await held).heldResponse).toEqual(expected);
                const released = await fixtureControl(proxy, "release-response");
                expect(await first).toEqual(firstBody);
                expect(released.events.filter(({ kind }) => kind === "response-held")).toEqual([
                  expect.objectContaining(expected),
                ]);
                expect(released.events.filter(({ kind }) => kind === "response-released")).toEqual([
                  expect.objectContaining({ ...expected, delivered: true }),
                ]);

                await fixtureControl(proxy, "hold-response", "media.get");
                const rearmed = readMedia("/ordinary-media");
                expect((await fixtureControl(proxy, "wait-held")).heldResponse).toEqual({
                  method: "media.get",
                  ok: true,
                  sizeBytes: Buffer.byteLength(ordinaryBody),
                  sha256: createHash("sha256").update(ordinaryBody).digest("hex"),
                });
                await fixtureControl(proxy, "release-response");
                expect(await rearmed).toEqual(Buffer.from(ordinaryBody));
              },
              async () => {
                if (firstResponse && !firstResponse.writableEnded && !firstResponse.destroyed) {
                  firstResponse.end();
                }
                abort.abort();
                const stopped = proxy.stop();
                await Promise.allSettled([...clients, stopped]);
                await stopped;
              },
            );
          },
          false,
          false,
          new Set(["/first-media", "/ordinary-media"]),
        ),
      () => iteratorSpy.mockRestore(),
    );
  });

  it.each(["success", "error", "close", "stop"] as const)(
    "reserves a media release until HTTP %s settles",
    async (outcome) => {
      await withProxy(
        false,
        async ({ proxy, front, upstream, server }) => {
          const back = await upstream;
          const body = Buffer.from("held media release");
          server.on("request", (request, response) => {
            response.writeHead(200, { "content-type": "application/octet-stream" });
            response.end(request.url === "/held-release-media" ? body : "ordinary media");
          });
          const port = Number(new URL(proxy.url).port);
          const endEntered = createDeferred();
          const responseClosed = createDeferred();
          const order: string[] = [];
          let response: ServerResponse | undefined;
          let endSpy: { mockRestore(): void } | undefined;
          let resumeEnd: (() => void) | undefined;
          let closeGate: ReturnType<typeof holdCloseNotification> | undefined;
          const onRequest = (message: unknown) => {
            const event = message as {
              server: Server;
              request: IncomingMessage;
              response: ServerResponse;
            };
            const address = event.server.address();
            if (
              response ||
              !address ||
              typeof address === "string" ||
              address.port !== port ||
              event.request.method !== "GET" ||
              event.request.url !== "/held-release-media"
            ) {
              return;
            }
            response = event.response;
            response.once("close", () => responseClosed.resolve());
            if (outcome === "stop") {
              closeGate = holdCloseNotification(response, order, "response-close");
            }
            const originalEnd = response.end.bind(response);
            endSpy = vi.spyOn(response, "end").mockImplementation(function (
              this: ServerResponse,
              ...args: Parameters<ServerResponse["end"]>
            ) {
              resumeEnd = () => {
                if (!this.destroyed) {
                  Reflect.apply(originalEnd, this, args);
                }
              };
              endEntered.resolve();
              return this;
            });
          };
          subscribe("http.server.request.start", onRequest);
          const observer = observeProxyServerClose(proxy.url);
          const outbound = observeProxyOutboundClose(server);
          const abort = new AbortController();
          let media: Promise<string> | undefined;
          let releasing: ReturnType<typeof fixtureControl> | undefined;
          let stopped: Promise<void> | undefined;
          let backendClosing: Promise<void> | undefined;
          const closeBackend = () => (backendClosing ??= closeBackendServer(server));
          await runQaGatewayFixture(
            async () => {
              await fixtureControl(proxy, "hold-response", "media.get");
              media = fetch(new URL("/held-release-media", proxy.controlUrl), {
                signal: abort.signal,
              }).then((result) => result.text());
              void media.catch(() => {});
              const held = await fixtureControl(proxy, "wait-held");
              expect(held.heldResponse).toEqual({
                method: "media.get",
                ok: true,
                sizeBytes: body.length,
                sha256: createHash("sha256").update(body).digest("hex"),
              });
              releasing = fixtureControl(proxy, "release-response");
              void releasing.catch(() => {});
              await withTestTimeout(
                Promise.race([
                  endEntered.promise,
                  releasing.then(() => {
                    throw new Error("media release completed before HTTP end");
                  }),
                ]),
                5000,
                "held media response did not reach HTTP end",
              );
              assert(response);
              expect(proxy.snapshot().heldResponse).toBeUndefined();
              expect(
                proxy.snapshot().events.filter(({ kind }) => kind === "response-released"),
              ).toEqual([]);
              await expectFixtureControlRejected(proxy, "hold-response", "users.self");
              await expectFixtureControlRejected(proxy, "release-response");
              expect(
                await fetch(new URL("/ordinary-media", proxy.controlUrl)).then((result) =>
                  result.text(),
                ),
              ).toBe("ordinary media");

              if (outcome === "stop") {
                assert(closeGate);
                const backendClosed = new Promise<void>((resolve) => {
                  back.once("close", resolve);
                });
                stopped = proxy.stop();
                void stopped.then(
                  () => order.push("stop"),
                  () => order.push("stop-error"),
                );
                expect(proxy.stop()).toBe(stopped);
                await withTestTimeout(
                  Promise.all([closeGate.entered, observer.closed, backendClosed, outbound.closed]),
                  5000,
                  "media sockets and proxy listener did not close",
                );
                await closeGatewayTestWebSocket(front);
                await withTestTimeout(closeBackend(), 5000, "backend listener did not close");
                // The socket is gone, but finished(response) still owns the held
                // close notification. Listener closure cannot settle this release.
                expect(response.destroyed).toBe(true);
                expect(
                  proxy.snapshot().firstConnection.some(({ tag }) => tag === "front-close"),
                ).toBe(true);
                expect(order).toEqual([]);
                closeGate.release();
                await closeGate.delivered;
                await stopped;
                expect(order).toEqual(["response-close", "stop"]);
                await Promise.allSettled([media, releasing]);
              } else {
                if (outcome === "success") {
                  const finish = resumeEnd;
                  resumeEnd = undefined;
                  assert(finish);
                  finish();
                  expect(await media).toBe(body.toString());
                } else {
                  if (outcome === "error") {
                    response.destroy(new Error("fixture media write failed"));
                  } else {
                    abort.abort();
                  }
                  await withTestTimeout(
                    responseClosed.promise,
                    5000,
                    "media response did not close",
                  );
                  await expect(media).rejects.toThrow();
                }
                await releasing;
                // Success and failed delivery both retire the same reservation.
                await fixtureControl(proxy, "hold-response", "users.self");
              }
              expect(
                proxy.snapshot().events.filter(({ kind }) => kind === "response-released"),
              ).toEqual([
                expect.objectContaining({ method: "media.get", delivered: outcome === "success" }),
              ]);
            },
            () => {
              unsubscribe("http.server.request.start", onRequest);
              const finish = resumeEnd;
              resumeEnd = undefined;
              finish?.();
              closeGate?.release();
              abort.abort();
            },
            async () => {
              stopped ??= proxy.stop();
              await Promise.all([media?.catch(() => {}), releasing?.catch(() => {}), stopped]);
            },
            () => {
              endSpy?.mockRestore();
              closeGate?.restore();
              observer.dispose();
              outbound.dispose();
            },
            () => backendClosing,
          );
        },
        false,
        false,
        new Set(["/held-release-media"]),
      );
    },
  );

  it.each([
    { method: "users.self", captureReadiness: true, writeFails: false, stopBeforeWrite: false },
    { method: "users.self", captureReadiness: true, writeFails: true, stopBeforeWrite: false },
    { method: "chat.send", captureReadiness: true, writeFails: false, stopBeforeWrite: false },
    { method: "chat.send", captureReadiness: true, writeFails: true, stopBeforeWrite: false },
    { method: "users.self", captureReadiness: false, writeFails: false, stopBeforeWrite: false },
    { method: "users.self", captureReadiness: false, writeFails: true, stopBeforeWrite: false },
    { method: "chat.send", captureReadiness: true, writeFails: true, stopBeforeWrite: true },
    {
      method: "sessions.create",
      captureReadiness: true,
      writeFails: false,
      stopBeforeWrite: false,
    },
    { method: "sessions.create", captureReadiness: true, writeFails: true, stopBeforeWrite: false },
    { method: "sessions.create", captureReadiness: true, writeFails: true, stopBeforeWrite: true },
  ])(
    "waits for $method write completion (capture=$captureReadiness, failure=$writeFails, stop=$stopBeforeWrite)",
    async ({ method, captureReadiness, writeFails, stopBeforeWrite }) => {
      await withProxy(
        false,
        async ({ proxy, front, upstream, server }) => {
          const back = await upstream;
          const selector =
            method === "sessions.create"
              ? { expectedProfileId: "fixture-profile", agentId: "qa" }
              : undefined;
          await fixtureControl(proxy, "hold-response", method, selector);
          const request = Buffer.from(
            JSON.stringify({
              type: "req",
              id: "held-write",
              method,
              ...(selector
                ? { expectedProfileId: selector.expectedProfileId, params: { agentId: "qa" } }
                : {}),
            }),
          );
          const received = once(back, "message");
          front.send(request);
          expect((await received)[0]).toEqual(request);
          const response = Buffer.from(
            JSON.stringify({ type: "res", id: "held-write", ok: true, payload: {} }),
          );
          back.send(response);
          await fixtureControl(proxy, "wait-held");

          const sendEntered = createDeferred();
          const originalSend = Object.getOwnPropertyDescriptor(WebSocket.prototype, "send")
            ?.value as WebSocket["send"] | undefined;
          assert(typeof originalSend === "function");
          let complete: ((error?: Error) => void) | undefined;
          let releasing: ReturnType<typeof fixtureControl> | undefined;
          let writeSocket: WebSocket | undefined;
          const captureWriteSocket = (socket: WebSocket) => {
            writeSocket = socket;
          };
          let stopped: Promise<void> | undefined;
          let backendClosing: Promise<void> | undefined;
          const closeBackend = () => (backendClosing ??= closeBackendServer(server));
          const order: string[] = [];
          const observer = observeProxyServerClose(proxy.url);
          const outbound = observeProxyOutboundClose(server);
          const send = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
            this: WebSocket,
            data: Parameters<WebSocket["send"]>[0],
            options?: Parameters<WebSocket["send"]>[1] | ((error?: Error) => void),
            callback?: (error?: Error) => void,
          ) {
            if (Buffer.isBuffer(data) && data.equals(response)) {
              captureWriteSocket(this);
              complete = typeof options === "function" ? options : callback;
              sendEntered.resolve();
              return;
            }
            Reflect.apply(originalSend, this, [data, options, callback]);
          });
          await runQaGatewayFixture(
            async () => {
              releasing = fixtureControl(proxy, "release-response");
              void releasing.catch(() => {});
              await withTestTimeout(
                Promise.race([
                  sendEntered.promise,
                  releasing.then(() => {
                    throw new Error("release completed before its send callback");
                  }),
                ]),
                5000,
                "held response send was not reached",
              );
              expect(
                (await fixtureControl(proxy, "snapshot")).events.some(
                  ({ kind }) => kind === "response-released",
                ),
              ).toBe(false);
              await expectFixtureControlRejected(proxy, "hold-response", "media.get");
              await expectFixtureControlRejected(proxy, "release-response");
              if (method === "sessions.create") {
                await expectFixtureControlRejected(proxy, "drop-response");
              }
              if (stopBeforeWrite) {
                assert(writeSocket);
                const frontend = writeSocket;
                expect(frontend.readyState).toBe(WebSocket.OPEN);
                const frontendClosed = new Promise<void>((resolve) => {
                  frontend.once("close", resolve);
                });
                const backendClosed = new Promise<void>((resolve) => {
                  back.once("close", resolve);
                });
                stopped = proxy.stop();
                void stopped.then(
                  () => order.push("stop"),
                  () => order.push("stop-error"),
                );
                expect(proxy.stop()).toBe(stopped);
                await withTestTimeout(
                  Promise.all([observer.closed, backendClosed, outbound.closed, frontendClosed]),
                  5000,
                  "WebSocket sockets and proxy listener did not close",
                );
                await closeGatewayTestWebSocket(front);
                await withTestTimeout(closeBackend(), 5000, "backend listener did not close");
                expect(order).toEqual([]);
              }
              assert(complete);
              assert(writeSocket);
              const callback = complete;
              complete = undefined;
              order.push("write-callback");
              if (writeFails) {
                callback(new Error("fixture write failed"));
              } else {
                const returned = once(front, "message");
                originalSend.call(writeSocket, response, {}, callback);
                expect((await returned)[0]).toEqual(response);
              }
              if (stopBeforeWrite) {
                await stopped;
                await Promise.allSettled([releasing]);
                expect(order).toEqual(["write-callback", "stop"]);
              } else {
                await releasing;
                await fixtureControl(proxy, "hold-response", "media.get");
              }
              const released = proxy.snapshot();
              expect(released.events.filter(({ kind }) => kind === "response-released")).toEqual([
                expect.objectContaining({ method, delivered: !writeFails }),
              ]);
              const trace = proxy
                .readinessSnapshot()
                .connections[0]?.requests.find((row: { method: string }) => row.method === method);
              if (captureReadiness && method === "users.self") {
                expect(trace?.frontWrite).toEqual({
                  elapsedMs: expect.any(Number),
                  outcome: writeFails ? "error" : "ok",
                });
              } else {
                expect(trace).toBeUndefined();
              }
            },
            () => {
              send.mockRestore();
              complete?.(new Error("fixture cleanup"));
              complete = undefined;
            },
            async () => {
              if (stopBeforeWrite) {
                await Promise.all([releasing?.catch(() => {}), stopped]);
              } else {
                await releasing;
              }
            },
            () => {
              observer.dispose();
              outbound.dispose();
            },
            () => backendClosing,
          );
        },
        captureReadiness,
      );
    },
  );

  it("records a closed frontend as an unsuccessful held release", async () => {
    await withProxy(false, async ({ proxy, front, upstream }) => {
      const back = await upstream;
      await fixtureControl(proxy, "hold-response", "chat.send");
      const received = once(back, "message");
      front.send(JSON.stringify({ type: "req", id: "held-close", method: "chat.send" }));
      await received;
      back.send(JSON.stringify({ type: "res", id: "held-close", ok: true, payload: {} }));
      await fixtureControl(proxy, "wait-held");
      await closeGatewayTestWebSocket(front);
      const released = await fixtureControl(proxy, "release-response");
      expect(released.events.filter(({ kind }) => kind === "response-released")).toEqual([
        expect.objectContaining({ method: "chat.send", delivered: false }),
      ]);
    });
  });
});

describe("QA Gateway proxy native UI producers", () => {
  async function roundTrip(front: WebSocket, back: WebSocket, request: object, response: object) {
    const received = once(back, "message");
    front.send(JSON.stringify(request));
    expect((await received)[0].toString()).toBe(JSON.stringify(request));
    const returned = once(front, "message");
    back.send(JSON.stringify(response));
    expect((await returned)[0].toString()).toBe(JSON.stringify(response));
  }

  const approvalProducer = {
    expectedProfileId: "fixture-profile",
    sessionKey: "approval-session",
    agentId: "qa",
  };
  const requestedApproval = () => ({
    type: "event",
    event: "openclaw.approval.requested",
    payload: {
      approvalKind: "system-agent",
      id: "system-agent:fixture-approval",
      request: {
        sessionKey: approvalProducer.sessionKey,
        agentId: approvalProducer.agentId,
        runId: "fixture-delegated-run",
        proposalHash: "a".repeat(64),
        title: "private-title",
        command: "private-command",
      },
    },
  });
  const approvalLookup = (
    id = "native-lookup",
  ): {
    type: string;
    id: string;
    method: string;
    expectedProfileId?: string;
    params: { id: string };
  } => ({
    type: "req",
    id,
    method: "approval.get",
    params: { id: requestedApproval().payload.id },
  });
  const approvalReply = (id = "native-lookup") => ({
    type: "res",
    id,
    ok: true,
    payload: {
      approval: {
        id: requestedApproval().payload.id,
        status: "pending",
        presentation: {
          kind: "system-agent",
          proposalHash: "a".repeat(64),
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    },
  });
  async function connectApprovalOperator(
    front: WebSocket,
    back: WebSocket,
    clientId = "openclaw-ios",
  ) {
    await roundTrip(
      front,
      back,
      {
        type: "req",
        id: "connect",
        method: "connect",
        params: { role: "operator", client: { id: clientId } },
      },
      { type: "res", id: "connect", ok: true, payload: {} },
    );
    await roundTrip(
      front,
      back,
      { type: "req", id: "profile", method: "users.self" },
      {
        type: "res",
        id: "profile",
        ok: true,
        payload: { profile: { id: approvalProducer.expectedProfileId } },
      },
    );
  }
  async function forwardApprovalEvent(
    front: WebSocket,
    back: WebSocket,
    event = requestedApproval(),
  ) {
    const raw = JSON.stringify(event);
    const forwarded = once(front, "message");
    back.send(raw);
    expect((await forwarded)[0].toString()).toBe(raw);
  }

  it("binds the actual approval event before forwarding and excludes foreign reads and sessions", async () => {
    await withProxy(
      false,
      async ({ proxy, front, upstream, connectPeer }) => {
        const back = await upstream;
        await connectApprovalOperator(front, back);
        const foreign = await connectPeer();
        const foreignBack = await foreign.upstream;
        await connectApprovalOperator(foreign.front, foreignBack, "openclaw-control-ui");
        await expectFixtureControlRejected(
          proxy,
          "hold-approval-response",
          undefined,
          approvalProducer,
          2,
        );
        await expectFixtureControlRejected(
          proxy,
          "hold-approval-response",
          undefined,
          { ...approvalProducer, expectedProfileId: "other-profile" },
          1,
        );
        await expectFixtureControlRejected(proxy, "hold-response", "approval.get", {
          expectedProfileId: approvalProducer.expectedProfileId,
          approvalId: requestedApproval().payload.id,
        });
        await fixtureControl(proxy, "hold-approval-response", undefined, approvalProducer, 1);
        await expectFixtureControlRejected(
          proxy,
          "hold-approval-response",
          undefined,
          approvalProducer,
          1,
        );
        await expectFixtureControlRejected(proxy, "hold-response", "users.self");
        await expectFixtureControlRejected(proxy, "reset");
        for (const field of ["sessionKey", "agentId"] as const) {
          const foreignEvent = requestedApproval();
          foreignEvent.payload.request[field] = "other-owner";
          await forwardApprovalEvent(front, back, foreignEvent);
          expect(proxy.snapshot().approval?.status).toBe("waiting-event");
        }
        await forwardApprovalEvent(foreign.front, foreignBack);
        expect(proxy.snapshot().approval?.status).toBe("waiting-event");
        await forwardApprovalEvent(front, back);
        expect(proxy.snapshot().approval).toEqual({
          connection: 1,
          ...approvalProducer,
          status: "bound",
          approvalId: requestedApproval().payload.id,
          runId: "fixture-delegated-run",
          proposalHash: "a".repeat(64),
        });
        await roundTrip(
          foreign.front,
          foreignBack,
          approvalLookup("foreign-lookup"),
          approvalReply("foreign-lookup"),
        );
        const other = approvalLookup("other-approval");
        other.params.id = "system-agent:another-approval";
        await roundTrip(front, back, other, approvalReply("other-approval"));
        expect(proxy.snapshot().heldResponse).toBeUndefined();
        const received = once(back, "message");
        front.send(JSON.stringify(approvalLookup()));
        await received;
        const returned = once(front, "message");
        back.send(JSON.stringify(approvalReply()));
        const held = await fixtureControl(proxy, "wait-held");
        expect(held.approval).toMatchObject({
          status: "held",
          connection: 1,
          requestId: "native-lookup",
        });
        expect(held.heldResponse).toMatchObject({
          method: "approval.get",
          connection: 1,
          requestId: "native-lookup",
          approvalId: requestedApproval().payload.id,
        });
        await roundTrip(
          foreign.front,
          foreignBack,
          approvalLookup("admin-readback"),
          approvalReply("admin-readback"),
        );
        const released = await fixtureControl(proxy, "release-response");
        expect(released.approval?.status).toBe("released");
        expect((await returned)[0].toString()).toBe(JSON.stringify(approvalReply()));
        expect(JSON.stringify(released)).not.toMatch(/private-title|private-command/);
        expect((await fixtureControl(proxy, "reset")).approval).toBeUndefined();
      },
      false,
      false,
      new Set(),
      false,
      true,
    );
  });

  it.each([
    "duplicate-event",
    "duplicate-lookup",
    "wrong-profile",
    "wrong-response",
    "malformed-event",
  ])(
    "invalidates an ambiguous approval producer without changing forwarded frames: %s",
    async (failure) => {
      await withProxy(
        false,
        async ({ proxy, front, upstream }) => {
          const back = await upstream;
          await connectApprovalOperator(front, back);
          await fixtureControl(proxy, "hold-approval-response", undefined, approvalProducer, 1);
          const event = requestedApproval();
          if (failure === "malformed-event") {
            event.payload.request.proposalHash = "invalid";
          }
          await forwardApprovalEvent(front, back, event);
          if (failure === "duplicate-event") {
            await forwardApprovalEvent(front, back);
          }
          if (failure === "duplicate-lookup") {
            const received = once(back, "message");
            front.send(JSON.stringify(approvalLookup("first-lookup")));
            await received;
          }
          const request = approvalLookup();
          if (failure === "wrong-profile") {
            request.expectedProfileId = "foreign-profile";
          }
          const response = approvalReply();
          if (failure === "wrong-response") {
            response.payload.approval.presentation.proposalHash = "b".repeat(64);
          }
          await roundTrip(front, back, request, response);
          expect(proxy.snapshot().approval?.status).toBe("invalid");
          expect(proxy.snapshot().heldResponse).toBeUndefined();
          await expectFixtureControlRejected(proxy, "wait-held");
          await expectFixtureControlRejected(
            proxy,
            "hold-approval-response",
            undefined,
            approvalProducer,
            1,
          );
        },
        false,
        false,
        new Set(),
        false,
        true,
      );
    },
  );

  it("does not transfer a reserved approval to a reconnected native owner", async () => {
    await withProxy(
      false,
      async ({ proxy, front, upstream, reconnect }) => {
        const back = await upstream;
        await connectApprovalOperator(front, back);
        await fixtureControl(proxy, "hold-approval-response", undefined, approvalProducer, 1);
        const backendClosed = once(back, "close");
        const successor = await reconnect();
        await backendClosed;
        const successorBack = await successor.upstream;
        await connectApprovalOperator(successor.front, successorBack);
        await forwardApprovalEvent(successor.front, successorBack);
        await roundTrip(successor.front, successorBack, approvalLookup(), approvalReply());
        expect(proxy.snapshot().approval).toMatchObject({
          connection: 1,
          status: "invalid",
          reason: "owner-retired",
        });
        expect(proxy.snapshot().heldResponse).toBeUndefined();
        await expectFixtureControlRejected(
          proxy,
          "hold-approval-response",
          undefined,
          approvalProducer,
          2,
        );
      },
      false,
      false,
      new Set(),
      false,
      true,
    );
  });

  it("retires a pre-event approval reservation through the same cached proxy stop", async () => {
    await withProxy(
      false,
      async ({ proxy, front, upstream }) => {
        const back = await upstream;
        await connectApprovalOperator(front, back);
        await fixtureControl(proxy, "hold-approval-response", undefined, approvalProducer, 1);
        const stopping = proxy.stop();
        expect(proxy.stop()).toBe(stopping);
        await stopping;
        expect(proxy.snapshot().approval).toMatchObject({
          status: "invalid",
          reason: "proxy-stopped",
        });
        expect(proxy.snapshot().acceptedConnections).toBe(0);
      },
      false,
      false,
      new Set(),
      false,
      true,
    );
  });

  it("holds only the selected profile and session response and retains its request identity", async () => {
    await withProxy(
      false,
      async ({ proxy, front, upstream }) => {
        const back = await upstream;
        const selector = { expectedProfileId: "fixture-profile", sessionKey: "chosen-session" };
        await expectFixtureControlRejected(proxy, "hold-response", "chat.history");
        await fixtureControl(proxy, "hold-response", "chat.history", selector);
        for (const [id, expectedProfileId, sessionKey] of [
          ["other-profile", "other-profile", "chosen-session"],
          ["other-session", "fixture-profile", "other-session"],
        ]) {
          await roundTrip(
            front,
            back,
            { type: "req", id, method: "chat.history", expectedProfileId, params: { sessionKey } },
            { type: "res", id, ok: true, payload: { messages: [] } },
          );
          expect(proxy.snapshot().heldResponse).toBeUndefined();
        }
        const request = {
          type: "req",
          id: "chosen",
          method: "chat.history",
          expectedProfileId: selector.expectedProfileId,
          params: { sessionKey: selector.sessionKey },
        };
        const received = once(back, "message");
        front.send(JSON.stringify(request));
        await received;
        const response = JSON.stringify({
          type: "res",
          id: "chosen",
          ok: true,
          payload: { messages: [] },
        });
        const returned = once(front, "message");
        back.send(response);
        const held = await fixtureControl(proxy, "wait-held");
        expect(held.heldResponse).toMatchObject({
          method: "chat.history",
          requestId: "chosen",
          ...selector,
        });
        await expectFixtureControlRejected(proxy, "reset");
        await expectFixtureControlRejected(proxy, "hold-response", "users.self");
        await fixtureControl(proxy, "release-response");
        expect((await returned)[0].toString()).toBe(response);
      },
      false,
      false,
      new Set(),
      false,
      true,
    );
  });

  it("refuses one matching create before upstream admission and leaves the retry intact", async () => {
    await withProxy(
      false,
      async ({ proxy, front, upstream }) => {
        const back = await upstream;
        const requests: string[] = [];
        back.on("message", (data) => requests.push(rawDataToString(data)));
        const selector = { expectedProfileId: "fixture-profile", agentId: "main" };
        await fixtureControl(proxy, "reject-create", undefined, selector);
        await expectFixtureControlRejected(proxy, "reject-create", undefined, selector);
        await expectFixtureControlRejected(proxy, "reset");
        await roundTrip(
          front,
          back,
          {
            type: "req",
            id: "other",
            method: "sessions.create",
            expectedProfileId: "other-profile",
            params: { agentId: "main" },
          },
          { type: "res", id: "other", ok: true, payload: { key: "other-session" } },
        );
        const rejected = once(front, "message");
        front.send(
          JSON.stringify({
            type: "req",
            id: "controlled",
            method: "sessions.create",
            ...selector,
            params: { agentId: "main" },
          }),
        );
        expect(JSON.parse((await rejected)[0].toString())).toEqual({
          type: "res",
          id: "controlled",
          ok: false,
          error: { code: "UNAVAILABLE", message: "Controlled fixture request refusal" },
        });
        await roundTrip(
          front,
          back,
          {
            type: "req",
            id: "retry",
            method: "sessions.create",
            expectedProfileId: "fixture-profile",
            params: { agentId: "main" },
          },
          { type: "res", id: "retry", ok: true, payload: { key: "created-session" } },
        );
        // The retry is an ordered upstream barrier: the refused request never reached the backend.
        expect(requests.map((raw) => JSON.parse(raw).id)).toEqual(["other", "retry"]);
        expect(
          proxy.snapshot().events.filter(({ kind }) => kind === "controlled-refusal-written"),
        ).toEqual([expect.objectContaining({ requestId: "controlled", delivered: true })]);
      },
      false,
      false,
      new Set(),
      false,
      true,
    );
  });

  it("joins only the selected node fault while the operator still completes a canonical RPC", async () => {
    await withProxy(
      false,
      async ({ proxy, front, upstream, connectPeer }) => {
        const back = await upstream;
        await roundTrip(
          front,
          back,
          { type: "req", id: "operator", method: "connect", params: { role: "operator" } },
          { type: "res", id: "operator", ok: true, payload: {} },
        );
        const node = await connectPeer();
        const nodeBack = await node.upstream;
        await roundTrip(
          node.front,
          nodeBack,
          { type: "req", id: "node", method: "connect", params: { role: "node" } },
          { type: "res", id: "node", ok: true, payload: {} },
        );
        const nodeClosed = once(node.front, "close");
        const nodeBackendClosed = once(nodeBack, "close");
        const failed = await fixtureControl(proxy, "fail-node");
        await Promise.all([nodeClosed, nodeBackendClosed]);
        expect(failed.nodeFault).toBe(true);
        expect(failed.connectedOperators).toBe(1);
        await roundTrip(
          front,
          back,
          { type: "req", id: "authority-after-fault", method: "users.self" },
          {
            type: "res",
            id: "authority-after-fault",
            ok: true,
            payload: { user: { id: "fixture-user" } },
          },
        );
        const reconnect = await connectPeer();
        const reconnectBack = await reconnect.upstream;
        const forwarded: string[] = [];
        reconnectBack.on("message", (data) => forwarded.push(rawDataToString(data)));
        const refused = once(reconnect.front, "message");
        reconnect.front.send(
          JSON.stringify({
            type: "req",
            id: "node-retry",
            method: "connect",
            params: { role: "node" },
          }),
        );
        expect(JSON.parse((await refused)[0].toString())).toMatchObject({
          id: "node-retry",
          ok: false,
        });
        await fixtureControl(proxy, "release-node");
        await roundTrip(
          reconnect.front,
          reconnectBack,
          { type: "req", id: "node-restored", method: "connect", params: { role: "node" } },
          { type: "res", id: "node-restored", ok: true, payload: {} },
        );
        expect(forwarded.map((raw) => JSON.parse(raw).id)).toEqual(["node-restored"]);
        expect(proxy.snapshot().connectedOperators).toBe(1);
      },
      false,
      false,
      new Set(),
      false,
      true,
    );
  });

  it("binds fork restoration facts to the actual request without retaining editor payloads", async () => {
    await withProxy(
      false,
      async ({ proxy, front, upstream }) => {
        const back = await upstream;
        const image = Buffer.from("synthetic image fixture");
        const text = "private-editor-fixture";
        const payload = {
          sessionKey: "child-key",
          editorText: text,
          editorAttachments: [{ mimeType: "image/png", data: image.toString("base64") }],
        };
        await roundTrip(
          front,
          back,
          {
            type: "req",
            id: "fork-one",
            method: "sessions.fork",
            expectedProfileId: "fixture-profile",
            params: { sessionKey: "source-key", entryId: "entry-two", agentId: "qa" },
          },
          { type: "res", id: "fork-one", ok: true, payload },
        );
        expect(proxy.snapshot().events.filter(({ kind }) => kind === "fork-result")).toEqual([
          expect.objectContaining({
            requestId: "fork-one",
            ok: true,
            sourceSessionKey: "source-key",
            entryId: "entry-two",
            key: "child-key",
            editorTextSHA256: createHash("sha256").update(text).digest("hex"),
            attachmentCount: 1,
            imageMimeType: "image/png",
            imageBytes: image.length,
            imageSHA256: createHash("sha256").update(image).digest("hex"),
          }),
        ]);
        expect(JSON.stringify(proxy.snapshot())).not.toContain(text);
        expect(JSON.stringify(proxy.snapshot())).not.toContain(image.toString("base64"));
        await roundTrip(
          front,
          back,
          {
            type: "req",
            id: "reset-child",
            method: "sessions.reset",
            params: { key: "child-key", agentId: "qa" },
          },
          { type: "res", id: "reset-child", ok: true, payload: {} },
        );
        expect(proxy.snapshot().events).toContainEqual(
          expect.objectContaining({
            kind: "rpc-request",
            method: "sessions.reset",
            requestId: "reset-child",
            key: "child-key",
          }),
        );
        await roundTrip(
          front,
          back,
          {
            type: "req",
            id: "fork-error",
            method: "sessions.fork",
            params: { sessionKey: "child-key", entryId: "missing" },
          },
          {
            type: "res",
            id: "fork-error",
            ok: false,
            error: { code: "INVALID_REQUEST", message: "missing" },
          },
        );
        expect(
          proxy.snapshot().events.findLast(({ kind }) => kind === "fork-result"),
        ).toMatchObject({
          requestId: "fork-error",
          ok: false,
          sourceSessionKey: "child-key",
          entryId: "missing",
          attachmentCount: 0,
        });
      },
      false,
      false,
      new Set(),
      false,
      true,
    );
  });

  it("records committed create identity before holding the selected delivery", async () => {
    await withProxy(
      false,
      async ({ proxy, front, upstream }) => {
        const back = await upstream;
        const selector = { expectedProfileId: "fixture-profile", agentId: "qa" };
        await fixtureControl(proxy, "hold-response", "sessions.create", selector);
        await expectFixtureControlRejected(proxy, "drop-response");
        const received = once(back, "message");
        front.send(
          JSON.stringify({
            type: "req",
            id: "held-create",
            method: "sessions.create",
            expectedProfileId: selector.expectedProfileId,
            params: { agentId: "qa", key: "created-key" },
          }),
        );
        await received;
        const returned = once(front, "message");
        back.send(
          JSON.stringify({
            type: "res",
            id: "held-create",
            ok: true,
            payload: { key: "created-key" },
          }),
        );
        const held = await fixtureControl(proxy, "wait-held");
        expect(held.heldResponse).toMatchObject({ requestId: "held-create", ...selector });
        expect(held.events.filter(({ kind }) => kind === "mutation-success")).toEqual([
          expect.objectContaining({ requestId: "held-create", key: "created-key" }),
        ]);
        await fixtureControl(proxy, "release-response");
        expect(JSON.parse((await returned)[0].toString()).payload.key).toBe("created-key");
        await fixtureControl(proxy, "drop-response");
        await expectFixtureControlRejected(proxy, "hold-response", "sessions.create", selector);
      },
      false,
      false,
      new Set(),
      false,
      true,
    );
  });

  it("refuses a node fault after departure while its final close receipt is retained", async () => {
    await withProxy(
      false,
      async ({ proxy, front, upstream, connectPeer, server }) => {
        const back = await upstream;
        await roundTrip(
          front,
          back,
          { type: "req", id: "operator", method: "connect", params: { role: "operator" } },
          { type: "res", id: "operator", ok: true, payload: {} },
        );
        const node = await connectPeer();
        const nodeBack = await node.upstream;
        await roundTrip(
          node.front,
          nodeBack,
          { type: "req", id: "node", method: "connect", params: { role: "node" } },
          { type: "res", id: "node", ok: true, payload: {} },
        );
        const backendURL = "ws://127.0.0.1:" + (server.address() as AddressInfo).port + "/";
        const captured = createDeferred();
        let gate: ReturnType<typeof holdCloseNotification> | undefined;
        let refusing: Promise<void> | undefined;
        const originalTerminate = Object.getOwnPropertyDescriptor(WebSocket.prototype, "terminate")
          ?.value as WebSocket["terminate"] | undefined;
        assert(typeof originalTerminate === "function");
        const terminate = vi
          .spyOn(WebSocket.prototype, "terminate")
          .mockImplementation(function (this: WebSocket) {
            if (!gate && this.url === backendURL) {
              gate = holdCloseNotification(this, [], "departed-node-close");
              captured.resolve();
            }
            originalTerminate.call(this);
          });
        await runQaGatewayFixture(
          async () => {
            await closeGatewayTestWebSocket(node.front);
            await withTestTimeout(
              captured.promise,
              5000,
              "departed node close owner was not captured",
            );
            assert(gate);
            await withTestTimeout(gate.entered, 5000, "departed node close was not reached");
            refusing = expectFixtureControlRejected(proxy, "fail-node");
            void refusing.catch(() => {});
            await withTestTimeout(
              refusing,
              5000,
              "departed node was incorrectly admitted as a fault producer",
            );
            expect(proxy.snapshot().nodeFault).toBe(false);
            expect(
              proxy.snapshot().events.some(({ kind }) => kind === "controlled-node-fault"),
            ).toBe(false);
            await roundTrip(
              front,
              back,
              { type: "req", id: "operator-still-current", method: "users.self" },
              {
                type: "res",
                id: "operator-still-current",
                ok: true,
                payload: { user: { id: "fixture-user" } },
              },
            );
          },
          () => gate?.release(),
          async () => {
            await gate?.delivered;
            await refusing;
          },
          () => {
            gate?.restore();
            terminate.mockRestore();
          },
        );
      },
      false,
      false,
      new Set(),
      false,
      true,
    );
  });

  it("joins TLS probe and pre-handshake sockets with one cached stop receipt", async () => {
    await withProxy(
      false,
      async ({ proxy, front, upstream }) => {
        const back = await upstream;
        await roundTrip(
          front,
          back,
          { type: "req", id: "secure", method: "users.self" },
          { type: "res", id: "secure", ok: true, payload: { user: { id: "fixture-user" } } },
        );
        const port = Number(new URL(proxy.url).port);
        const probe = connectTLS({ host: "127.0.0.1", port, ca: PROXY_FIXTURE_CERTIFICATE });
        const probeClosed = new Promise<void>((resolve) => {
          probe.once("close", () => resolve());
        });
        let raw: Socket | undefined;
        let rawClosed: Promise<void> | undefined;
        let gate: ReturnType<typeof holdCloseNotification> | undefined;
        let stopped: Promise<void> | undefined;
        const order: string[] = [];
        const admitted = createDeferred<Socket>();
        const originalEmit = Object.getOwnPropertyDescriptor(EventEmitter.prototype, "emit")
          ?.value as EventEmitter["emit"] | undefined;
        assert(typeof originalEmit === "function");
        const observe = vi.spyOn(NetServer.prototype, "emit").mockImplementation(function (
          this: NetServer,
          event,
          ...args
        ) {
          const address = this.address();
          if (
            raw &&
            event === "connection" &&
            address &&
            typeof address !== "string" &&
            address.port === port
          ) {
            const socket = args[0] as Socket;
            gate = holdCloseNotification(socket, order, "raw-close");
            admitted.resolve(socket);
          }
          return Reflect.apply(originalEmit, this, [event, ...args]);
        });
        await runQaGatewayFixture(
          async () => {
            await once(probe, "secureConnect");
            expect(probe.authorized).toBe(true);
            probe.destroy();
            await probeClosed;
            raw = connectSocket({ host: "127.0.0.1", port });
            rawClosed = new Promise<void>((resolve) => {
              raw!.once("close", () => resolve());
            });
            await once(raw, "connect");
            const accepted = await admitted.promise;
            assert(gate);
            expect(proxy.snapshot().acceptedConnections).toBeGreaterThanOrEqual(2);
            const backendClosed = once(back, "close");
            stopped = proxy.stop();
            void stopped.then(() => order.push("stop"));
            expect(proxy.stop()).toBe(stopped);
            await withTestTimeout(
              Promise.all([gate.entered, backendClosed, rawClosed]),
              5000,
              "owned TLS sockets did not close",
            );
            expect(accepted.destroyed).toBe(true);
            expect(order).toEqual([]);
            gate.release();
            await gate.delivered;
            await stopped;
            expect(order).toEqual(["raw-close", "stop"]);
            expect(proxy.snapshot().acceptedConnections).toBe(0);
          },
          () => {
            gate?.release();
            probe.destroy();
            raw?.destroy();
          },
          async () => {
            await Promise.all([probeClosed, rawClosed, stopped ?? proxy.stop()]);
          },
          () => {
            gate?.restore();
            observe.mockRestore();
          },
        );
      },
      false,
      false,
      new Set(),
      false,
      false,
      true,
    );
  });
});
