import { AsyncLocalStorage } from "node:async_hooks";
import type { Dispatcher } from "undici";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { PinnedDispatcherPool } from "./pinned-dispatcher-pool.js";

function poolFixture(maxEntries = 2) {
  const pool = new PinnedDispatcherPool({ maxEntries, idleTtlMs: 60_000 });
  const create = vi.fn(() => ({ close: vi.fn(async () => undefined) }));
  const acquire = (key: string) =>
    pool.acquire({ key, createDispatcher: () => create() as unknown as Dispatcher });
  return { pool, create, acquire };
}

it("reuses an exact live key and closes it only at lifecycle shutdown", async () => {
  const { pool, create, acquire } = poolFixture();
  const first = acquire("origin-a/pin-a");
  expect(first?.reused).toBe(false);
  await first?.release();
  const second = acquire("origin-a/pin-a");
  expect(second?.dispatcher).toBe(first?.dispatcher);
  expect(second?.reused).toBe(true);
  expect(create).toHaveBeenCalledOnce();
  expect(create.mock.results[0]?.value.close).not.toHaveBeenCalled();
  await second?.release();
  await pool.closeAll();
  expect(create.mock.results[0]?.value.close).toHaveBeenCalledOnce();
});

it("keeps separate active pins open through shutdown", async () => {
  const { pool, create, acquire } = poolFixture();
  const oldLease = acquire("origin-a/pin-a");
  const oldDispatcher = create.mock.results[0]?.value;
  const nextLease = acquire("origin-a/pin-b");
  const nextDispatcher = create.mock.results[1]?.value;
  expect(create).toHaveBeenCalledTimes(2);
  expect(nextLease?.dispatcher).toBe(create.mock.results[1]?.value);
  expect(oldDispatcher?.close).not.toHaveBeenCalled();
  await pool.closeAll();
  expect(oldDispatcher?.close).toHaveBeenCalledOnce();
  expect(nextDispatcher?.close).toHaveBeenCalledOnce();

  await oldLease?.release();
  await nextLease?.release();
  expect(oldDispatcher?.close).toHaveBeenCalledOnce();
  expect(nextDispatcher?.close).toHaveBeenCalledOnce();
});

it("falls back to caller-owned dispatchers when capacity is fully leased", async () => {
  const { pool, create, acquire } = poolFixture(1);
  const first = acquire("origin-a/pin-a");
  const close = create.mock.results[0]?.value.close;
  expect(acquire("origin-b/pin-b")).toBeUndefined();
  expect(create).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  await first?.release();
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
      await requests.run(request, () =>
        sessions.run(session, async () => {
          pool = new PinnedDispatcherPool({ maxEntries: 1, idleTtlMs: 5 });
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
          }
          expect(requests.getStore()).toBe(request);
          expect(sessions.getStore()).toBe(session);
        }),
      );
      expect(await closed.promise).toEqual([undefined, undefined]);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await pool?.closeAll();
    }
  },
);
