import { once } from "node:events";
import type { Server } from "node:http";
import { createServer, type Server as TcpServer } from "node:net";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { captureEnv } from "../test-utils/env.js";
import {
  acquireTestPortBlock,
  reserveTestPortListener,
  type TestPortClaim,
} from "../test-utils/port-claims.js";
import { startGatewayServerHarness } from "./server.e2e-ws-harness.js";
import type { GatewayServer } from "./server.js";
import { reserveGatewayTestListener, startClaimedGateway } from "./test-helpers.listener.js";

const offsets = [0, 1, 2, 3, 4];
const observed = vi.hoisted(() => ({
  server: vi.fn<(claim: TestPortClaim) => Promise<GatewayServer>>(),
  adopted: vi.fn<(listener: Server | undefined) => void>(),
}));
vi.mock("./test-helpers.js", () => ({
  startTestGatewayServer: observed.server,
  connectOk: vi.fn(),
  trackConnectChallengeNonce: vi.fn(),
}));

vi.mock("./server-runtime-state.js", () => ({
  createGatewayHttpTransport: async (params: { port: number; testListener?: Server }) => {
    observed.adopted(params.testListener);
    return params.testListener;
  },
}));

async function createTestTransport(port: number) {
  const transport = await import("./server-runtime-state.js");
  return transport.createGatewayHttpTransport({
    port,
  } as Parameters<typeof transport.createGatewayHttpTransport>[0]);
}

it.each(["first", "second"] as const)(
  "adopts overlapping reservations when %s startup settles first",
  async (firstToSettle) => {
    const first = await reserveGatewayTestListener();
    const second = await reserveGatewayTestListener();
    const reservations = [first, second];
    const entered = reservations.map(() => createDeferred());
    const release = reservations.map(() => createDeferred());
    const runs = reservations.map((reservation, index) =>
      reservation.start(async () => {
        entered[index]!.resolve();
        await release[index]!.promise;
        return createTestTransport(reservation.port);
      }),
    );
    // Observe both rejections immediately, including the pre-fix recursive spy failure.
    const settled = Promise.allSettled(runs);
    try {
      await Promise.race([
        Promise.all(entered.map(({ promise }) => promise)),
        ...runs.map(async (run) => {
          await run;
          throw new Error("Startup settled before both reservation callbacks entered");
        }),
      ]);
      const order = firstToSettle === "first" ? [0, 1] : [1, 0];
      for (const index of order) {
        release[index]!.resolve();
        await expect(runs[index]).resolves.toBe(reservations[index]!.listener);
      }
    } finally {
      release.forEach((gate) => gate.resolve());
      await settled;
      // The synthetic transport returns the listener but does not own its close.
      await Promise.all(
        reservations.map(async (reservation) => {
          await closeListener(reservation.listener);
          await reservation.closeUnadopted();
        }),
      );
    }
  },
);

async function listen(server: TcpServer, port: number): Promise<void> {
  await once(server.listen(port, "127.0.0.1"), "listening");
}

async function closeListener(server: TcpServer | undefined): Promise<void> {
  if (server?.listening) {
    await server[Symbol.asyncDispose]();
  }
}

const makeServer = (close: GatewayServer["close"]): GatewayServer => ({
  getTailscaleIngressEndpoint: () => undefined,
  startupSettled: Promise.resolve(),
  close,
});

it("prevents an unclaimed listener from stealing the Gateway startup socket", async () => {
  const env = captureEnv(["OPENCLAW_GATEWAY_TOKEN"]);
  const entered = createDeferred<TestPortClaim>();
  const proceed = createDeferred();
  const competitor = createServer();
  let reclaimed: TestPortClaim | undefined;
  observed.adopted.mockClear();
  observed.server.mockImplementation((claim) =>
    startClaimedGateway(claim, async () => {
      entered.resolve(claim);
      await proceed.promise;
      // The real reservation dispatcher hands its bound socket to this transport seam.
      await createTestTransport(claim.port);
      return makeServer(() => closeListener(observed.adopted.mock.lastCall?.[0]));
    }),
  );

  const starting = startGatewayServerHarness();
  void starting.catch(() => {});
  await runQaGatewayFixture(
    async () => {
      const claim = await Promise.race([
        entered.promise,
        starting.then(() => {
          throw new Error("Gateway startup settled before the socket handoff gate");
        }),
      ]);
      await expect(listen(competitor, claim.port)).rejects.toMatchObject({ code: "EADDRINUSE" });
      proceed.resolve();
      const harness = await starting;
      expect(observed.adopted).toHaveBeenCalledOnce();
      expect(observed.adopted.mock.lastCall?.[0]?.listening).toBe(true);
      expect(harness.port).toBe(claim.port);

      await harness.close();
      reclaimed = await acquireTestPortBlock({ port: claim.port, offsets });
    },
    () => proceed.resolve(),
    async () => {
      const harness = await starting.catch(() => undefined);
      await harness?.close();
    },
    () => closeListener(competitor),
    () => closeListener(observed.adopted.mock.lastCall?.[0]),
    () => observed.server.mock.lastCall?.[0].release(),
    () => reclaimed?.release(),
    () => env.restore(),
    () => observed.server.mockReset(),
    () => observed.adopted.mockReset(),
  );
});

it("releases a settled Gateway claim while its port still has a listener", async () => {
  const competitor = createServer();
  const { claim } = await reserveTestPortListener({ offsets, createListener: () => competitor });
  const entered = createDeferred();
  const proceed = createDeferred();
  let reclaimed: TestPortClaim | undefined;
  let closing: Promise<void> | undefined;
  await runQaGatewayFixture(
    async () => {
      const server = await startClaimedGateway(claim, async () =>
        makeServer(async () => {
          entered.resolve();
          await proceed.promise;
        }),
      );
      closing = server.close();
      await entered.promise;
      await expect(
        acquireTestPortBlock({ port: claim.port, offsets }).then((early) => early.release()),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      proceed.resolve();
      await closing;
      // Keep the unrelated listener bound throughout claim release; reopening a
      // closed port would let another test or an outbound socket take it first.
      reclaimed = await acquireTestPortBlock({ port: claim.port, offsets });
      expect(competitor.address()).toMatchObject({ address: "127.0.0.1", port: claim.port });
    },
    () => proceed.resolve(),
    () => closing,
    () => closeListener(competitor),
    () => claim.release(),
    () => reclaimed?.release(),
  );
});
