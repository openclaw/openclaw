import { createServer } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi, type TestContext } from "vitest";
import { WebSocketServer } from "ws";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { runQaGatewayTestFixture } from "../../test/helpers/qa-gateway-test-lifetime.js";
import {
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
} from "./minimal-gateway.test-helpers.js";
import { createGatewayFixtureFork } from "./server.fixture-lifetime.test-support.js";

const acquisitionFixture = vi.hoisted(() => ({
  start: vi.fn(),
  port: 0,
  reserve: vi.fn(),
}));
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
  vi.restoreAllMocks();
});

type AcquisitionPeer = Awaited<ReturnType<typeof createAcquisitionPeer>>;

async function createAcquisitionPeer() {
  const closeEvents: Promise<void>[] = [];
  const releases: Array<() => void> = [];
  const operations: Promise<unknown>[] = [];
  const track = <T>(operation: Promise<T>): Promise<T> => {
    operations.push(operation);
    void operation.catch(() => {});
    return operation;
  };
  const sockets = new Set<Socket>();
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
    wss.handleUpgrade(request, socket, head, (ws) => {
      sendMinimalGatewayConnectChallenge(ws);
      ws.on("message", (data) => {
        const frame = parseMinimalGatewayRequestFrame(data);
        if (frame.method !== "connect") {
          return;
        }
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: false,
            error: { code: "UNAUTHORIZED", message: "synthetic auth rejection" },
          }),
        );
      });
    });
  });
  const close = async () => {
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
        sockets.forEach((socket) => socket.destroy());
        await Promise.all(closeEvents);
      },
      () => Promise.allSettled(operations),
      () => closeMinimalGatewayServer(wss),
      close,
    ));
  try {
    const port = Number(new URL(await listenLoopback(server)).port);
    return {
      port,
      track,
      releaseOnCleanup: (release: () => void) => {
        releases.push(release);
      },
      isListening: () => server.listening,
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
  body: (peer: AcquisitionPeer) => Promise<void>,
  env?: Record<string, string>,
) {
  const scenario = runQaGatewayTestFixture(context, async (lifetime) => {
    const { withOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
    let callbackFailure: { reason: unknown } | undefined;
    try {
      await withOpenClawTestState(
        { label, env, verifyCleanup: lifetime.verifyCleanup },
        async () => {
          try {
            context.signal.throwIfAborted();
            const peer = await createAcquisitionPeer();
            await runQaGatewayFixture(
              async () => {
                // Non-cancelable setup may finish after timeout; do not admit another producer then.
                context.signal.throwIfAborted();
                await body(peer);
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
  return acquisitionFixture.start.mockResolvedValue(server);
}

// The disposable fork imports the same assertions without registering sibling cases.
export async function verifyCompositeAcquisition(
  shutdown: "joined" | "rejected",
  context: TestContext,
): Promise<void> {
  await withPeerState(
    context,
    "composite-acquisition",
    async (peer) => {
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
      const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
      context.signal.throwIfAborted();
      const started = startConnectedServerWithClient("synthetic-owned-token");
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
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("synthetic-owned-token");
        expect(peer.isListening()).toBe(true);
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
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe(
          shutdown === "rejected" ? "synthetic-owned-token" : previousToken,
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
  const fixtureWorkers = createVitestWorkerRun(process.env, undefined, "runtime");
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

  it("restores the token environment when server startup rejects before acquisition", async (context) => {
    await withPeerState(
      context,
      "server-start-rejection",
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
      },
      { OPENCLAW_GATEWAY_TOKEN: "synthetic-prior-token" },
    );
  });

  it.for(["joined", "rejected"] as const)(
    "retains server ownership after authentication failure and %s shutdown",
    async (shutdown, context) => {
      if (shutdown === "rejected") {
        // Rejected close retains its owner; it needs a fresh native worker.
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
  await verifyCompositeAcquisition("rejected", context);
});
`,
        );
      } else {
        await verifyCompositeAcquisition(shutdown, context);
      }
    },
  );
});
