import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type WebSocketClient from "ws";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
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

afterEach(() => {
  acquisitionFixture.start.mockReset();
  acquisitionFixture.reserve.mockReset();
  acquisitionFixture.observeClient = undefined;
  vi.restoreAllMocks();
});

type PeerBehavior =
  | "hold upgrade"
  | "no challenge"
  | "no response"
  | "reject auth"
  | "reject auth without close"
  | "transport error"
  | "upgrade then transport error"
  | "hello then transport error"
  | "reply";

type AcquisitionPeer = Awaited<ReturnType<typeof createAcquisitionPeer>>;

async function createAcquisitionPeer(behavior: PeerBehavior) {
  const clients: WebSocket[] = [];
  const closed = new Set<WebSocket>();
  const errors: Error[] = [];
  const unownedErrors: Error[] = [];
  const transportFailure = createDeferred<Error>();
  const rejectAuth = behavior === "reject auth" || behavior === "reject auth without close";
  // Observe the real dependency; keep otherwise-unhandled errors local to this case.
  // Counting the remaining listeners makes a removed owner handler observable.
  acquisitionFixture.observeClient = (client) => {
    clients.push(client);
    client.once("close", () => closed.add(client));
    client.on("error", (error) => {
      errors.push(error);
      transportFailure.resolve(error);
      if (client.listenerCount("error") === 1) {
        unownedErrors.push(error);
      }
    });
  };
  const sockets = new Set<Socket>();
  const requests: ReturnType<typeof parseMinimalGatewayRequestFrame>[] = [];
  const connectReceived = createDeferred();
  let receivedUpgrade = false;
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    receivedUpgrade = true;
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
        if (behavior !== "no response") {
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
  const dispose = async () => {
    // Assertions precede this safety net, including for still-CONNECTING sockets.
    const clientClosures = clients.map(closeGatewayTestWebSocket);
    sockets.forEach((socket) => socket.destroy());
    await Promise.all(clientClosures);
    await closeMinimalGatewayServer(wss);
    await close();
  };
  try {
    const port = Number(new URL(await listenLoopback(server)).port);
    return {
      port,
      clients,
      closed,
      errors,
      unownedErrors,
      requests,
      receivedUpgrade: () => receivedUpgrade,
      waitForUpgrade: (signal: AbortSignal) => once(server, "upgrade", { signal }),
      waitForOpen: async (signal: AbortSignal) => {
        await once(server, "upgrade", { signal });
        const client = clients.at(-1);
        if (!client) {
          throw new Error("acquisition peer has no opening client");
        }
        if (client.readyState !== WebSocket.OPEN) {
          await once(client, "open", { signal });
        }
      },
      waitForConnect: (signal: AbortSignal) =>
        racePromiseWithAbortSignal(connectReceived.promise, signal),
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
    await dispose();
    throw error;
  }
}

async function withPeerState(
  label: string,
  behavior: PeerBehavior,
  body: (peer: AcquisitionPeer, state: OpenClawTestState) => Promise<void>,
  env?: Record<string, string>,
) {
  const { withOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
  await withOpenClawTestState({ label, env }, async (state) => {
    await using peer = await createAcquisitionPeer(behavior);
    await body(peer, state);
  });
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
  // This peer already owns the socket; exercise client acquisition and cleanup
  // without asking the real reservation owner to bind a second listener.
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

async function verifyAcquisitionTimeout(
  peer: AcquisitionPeer,
  timeoutMs: number,
  signal: AbortSignal,
  acquire: () => Promise<unknown>,
  verifyFailure: (failure: unknown) => void,
  phase: "upgrade" | "challenge" | "response" = "upgrade",
): Promise<void> {
  const readinessAbort = new AbortController();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const readinessSignal = AbortSignal.any([signal, readinessAbort.signal]);
  const ready =
    phase === "upgrade"
      ? peer.waitForUpgrade(readinessSignal)
      : phase === "challenge"
        ? peer.waitForOpen(readinessSignal)
        : peer.waitForConnect(readinessSignal);
  const failure = acquire().then(
    () => undefined,
    (reason: unknown) => reason,
  );
  // Observe settlement before the clock driver can process later native cleanup.
  const checked = failure.then(verifyFailure);
  void checked.catch(() => {});
  try {
    expect(await Promise.race([ready.then(() => "ready"), failure.then(() => "settled")])).toBe(
      "ready",
    );
    // Opening settles before shared-auth installs its challenge waiter.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(peer.clients[0]?.readyState).toBe(
      phase === "upgrade" ? WebSocket.CONNECTING : WebSocket.OPEN,
    );
    await vi.advanceTimersByTimeAsync(1);
    await racePromiseWithAbortSignal(checked, signal);
  } catch (error) {
    vi.useRealTimers();
    return await runQaGatewayFixture(
      async () => {
        throw error;
      },
      () => Promise.all(peer.clients.map(closeGatewayTestWebSocket)),
      () => Promise.allSettled([failure, checked]),
    );
  } finally {
    readinessAbort.abort();
    vi.useRealTimers();
    await Promise.allSettled([ready]);
  }
}

type CompositeAcquisitionCase = {
  helper: "raw" | "GatewayClient";
  shutdown: "joined" | "rejected";
};

// The disposable fork imports the same assertions without registering sibling cases.
export async function verifyCompositeAcquisition({
  helper,
  shutdown,
}: CompositeAcquisitionCase): Promise<void> {
  await withPeerState(
    "composite-acquisition",
    helper === "raw" ? "reject auth" : "reject auth without close",
    async (peer, state) => {
      const closing = createDeferred();
      const release = createDeferred();
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
      const started =
        helper === "GatewayClient"
          ? startGatewayWithClient({
              port: peer.port,
              cfg: {},
              configPath: state.statePath("client-config.json"),
              token: "synthetic-token",
            })
          : startConnectedServerWithClient("synthetic-owned-token");
      const acquisition = started.catch((error: unknown) => error);
      try {
        const first = await Promise.race([
          closing.promise.then(() => "closing"),
          acquisition.then(() => "settled"),
        ]);
        expect(first).toBe("closing");
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
        const result = await acquisition;
        const originalError = result instanceof AggregateError ? result.errors[0] : result;
        expect(originalError).toMatchObject({
          message: expect.stringContaining("synthetic auth rejection"),
        });
        if (shutdown === "rejected") {
          expect(result).toBeInstanceOf(AggregateError);
          expect(result).toHaveProperty("errors", [originalError, closeError]);
          expect(process.env[selector]).toBe(ownedSelector);
          expect(peer.isListening()).toBe(true);
        } else {
          expect(result).toBe(originalError);
          expect(process.env[selector]).toBe(previousSelector);
          expect(peer.isListening()).toBe(false);
        }
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

  it.for([
    { helper: "tracked", behavior: "hold upgrade", error: "timeout waiting for ws open" },
    { helper: "tracked", behavior: "upgrade then transport error", error: "invalid opcode 3" },
    { helper: "shared auth", behavior: "no challenge", error: "missing connect.challenge nonce" },
    { helper: "webchat", behavior: "transport error", error: "invalid opcode 3" },
    { helper: "webchat", behavior: "hello then transport error", error: "invalid opcode 3" },
    { helper: "device request", behavior: "no response", error: "timeout" },
  ] as const)(
    "$helper owns cleanup after $behavior",
    async ({ helper, behavior, error }, context) => {
      await withPeerState("raw-acquisition", behavior, async (peer) => {
        const { openTrackedWs } = await import("./device-authz.test-helpers.js");
        const { openAuthenticatedGatewayWs } = await import("./shared-auth.test-helpers.js");
        const { connectDeviceAuthReq } = await import("./test-helpers.e2e.js");
        const { connectWebchatClient } = await import("./test-helpers.server.js");
        const { testState } = await import("./test-helpers.runtime-state.js");
        testState.gatewayAuth = { mode: "token", token: "synthetic-token" };
        const acquire = () =>
          helper === "tracked"
            ? openTrackedWs(peer.port, { "x-acquisition-test": "tracked" })
            : helper === "webchat"
              ? connectWebchatClient({ port: peer.port })
              : helper === "shared auth"
                ? openAuthenticatedGatewayWs(peer.port, "synthetic-token")
                : connectDeviceAuthReq({
                    url: `ws://127.0.0.1:${peer.port}`,
                    token: "synthetic-token",
                  });
        // Observe rejection immediately; none of these rows has an unbounded open wait.
        const verifyFailure = (failure: unknown) => {
          if (
            behavior === "upgrade then transport error" ||
            behavior === "hello then transport error"
          ) {
            expect(
              peer.errors[0],
              "native error must precede acquisition settlement",
            ).toMatchObject({
              code: "WS_ERR_INVALID_OPCODE",
            });
            expect(failure).toBe(peer.errors[0]);
          }
          expect(peer.unownedErrors).toEqual([]);
          expect(failure).toBeInstanceOf(Error);
          expect(failure).toMatchObject({ message: expect.stringContaining(error) });
          if (behavior === "hold upgrade") {
            expect(peer.receivedUpgrade(), "the peer must receive the withheld upgrade").toBe(true);
          }
          if (behavior === "no response") {
            expect(failure).toMatchObject({ message: "timeout" });
          }
          expect(peer.isListening(), "a failed socket cannot close its borrowed server").toBe(true);
          if (behavior === "no response") {
            expect(peer.requests).toHaveLength(1);
            expect(peer.requests[0]).toMatchObject({
              method: "connect",
              params: { auth: { token: "synthetic-token" } },
            });
          }
          const client = expectClosedClient(peer);
          expect(client.listenerCount("open")).toBe(0);
        };
        if (behavior === "hold upgrade") {
          await verifyAcquisitionTimeout(peer, 5_000, context.signal, acquire, verifyFailure);
        } else if (behavior === "no challenge" || behavior === "no response") {
          await verifyAcquisitionTimeout(
            peer,
            behavior === "no response" ? 5_000 : 2_000,
            context.signal,
            acquire,
            verifyFailure,
            behavior === "no challenge" ? "challenge" : "response",
          );
        } else {
          verifyFailure(
            await acquire().then(
              () => undefined,
              (reason: unknown) => reason,
            ),
          );
        }
      });
    },
  );

  it("retains the native error until awaited webchat preparation finishes", async () => {
    await withPeerState("webchat-preparation", "reply", async (peer) => {
      const preparing = createDeferred();
      const release = createDeferred();
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
      const acquisition = connectWebchatClient({ port: peer.port })
        .finally(() => {
          settled = true;
        })
        .catch((error: unknown) => error);
      try {
        await preparing.promise;
        const transportError = await peer.failTransport();
        await setImmediate();
        const settledDuringPreparation = settled;
        release.resolve();
        expect(await acquisition).toBe(transportError);
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

  it("restores the token environment when server startup rejects before acquisition", async () => {
    await withPeerState(
      "server-start-rejection",
      "reply",
      async (peer) => {
        const startupError = new Error("synthetic server startup failure");
        mockPeerGateway(peer).mockRejectedValue(startupError);
        const { startServerWithClient } = await import("./test-helpers.server.js");
        const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
        await expect(startServerWithClient("synthetic-owned-token")).rejects.toBe(startupError);
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
it("retains a failed acquisition owner", async () => {
  await verifyCompositeAcquisition(${JSON.stringify(scenario)});
});
`,
        );
      } else {
        await verifyCompositeAcquisition(scenario);
      }
    },
  );

  it("joins the one-shot device socket close before returning its response", async () => {
    await withPeerState("device-acquisition-response", "reply", async (peer) => {
      const { connectDeviceAuthReq } = await import("./test-helpers.e2e.js");
      const response = await connectDeviceAuthReq({
        url: `ws://127.0.0.1:${peer.port}`,
        token: "synthetic-token",
      });
      expect(response).toMatchObject({ type: "res", id: "c1", ok: true });
      expect(peer.requests).toHaveLength(1);
      expect(peer.requests[0]).toMatchObject({
        params: { auth: { token: "synthetic-token" }, device: { nonce: "test-nonce" } },
      });
      expectClosedClient(peer);
    });
  });
});
