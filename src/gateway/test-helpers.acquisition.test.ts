import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterAll, afterEach, describe, expect, it, vi, type TestContext } from "vitest";
import type WebSocketClient from "ws";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { runQaGatewayTestFixture } from "../../test/helpers/qa-gateway-test-lifetime.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "./minimal-gateway.test-helpers.js";
import { createGatewayFixtureFork } from "./server.fixture-lifetime.test-support.js";

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer }: typeof import("ws") = require(
  path.join(path.dirname(require.resolve("ws/package.json")), "index.js"),
);
type WebSocket = WebSocketClient;

const acquisitionFixture = vi.hoisted(() => ({
  start: vi.fn(),
  port: 0,
  reserve: vi.fn(),
  observeClient: undefined as ((client: WebSocket) => void) | undefined,
}));

async function observeWebSocket() {
  const actual = await vi.importActual<
    typeof import("../../packages/gateway-client/src/websocket.js")
  >("../../packages/gateway-client/src/websocket.js");
  class ObservedWebSocket extends actual.WebSocket {
    constructor(...args: ConstructorParameters<typeof actual.WebSocket>) {
      super(...args);
      acquisitionFixture.observeClient?.(this);
    }
  }
  return { ...actual, default: ObservedWebSocket, WebSocket: ObservedWebSocket };
}

vi.mock("ws", () => observeWebSocket());
vi.mock("../../packages/gateway-client/src/websocket.js", () => observeWebSocket());
vi.mock("./server.js", () => ({ startGatewayServer: acquisitionFixture.start }));
vi.mock("./test-helpers.listener.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./test-helpers.listener.js")>()),
  reserveGatewayTestListener: acquisitionFixture.reserve,
}));
vi.mock("../agents/prepared-model-runtime.test-support.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/prepared-model-runtime.test-support.js")>()),
  resetPreparedModelCatalogStateForTest: vi.fn(),
}));
vi.mock("../test-utils/ports.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../test-utils/ports.js")>()),
  getDeterministicFreePortBlock: async () => acquisitionFixture.port,
}));

const scenarios = new Set<Promise<void>>();
afterEach(async () => {
  // The test wrapper can time out first; peer/state ownership must settle before mocks reset.
  await Promise.allSettled(scenarios);
  scenarios.clear();
  acquisitionFixture.start.mockReset();
  acquisitionFixture.reserve.mockReset();
  acquisitionFixture.observeClient = undefined;
  vi.restoreAllMocks();
});

type PeerBehavior =
  | "hold upgrade"
  | "reject upgrade"
  | "no challenge"
  | "no response"
  | "reject auth"
  | "reject auth without close"
  | "transport error"
  | "upgrade then transport error"
  | "hello then transport error"
  | "reply";

type AcquisitionPeer = Awaited<ReturnType<typeof createAcquisitionPeer>>;
const failureOf = (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    (reason: unknown) => reason,
  );

const acquisitionCases = [
  ["tracked", "hold upgrade", "timeout waiting for ws open", 5_000, "upgrade"],
  ["tracked", "upgrade then transport error", "invalid opcode 3", 0, "upgrade"],
  ["shared auth", "no challenge", "missing connect.challenge nonce", 2_000, "challenge"],
  ["webchat", "transport error", "invalid opcode 3", 0, "response"],
  ["webchat", "hello then transport error", "invalid opcode 3", 0, "response"],
  ["device request", "no response", "timeout", 5_000, "response"],
  ...(["auth open", "tailscale open", "harness"] as const).flatMap(
    (helper) =>
      [
        [helper, "hold upgrade", "timeout waiting for ws open", 10_000, "upgrade"],
        [helper, "reject upgrade", "Unexpected server response: 403", 0, "upgrade"],
        [helper, "upgrade then transport error", "invalid opcode 3", 0, "upgrade"],
      ] as const,
  ),
  ["harness", "reject auth", "synthetic auth rejection", 0, "response"],
  ["harness", "transport error", "invalid opcode 3", 0, "response"],
  ["harness", "hello then transport error", "invalid opcode 3", 0, "response"],
  ["harness", "no response", "timeout", 37, "response"],
] as const;

async function createAcquisitionPeer(behavior: PeerBehavior) {
  const clients: WebSocket[] = [];
  const closed = new Set<WebSocket>();
  const closeEvents: Promise<void>[] = [];
  const releases: Array<() => void> = [];
  const operations: Promise<unknown>[] = [];
  const ownerCleanups: Array<() => Promise<void>> = [];
  const track = <T>(operation: Promise<T>): Promise<T> => {
    operations.push(operation);
    void operation.catch(() => {});
    return operation;
  };
  const errors: Error[] = [];
  const unownedErrors: Error[] = [];
  const transportFailure = createDeferred<Error>();
  const rejectAuth = behavior === "reject auth" || behavior === "reject auth without close";
  // Count owner handlers while keeping native errors local to this case.
  acquisitionFixture.observeClient = (client) => {
    clients.push(client);
    closeEvents.push(
      new Promise<void>((resolve) => {
        client.once("close", () => {
          closed.add(client);
          resolve();
        });
      }),
    );
    client.on("error", (error) => {
      errors.push(error);
      transportFailure.resolve(error);
      if (client.listenerCount("error") === 1) {
        unownedErrors.push(error);
      }
    });
  };
  const sockets = new Set<Socket>();
  const upgradeHeaders: IncomingHttpHeaders[] = [];
  const requests: ReturnType<typeof parseMinimalGatewayRequestFrame>[] = [];
  const connectReceived = createDeferred();
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("connection", (socket) => {
    sockets.add(socket);
    closeEvents.push(
      new Promise<void>((resolve) => {
        socket.once("close", () => {
          sockets.delete(socket);
          resolve();
        });
      }),
    );
  });
  server.on("upgrade", (request, socket, head) => {
    upgradeHeaders.push(request.headers);
    if (behavior === "reject upgrade") {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (behavior === "hold upgrade") {
      return;
    }
    if (behavior === "upgrade then transport error") {
      socket.cork();
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (behavior === "upgrade then transport error") {
        // Batch the native HTTP upgrade and invalid frame in one writev.
        socket.write(Buffer.from([0x83, 0x00]));
        socket.uncork();
        return;
      }
      if (behavior !== "no challenge") {
        sendMinimalGatewayConnectChallenge(ws);
      }
      ws.on("message", (data) => {
        const frame = parseMinimalGatewayRequestFrame(data);
        requests.push(frame);
        if (frame.method !== "connect") {
          return;
        }
        connectReceived.resolve();
        if (behavior === "transport error" || behavior === "hello then transport error") {
          socket.cork();
          if (behavior === "hello then transport error") {
            sendMinimalGatewayResponse(ws, frame.id!, buildMinimalGatewayHelloOkPayload());
          }
          // A coalesced hello and invalid opcode must not become a successful acquisition.
          socket.write(Buffer.from([0x83, 0x00]));
          socket.uncork();
          return;
        }
        if (behavior === "no response") {
          return;
        }
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: !rejectAuth,
            ...(rejectAuth
              ? { error: { code: "UNAUTHORIZED", message: "synthetic auth rejection" } }
              : { payload: buildMinimalGatewayHelloOkPayload() }),
          }),
        );
        if (behavior === "reject auth without close") {
          ws.pause();
        }
      });
    });
  });
  const close = async () => {
    // Release a withheld close handshake only after acquisition has entered server cleanup.
    wss.clients.forEach((peer) => peer.resume());
    if (server.listening) {
      await closeHttpServer(server);
    }
  };
  let disposal: Promise<void> | undefined;
  const dispose = () =>
    (disposal ??= runQaGatewayFixture(
      async () => {},
      () => runQaGatewayFixture(async () => {}, ...releases),
      async () => {
        // Start every close before joining; one rejection must not leave a sibling running.
        const closures = clients.map(closeGatewayTestWebSocket);
        sockets.forEach((socket) => socket.destroy());
        const results = await Promise.allSettled([...closures, ...closeEvents]);
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length) {
          throw new AggregateError(failures, "Acquisition sockets did not close");
        }
      },
      () => Promise.allSettled(operations),
      () => runQaGatewayFixture(async () => {}, ...ownerCleanups),
      () => closeMinimalGatewayServer(wss),
      close,
    ));
  try {
    const port = Number(new URL(await listenLoopback(server)).port);
    return {
      port,
      clients,
      closed,
      errors,
      unownedErrors,
      requests,
      upgradeHeaders,
      track,
      releaseOnCleanup: (release: () => void) => {
        releases.push(release);
      },
      closeOwnerOnCleanup: (cleanup: () => Promise<void>) => {
        ownerCleanups.push(cleanup);
      },
      waitForPhase: async (phase: "upgrade" | "challenge" | "response", signal: AbortSignal) => {
        if (phase === "response") {
          return await racePromiseWithAbortSignal(connectReceived.promise, signal);
        }
        await once(server, "upgrade", { signal });
        if (phase === "challenge" && clients.at(-1)!.readyState !== WebSocket.OPEN) {
          await once(clients.at(-1)!, "open", { signal });
        }
      },
      isListening: () => server.listening,
      failTransport: () => {
        for (const socket of sockets) {
          socket.write(Buffer.from([0x83, 0x00]));
        }
        return transportFailure.promise;
      },
      close,
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    return await runQaGatewayFixture(async (): Promise<never> => {
      throw error;
    }, dispose);
  }
}

function withPeerState(
  context: Pick<TestContext, "signal" | "onTestFinished">,
  label: string,
  behavior: PeerBehavior,
  body: (peer: AcquisitionPeer, state: OpenClawTestState) => Promise<void>,
  env?: Record<string, string>,
) {
  const scenario = runQaGatewayTestFixture(context, async (lifetime) => {
    const { withOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
    let callbackFailure: { reason: unknown } | undefined;
    try {
      await withOpenClawTestState(
        { label, env, verifyCleanup: lifetime.verifyCleanup },
        async (state) => {
          try {
            context.signal.throwIfAborted();
            const peer = await createAcquisitionPeer(behavior);
            await runQaGatewayFixture(
              async () => {
                // Non-cancelable setup may finish after timeout; do not admit another producer then.
                context.signal.throwIfAborted();
                await body(peer, state);
              },
              () => lifetime.verifyCleanup(peer[Symbol.asyncDispose]),
            );
          } catch (reason) {
            // The state owner must see hasUnjoinedWork before deciding whether removal is safe.
            callbackFailure = { reason };
            throw reason;
          }
        },
      );
    } catch (reason) {
      if (callbackFailure && callbackFailure.reason !== reason) {
        throw new AggregateError(
          [callbackFailure.reason, reason],
          "Acquisition state cleanup failed",
          { cause: reason },
        );
      }
      throw reason;
    }
  });
  scenarios.add(scenario);
  return scenario;
}

function expectClosedClient(peer: AcquisitionPeer) {
  expect(peer.clients).toHaveLength(1);
  const client = peer.clients[0]!;
  expect(client.readyState).toBe(WebSocket.CLOSED);
  expect(peer.closed.has(client)).toBe(true);
  return client;
}

function mockPeerGateway(peer: AcquisitionPeer, close = peer.close) {
  const server = {
    close,
    startupSettled: Promise.resolve(),
    getTailscaleIngressEndpoint: () => undefined,
  } satisfies import("./server.js").GatewayServer;
  acquisitionFixture.port = peer.port;
  // The peer owns the listener; reserve without binding it again.
  acquisitionFixture.reserve.mockResolvedValue({
    port: peer.port,
    start: async (run: () => Promise<unknown>) => run(),
    closeUnadopted: async () => {},
  });
  return acquisitionFixture.start.mockImplementation(async () => {
    // Mirror the real startup-owned selector for close-order assertions.
    process.env.OPENCLAW_GATEWAY_PORT = String(peer.port);
    return server;
  });
}

type CompositeAcquisitionCase = {
  helper: "raw" | "GatewayClient";
  shutdown: "joined" | "rejected";
};

// The disposable fork imports the same assertions without registering sibling cases.
export async function verifyCompositeAcquisition(
  { helper, shutdown }: CompositeAcquisitionCase,
  context: TestContext,
): Promise<void> {
  await withPeerState(
    context,
    "composite-acquisition",
    helper === "raw" ? "reject auth" : "reject auth without close",
    async (peer, state) => {
      const closing = createDeferred();
      const release = createDeferred();
      peer.releaseOnCleanup(release.resolve);
      const closeError = new Error("synthetic server close failure");
      mockPeerGateway(peer, async () => {
        closing.resolve();
        await release.promise;
        if (shutdown === "rejected") {
          throw closeError;
        }
        await peer.close();
      });
      const { startConnectedServerWithClient } = await import("./test-helpers.server.js");
      const { startGatewayWithClient } = await import("./test-helpers.e2e.js");
      const { GatewayClient } = await import("./client.js");
      // oxlint-disable-next-line typescript/unbound-method -- The observer calls the original on its acquired client.
      const stopAndWait = GatewayClient.prototype.stopAndWait;
      let clientStopSettled = false;
      using stopSpy = vi.spyOn(GatewayClient.prototype, "stopAndWait");
      stopSpy.mockImplementation(async function (
        this: InstanceType<typeof GatewayClient>,
        options,
      ) {
        await stopAndWait.call(this, options);
        clientStopSettled = true;
      });
      const selector = helper === "raw" ? "OPENCLAW_GATEWAY_TOKEN" : "OPENCLAW_GATEWAY_PORT";
      const ownedSelector = helper === "raw" ? "synthetic-owned-token" : String(peer.port);
      const previousSelector = process.env[selector];
      context.signal.throwIfAborted();
      const started: Promise<unknown> =
        helper === "GatewayClient"
          ? startGatewayWithClient({
              port: peer.port,
              cfg: {},
              configPath: state.statePath("client-config.json"),
              token: "synthetic-token",
            })
          : startConnectedServerWithClient("synthetic-owned-token");
      const acquisition = peer.track(started).catch((error: unknown) => error);
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            closing.promise,
            started,
            "Acquisition ended before server shutdown",
          ),
          context.signal,
        );
        expect(process.env[selector]).toBe(ownedSelector);
        expect(peer.isListening()).toBe(true);
        // GatewayClient owns a bounded stop; raw helpers promise the transport close event.
        if (helper === "GatewayClient") {
          expect(peer.clients).toHaveLength(1);
          expect(clientStopSettled).toBe(true);
        } else {
          expect(peer.clients.every((client) => peer.closed.has(client))).toBe(true);
        }
        release.resolve();
        const result = await withinTest(acquisition, context.signal);
        const originalError = result instanceof AggregateError ? result.errors[0] : result;
        expect(originalError).toMatchObject({
          message: expect.stringContaining("synthetic auth rejection"),
        });
        if (shutdown === "rejected") {
          expect(result).toBeInstanceOf(AggregateError);
          expect(result).toHaveProperty("errors", [originalError, closeError]);
        } else {
          expect(result).toBe(originalError);
        }
        expect(process.env[selector]).toBe(
          shutdown === "rejected" ? ownedSelector : previousSelector,
        );
        expect(peer.isListening()).toBe(shutdown === "rejected");
      } finally {
        release.resolve();
        await acquisition;
      }
    },
    { OPENCLAW_GATEWAY_TOKEN: "synthetic-prior-token" },
  );
}

describe("raw Gateway helper acquisition ownership", async () => {
  // Prepare during collection; each isolated child keeps its own shutdown deadline.
  const fixtureWorkers = createVitestWorkerRun();
  afterAll(() => fixtureWorkers.dispose());
  try {
    await fixtureWorkers.prepare();
  } catch (error) {
    await fixtureWorkers.dispose();
    throw error;
  }
  const runRetainedAcquisitionFork = createGatewayFixtureFork(
    fixtureWorkers,
    afterAll,
    2 * 1024 * 1024,
  );

  it.for(acquisitionCases)(
    "%s owns cleanup after %s",
    async ([helper, behavior, error, timeoutMs, phase], context) => {
      await withPeerState(context, "raw-acquisition", behavior, async (peer) => {
        const { openTrackedWs } = await import("./device-authz.test-helpers.js");
        const { openAuthenticatedGatewayWs } = await import("./shared-auth.test-helpers.js");
        const { connectDeviceAuthReq } = await import("./test-helpers.e2e.js");
        const { connectWebchatClient } = await import("./test-helpers.server.js");
        const { testState } = await import("./test-helpers.runtime-state.js");
        const { openWs, openTailscaleWs } = await import("./server.auth.test-helpers.js");
        let harness:
          | Awaited<
              ReturnType<(typeof import("./server.e2e-ws-harness.js"))["startGatewayServerHarness"]>
            >
          | undefined;
        if (helper === "harness") {
          mockPeerGateway(peer);
          const { startGatewayServerHarness } = await import("./server.e2e-ws-harness.js");
          harness = await startGatewayServerHarness();
          peer.closeOwnerOnCleanup(harness.close);
        }
        context.signal.throwIfAborted();
        testState.gatewayAuth = { mode: "token", token: "synthetic-token" };
        const acquire = () =>
          peer.track<unknown>(
            helper === "harness"
              ? harness!.openClient({
                  token: "synthetic-token",
                  device: null,
                  timeoutMs: behavior === "no response" ? 37 : undefined,
                })
              : helper === "auth open"
                ? openWs(peer.port)
                : helper === "tailscale open"
                  ? openTailscaleWs({ host: "127.0.0.1", port: peer.port })
                  : helper === "tracked"
                    ? openTrackedWs(peer.port, { "x-acquisition-test": "tracked" })
                    : helper === "webchat"
                      ? connectWebchatClient({ port: peer.port })
                      : helper === "shared auth"
                        ? openAuthenticatedGatewayWs(peer.port, "synthetic-token")
                        : connectDeviceAuthReq({
                            url: `ws://127.0.0.1:${peer.port}`,
                            token: "synthetic-token",
                          }),
          );
        // Observe rejection immediately; none of these rows has an unbounded open wait.
        const verifyFailure = (failure: unknown) => {
          if (
            behavior === "upgrade then transport error" ||
            behavior === "hello then transport error" ||
            behavior === "transport error" ||
            behavior === "reject upgrade"
          ) {
            expect(
              peer.errors[0],
              "native error must precede acquisition settlement",
            ).toBeInstanceOf(Error);
            if (behavior !== "reject upgrade") {
              expect(peer.errors[0]).toMatchObject({ code: "WS_ERR_INVALID_OPCODE" });
            }
            expect(failure).toBe(peer.errors[0]);
          }
          expect(peer.unownedErrors).toEqual([]);
          expect(failure).toBeInstanceOf(Error);
          expect(failure).toMatchObject({
            message: behavior === "no response" ? "timeout" : expect.stringContaining(error),
          });
          if (behavior === "no response") {
            expect(peer.requests).toHaveLength(1);
            expect(peer.requests[0]).toMatchObject({
              method: "connect",
              params: { auth: { token: "synthetic-token" } },
            });
          }
          expect(peer.isListening(), "a failed socket cannot close its borrowed server").toBe(true);
          const client = expectClosedClient(peer);
          expect(client.listenerCount("open")).toBe(0);
        };
        if (!timeoutMs) {
          verifyFailure(await withinTest(failureOf(acquire()), context.signal));
          return;
        }
        const readinessAbort = new AbortController();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const ready = peer.waitForPhase(
          phase,
          AbortSignal.any([context.signal, readinessAbort.signal]),
        );
        const failure = failureOf(acquire());
        // Observe settlement before the clock driver can process later native cleanup.
        const checked = failure.then(verifyFailure);
        void checked.catch(() => {});
        try {
          await withinTest(
            awaitGateBeforeSettlement(ready, failure, "Acquisition ended before its timeout phase"),
            context.signal,
          );
          // Opening settles before shared-auth installs its challenge waiter.
          await vi.advanceTimersByTimeAsync(0);
          await vi.advanceTimersByTimeAsync(timeoutMs - 1);
          expect(peer.clients[0]?.readyState).toBe(
            phase === "upgrade" ? WebSocket.CONNECTING : WebSocket.OPEN,
          );
          await vi.advanceTimersByTimeAsync(1);
          await racePromiseWithAbortSignal(checked, context.signal);
        } finally {
          readinessAbort.abort();
          vi.useRealTimers();
          await Promise.allSettled([ready]);
        }
      });
    },
  );

  it.for(["auth open", "tailscale default", "tailscale override"] as const)(
    "%s preserves headers and nonce observation without authenticating",
    async (helper, context) => {
      await withPeerState(context, "auth-opener-success", "reply", async (peer) => {
        const { openWs, openTailscaleWs, readConnectChallengeNonce } =
          await import("./server.auth.test-helpers.js");
        const { getTrackedConnectChallengeNonce } = await import("./test-helpers.js");
        const overrides = { "tailscale-user-login": "operator", "tailscale-user-name": "Operator" };
        context.signal.throwIfAborted();
        const ws = await withinTest(
          peer.track(
            helper === "auth open"
              ? openWs(peer.port, {
                  "x-acquisition-test": "auth",
                  origin: "https://control.example.com",
                })
              : openTailscaleWs(
                  { host: "127.0.0.1", port: peer.port },
                  helper === "tailscale override" ? overrides : undefined,
                ),
          ),
          context.signal,
        );
        expect(ws).toBe(peer.clients[0]);
        expect(ws.readyState).toBe(WebSocket.OPEN);
        expect(await withinTest(readConnectChallengeNonce(ws), context.signal)).toBe("test-nonce");
        expect(getTrackedConnectChallengeNonce(ws)).toBe("test-nonce");
        expect(peer.upgradeHeaders).toHaveLength(1);
        expect(peer.upgradeHeaders[0]).toMatchObject(
          helper === "auth open"
            ? { "x-acquisition-test": "auth", origin: "https://control.example.com" }
            : {
                "x-forwarded-for": "100.64.0.1",
                "x-forwarded-proto": "https",
                "x-forwarded-host": "gateway.tailnet.ts.net",
                "tailscale-user-login": helper === "tailscale override" ? "operator" : "peter",
                "tailscale-user-name": helper === "tailscale override" ? "Operator" : "Peter",
              },
        );
        expect(peer.requests).toEqual([]);
        expect(peer.unownedErrors).toEqual([]);
        expect(ws.listenerCount("open")).toBe(0);
        expect(peer.isListening()).toBe(true);
      });
    },
  );

  it("returns the harness hello and forwards the actual connect options", async (context) => {
    await withPeerState(context, "harness-options", "reply", async (peer) => {
      mockPeerGateway(peer);
      const { startGatewayServerHarness } = await import("./server.e2e-ws-harness.js");
      const harness = await startGatewayServerHarness();
      peer.closeOwnerOnCleanup(harness.close);
      context.signal.throwIfAborted();
      const result = await withinTest(
        peer.track(
          harness.openClient({
            device: null,
            token: "synthetic-token",
            browserOrigin: "https://control.example.com",
            client: { id: "test-client", version: "fixture", platform: "test", mode: "test" },
            minProtocol: 3,
            maxProtocol: 3,
            role: "operator",
            scopes: ["operator.read"],
            caps: ["tool-events"],
            commands: ["system.run"],
            permissions: { screenRecording: false },
            includeSessionMessageBodies: true,
            timeoutMs: 37,
          }),
        ),
        context.signal,
      );
      expect(result.ws).toBe(peer.clients[0]);
      expect(result.hello).toEqual(buildMinimalGatewayHelloOkPayload());
      expect(peer.upgradeHeaders[0]).toMatchObject({ origin: "https://control.example.com" });
      expect(peer.requests).toHaveLength(1);
      expect(peer.requests[0]).toMatchObject({
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: { id: "test-client", version: "fixture", platform: "test", mode: "test" },
          role: "operator",
          scopes: ["operator.read"],
          auth: { token: "synthetic-token" },
          caps: ["tool-events"],
          commands: ["system.run"],
          permissions: { screenRecording: false },
          includeSessionMessageBodies: true,
        },
      });
      expect(peer.requests[0]?.params).not.toHaveProperty("device");
      expect(peer.unownedErrors).toEqual([]);
      expect(result.ws.listenerCount("open")).toBe(0);
      expect(peer.isListening()).toBe(true);
    });
  });

  it.for(["assertion failure", "cancellation", "early rejection"] as const)(
    "joins the actual preparation and acquisition after %s before resetting observers",
    async (failure, context) => {
      const cancelled = new AbortController();
      const signal = AbortSignal.any([context.signal, cancelled.signal]);
      const primary = new Error("synthetic preparation failure");
      let expected: unknown = primary;
      let preparationFinished = false;
      let acquisitionJoined = false;
      let ownedPeer: AcquisitionPeer | undefined;
      const scenario = withPeerState(
        { signal, onTestFinished: context.onTestFinished },
        "acquisition-unwind",
        "reply",
        async (peer) => {
          ownedPeer = peer;
          const entered = createDeferred();
          const release = createDeferred();
          peer.releaseOnCleanup(release.resolve);
          const devicePairing = await import("../infra/device-pairing.js");
          vi.spyOn(devicePairing, "getPairedDevice").mockImplementation(async () => {
            try {
              if (failure !== "early rejection") {
                entered.resolve();
                await release.promise;
              }
              throw primary;
            } finally {
              preparationFinished = true;
            }
          });
          const { connectWebchatClient } = await import("./test-helpers.server.js");
          signal.throwIfAborted();
          const operation = peer.track(
            connectWebchatClient({ port: peer.port }).finally(() => {
              acquisitionJoined = true;
            }),
          );
          await withinTest(
            awaitGateBeforeSettlement(
              entered.promise,
              operation,
              "Acquisition ended before preparation",
            ),
            signal,
          );
          if (failure === "cancellation") {
            cancelled.abort(primary);
            await withinTest(release.promise, signal);
          } else {
            try {
              expect(acquisitionJoined, "held preparation must remain owned").toBe(true);
            } catch (reason) {
              expected = reason;
              throw reason;
            }
          }
        },
      );
      const result = await failureOf(scenario);
      expect(result).toBe(expected);
      expect(preparationFinished).toBe(true);
      expect(acquisitionJoined).toBe(true);
      expect(ownedPeer).toBeDefined();
      expectClosedClient(ownedPeer!);
      expect(ownedPeer!.unownedErrors).toEqual([]);
      expect(acquisitionFixture.observeClient).toBeTypeOf("function");
    },
  );

  it("retains the native error until awaited webchat preparation finishes", async (context) => {
    await withPeerState(context, "webchat-preparation", "reply", async (peer) => {
      const preparing = createDeferred();
      const release = createDeferred();
      peer.releaseOnCleanup(release.resolve);
      const preparationError = new Error("synthetic preparation failure");
      let preparationFinished = false;
      const devicePairing = await import("../infra/device-pairing.js");
      vi.spyOn(devicePairing, "getPairedDevice").mockImplementation(async () => {
        preparing.resolve();
        await release.promise;
        preparationFinished = true;
        throw preparationError;
      });
      const { connectWebchatClient } = await import("./test-helpers.server.js");
      let settled = false;
      context.signal.throwIfAborted();
      const acquisition = peer
        .track(connectWebchatClient({ port: peer.port }))
        .finally(() => {
          settled = true;
        })
        .catch((error: unknown) => error);
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            preparing.promise,
            acquisition,
            "Webchat acquisition ended before preparation",
          ),
          context.signal,
        );
        const transportError = await withinTest(peer.failTransport(), context.signal);
        await setImmediate();
        const settledDuringPreparation = settled;
        release.resolve();
        expect(await withinTest(acquisition, context.signal)).toBe(transportError);
        expect(settledDuringPreparation).toBe(false);
        expect(preparationFinished).toBe(true);
        expect(peer.unownedErrors).toEqual([]);
        expect(peer.closed.has(peer.clients[0]!)).toBe(true);
        expect(peer.isListening()).toBe(true);
      } finally {
        release.resolve();
        await acquisition;
      }
    });
  });

  it("restores the token environment when server startup rejects before acquisition", async (context) => {
    await withPeerState(
      context,
      "server-start-rejection",
      "reply",
      async (peer) => {
        const startupError = new Error("synthetic server startup failure");
        mockPeerGateway(peer).mockRejectedValue(startupError);
        const { startServerWithClient } = await import("./test-helpers.server.js");
        const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
        context.signal.throwIfAborted();
        await withinTest(
          expect(peer.track(startServerWithClient("synthetic-owned-token"))).rejects.toBe(
            startupError,
          ),
          context.signal,
        );
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe(previousToken);
        expect(peer.clients).toEqual([]);
      },
      { OPENCLAW_GATEWAY_TOKEN: "synthetic-prior-token" },
    );
  });

  it.for([
    { helper: "raw", shutdown: "joined" },
    { helper: "raw", shutdown: "rejected" },
    { helper: "GatewayClient", shutdown: "joined" },
    { helper: "GatewayClient", shutdown: "rejected" },
  ] as const)(
    "$helper retains server ownership after authentication failure and $shutdown shutdown",
    async (scenario, context) => {
      if (scenario.helper === "raw" && scenario.shutdown === "rejected") {
        // Rejected close retains its owner; each case still needs a fresh native worker.
        await runRetainedAcquisitionFork(
          context,
          (_repoRoot, root) => `
import fs from "node:fs";
import { it, vi } from "vitest";
vi.mock("vitest", async (importOriginal) => ({
  ...(await importOriginal()),
  describe: () => {},
}));
fs.writeFileSync(${JSON.stringify(path.join(root, "worker.pid"))}, String(process.pid));
const { verifyCompositeAcquisition } = await import(${JSON.stringify(import.meta.filename)});
it("retains a failed acquisition owner", async (context) => {
  await verifyCompositeAcquisition(${JSON.stringify(scenario)}, context);
});
`,
        );
      } else {
        await verifyCompositeAcquisition(scenario, context);
      }
    },
  );

  it("joins the one-shot device socket close before returning its response", async (context) => {
    await withPeerState(context, "device-acquisition-response", "reply", async (peer) => {
      const { connectDeviceAuthReq } = await import("./test-helpers.e2e.js");
      context.signal.throwIfAborted();
      const response = await withinTest(
        peer.track(
          connectDeviceAuthReq({
            url: `ws://127.0.0.1:${peer.port}`,
            token: "synthetic-token",
          }),
        ),
        context.signal,
      );
      expect(response).toMatchObject({ type: "res", id: "c1", ok: true });
      expect(peer.requests).toHaveLength(1);
      expect(peer.requests[0]).toMatchObject({
        params: { auth: { token: "synthetic-token" }, device: { nonce: "test-nonce" } },
      });
      expectClosedClient(peer);
    });
  });
});
