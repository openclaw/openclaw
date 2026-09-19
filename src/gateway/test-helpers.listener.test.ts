import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { reserveGatewayTestListener } from "./test-helpers.listener.js";

vi.mock("./server-runtime-state.js", () => ({
  createGatewayHttpTransport: async (params: { port: number; testListener?: Server }) =>
    params.testListener,
}));

function createTestTransport(transport: typeof import("./server-runtime-state.js"), port: number) {
  return transport.createGatewayHttpTransport({
    port,
  } as Parameters<typeof transport.createGatewayHttpTransport>[0]);
}

describe("reserved Gateway test listeners", () => {
  it("adopts a single reservation through the transport dispatcher", async () => {
    const transport = await import("./server-runtime-state.js");
    const reservation = await reserveGatewayTestListener();
    try {
      await expect(
        reservation.start(() => createTestTransport(transport, reservation.port)),
      ).resolves.toBe(reservation.listener);
    } finally {
      await new Promise<void>((resolve, reject) => {
        reservation.listener.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each(["first", "second"] as const)(
    "adopts overlapping reservations when %s startup settles first",
    async (firstToSettle) => {
      const transport = await import("./server-runtime-state.js");
      const first = await reserveGatewayTestListener();
      const second = await reserveGatewayTestListener();
      const reservations = [first, second];
      const entered = reservations.map(() => createDeferred());
      const release = reservations.map(() => createDeferred());
      const runs = reservations.map((reservation, index) =>
        reservation.start(async () => {
          entered[index]!.resolve();
          await release[index]!.promise;
          return createTestTransport(transport, reservation.port);
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
          reservations.map(
            ({ listener }) =>
              new Promise<void>((resolve, reject) => {
                listener.close((error) => (error ? reject(error) : resolve()));
              }),
          ),
        );
      }
    },
  );
});
