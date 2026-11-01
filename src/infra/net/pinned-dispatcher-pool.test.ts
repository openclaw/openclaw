import { AsyncLocalStorage } from "node:async_hooks";
import type { Dispatcher } from "undici";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { PinnedDispatcherPool } from "./pinned-dispatcher-pool.js";

function poolFixture() {
  const pool = new PinnedDispatcherPool();
  const create = vi.fn(() => ({ close: vi.fn(async () => undefined) }));
  const acquire = (key: string) =>
    pool.acquire({ key, createDispatcher: () => create() as unknown as Dispatcher });
  const expectClosed = (calls: number) => {
    for (const result of create.mock.results) {
      expect(result.value.close).toHaveBeenCalledTimes(calls);
    }
  };
  return { pool, create, acquire, expectClosed };
}

it("keeps separate active pins open through shutdown", async () => {
  const { pool, acquire, expectClosed } = poolFixture();
  const first = acquire("origin-a/pin-a");
  const second = acquire("origin-a/pin-b");
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  expect(first?.dispatcher).not.toBe(second?.dispatcher);
  expectClosed(0);
  await pool.closeAll();
  expectClosed(1);
  await first?.release();
  await second?.release();
  expectClosed(1);
});

it("falls back to caller-owned dispatchers when capacity is fully leased", async () => {
  const { pool, create, acquire, expectClosed } = poolFixture();
  const leases = Array.from({ length: 16 }, (_, i) => acquire(`origin-${i}/pin-${i}`));
  expect(acquire("origin-b/pin-b")).toBeUndefined();
  expect(create).toHaveBeenCalledTimes(16);
  expectClosed(0);
  await Promise.all(leases.map((lease) => lease!.release()));
  await pool.closeAll();
});

it.each(["expiry", "shutdown"] as const)(
  "keeps request contexts out of pool-owned %s cleanup",
  async (reason) => {
    const requests = new AsyncLocalStorage<object>();
    const sessions = new AsyncLocalStorage<object>();
    const [request, session] = [{}, {}] as const;
    const closed = createDeferredCore<[object | undefined, object | undefined]>();
    const close = vi.fn(async () => closed.resolve([requests.getStore(), sessions.getStore()]));
    let pool: PinnedDispatcherPool | undefined;
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await requests.run(request, () =>
        sessions.run(session, async () => {
          pool = new PinnedDispatcherPool();
          const lease = pool.acquire({
            key: "origin-a/pin-a",
            createDispatcher: () => {
              expect(requests.getStore()).toBe(request);
              expect(sessions.getStore()).toBe(session);
              return { close } as unknown as Dispatcher;
            },
          });
          expect(lease).toBeDefined();
          if (reason === "shutdown") {
            await pool.closeAll();
          } else {
            await lease!.release();
            await vi.advanceTimersByTimeAsync(60_000);
          }
          expect(requests.getStore()).toBe(request);
          expect(sessions.getStore()).toBe(session);
        }),
      );
      expect(await closed.promise).toEqual([undefined, undefined]);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await pool?.closeAll();
      vi.useRealTimers();
    }
  },
);
