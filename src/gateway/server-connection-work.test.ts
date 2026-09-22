import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "../process/spawn-broker/host.js";
import { createDeferredCore } from "../shared/deferred.js";
import { GatewayConnectionWork } from "./server-connection-work.js";

describe("Gateway connection work", () => {
  it("starts received work synchronously and joins connection cleanup after transport close", async () => {
    const work = new GatewayConnectionWork();
    const requestGate = createDeferredCore();
    const cleanupGate = createDeferredCore();
    const events: string[] = [];
    const request = work.track(async () => {
      events.push("request");
      await requestGate.promise;
      events.push("request settled");
    });
    expect(events).toEqual(["request"]);
    const releaseConnection = work.registerConnection(() => {
      events.push("transport closed");
      void work.track(() => cleanupGate.promise).finally(releaseConnection);
    });
    let drained = false;
    work.beginClose();
    expect(work.signal.aborted).toBe(true);
    expect(events).toEqual(["request"]);
    const closing = Promise.all([work.drain(), work.drain()]).then(() => {
      drained = true;
    });
    try {
      requestGate.resolve();
      await request;
      await nextTurn();
      expect(events).toEqual(["request", "transport closed", "request settled"]);
      expect(drained).toBe(false);
    } finally {
      requestGate.resolve();
      cleanupGate.resolve();
      await closing;
    }
    expect(drained).toBe(true);
    const late = vi.fn();
    await expect(work.track(late)).rejects.toThrow("Async work scope is closed");
    expect(late).not.toHaveBeenCalled();
  });

  it("retains a failed cleanup outcome instead of reporting a clean drain", async () => {
    const work = new GatewayConnectionWork();
    const failure = new Error("connection cleanup failed");
    await expect(
      work.trackCleanup(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    work.beginClose();
    await expect(work.drain()).rejects.toMatchObject({ cause: failure });
    await expect(work.drain()).rejects.toMatchObject({ cause: failure });
  });

  it("allows clean shutdown after a handled request failure settles", async () => {
    const work = new GatewayConnectionWork();
    const failure = new Error("handled request failed");
    await expect(
      work.track(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    work.beginClose();
    await expect(work.drain()).resolves.toBeUndefined();
  });

  it("does not drain another Gateway generation's work", async () => {
    const first = new GatewayConnectionWork();
    const second = new GatewayConnectionWork();
    const gate = createDeferredCore();
    let settled = false;
    const pending = first.track(async () => {
      await gate.promise;
      settled = true;
    });
    try {
      second.beginClose();
      await second.drain();
      expect(settled).toBe(false);
    } finally {
      gate.resolve();
      first.beginClose();
      await first.drain();
      await pending;
    }
  });
});

describe.skipIf(process.platform === "win32" || Boolean(process.versions.bun))(
  "Gateway connection broker ownership",
  () => {
    let firstBroker: SpawnBrokerHost;
    let secondBroker: SpawnBrokerHost;
    beforeAll(async () => {
      firstBroker = createSpawnBrokerHost();
      secondBroker = createSpawnBrokerHost();
      await Promise.all([firstBroker.ready(), secondBroker.ready()]);
    });
    afterAll(async () => {
      await Promise.all([firstBroker?.close(), secondBroker?.close()]);
    });

    it("restores only the owning broker when received work enters from another context", async () => {
      const callerContext = new AsyncLocalStorage<string>();
      const first = callerContext.run("startup", () =>
        runWithSpawnBroker(firstBroker, () => new GatewayConnectionWork()),
      );
      const second = runWithSpawnBroker(secondBroker, () => new GatewayConnectionWork());
      const withoutBroker = new GatewayConnectionWork();
      const firstGate = createDeferredCore();
      const entered: string[] = [];
      try {
        const pending = callerContext.run("request", () =>
          runWithSpawnBroker(secondBroker, () =>
            first.track(async () => {
              entered.push("first");
              expect(getSpawnBroker()).toBe(firstBroker);
              expect(callerContext.getStore()).toBe("request");
              await firstGate.promise;
              expect(getSpawnBroker()).toBe(firstBroker);
              expect(callerContext.getStore()).toBe("request");
            }),
          ),
        );
        expect(entered).toEqual(["first"]);
        await runWithSpawnBroker(firstBroker, async () => {
          await second.track(async () => {
            await nextTurn();
            expect(getSpawnBroker()).toBe(secondBroker);
          });
          expect(getSpawnBroker()).toBe(firstBroker);
          await withoutBroker.track(async () => {
            await nextTurn();
            expect(getSpawnBroker()).toBeUndefined();
          });
          expect(getSpawnBroker()).toBe(firstBroker);
        });
        firstGate.resolve();
        await pending;
      } finally {
        firstGate.resolve();
        await Promise.all([first.drain(), second.drain(), withoutBroker.drain()]);
      }
    });

    it("keeps closing cleanup on its broker and refuses work after that owner drains", async () => {
      const first = runWithSpawnBroker(firstBroker, () => new GatewayConnectionWork());
      const second = runWithSpawnBroker(secondBroker, () => new GatewayConnectionWork());
      first.beginClose();
      try {
        await runWithSpawnBroker(secondBroker, () =>
          first.trackCleanup(async () => {
            await nextTurn();
            expect(getSpawnBroker()).toBe(firstBroker);
          }),
        );
        await first.drain();
        const late = vi.fn();
        await expect(runWithSpawnBroker(secondBroker, () => first.track(late))).rejects.toThrow(
          "Async work scope is closed",
        );
        expect(late).not.toHaveBeenCalled();
        await second.track(async () => {
          await nextTurn();
          expect(getSpawnBroker()).toBe(secondBroker);
        });
      } finally {
        await Promise.all([first.drain(), second.drain()]);
      }
    });
  },
);
