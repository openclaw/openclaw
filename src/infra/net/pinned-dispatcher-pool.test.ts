import { AsyncLocalStorage } from "node:async_hooks";
import type { Dispatcher } from "undici";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { PinnedDispatcherPool } from "./pinned-dispatcher-pool.js";

function createDispatcher() {
  const close = vi.fn(async () => undefined);
  return {
    close,
    dispatcher: { close } as unknown as Dispatcher,
  };
}

describe("PinnedDispatcherPool", () => {
  it("reuses an exact live key and closes it only at lifecycle shutdown", async () => {
    const pool = new PinnedDispatcherPool({ maxEntries: 2, idleTtlMs: 60_000 });
    const created = createDispatcher();
    const create = vi.fn(() => created.dispatcher);

    const first = pool.acquire({
      key: "origin-a/pin-a",
      createDispatcher: create,
    });
    expect(first?.reused).toBe(false);
    await first?.release();
    const second = pool.acquire({
      key: "origin-a/pin-a",
      createDispatcher: create,
    });

    expect(second?.dispatcher).toBe(first?.dispatcher);
    expect(second?.reused).toBe(true);
    expect(create).toHaveBeenCalledOnce();
    expect(created.close).not.toHaveBeenCalled();

    await second?.release();
    await pool.closeAll();
    expect(created.close).toHaveBeenCalledOnce();
  });

  it("keeps separate active pins open through shutdown", async () => {
    const pool = new PinnedDispatcherPool({ maxEntries: 2, idleTtlMs: 60_000 });
    const oldDispatcher = createDispatcher();
    const nextDispatcher = createDispatcher();
    const oldLease = pool.acquire({
      key: "origin-a/pin-a",
      createDispatcher: () => oldDispatcher.dispatcher,
    });
    const nextLease = pool.acquire({
      key: "origin-a/pin-b",
      createDispatcher: () => nextDispatcher.dispatcher,
    });

    expect(nextLease?.dispatcher).toBe(nextDispatcher.dispatcher);
    expect(oldDispatcher.close).not.toHaveBeenCalled();
    await pool.closeAll();
    expect(oldDispatcher.close).toHaveBeenCalledOnce();
    expect(nextDispatcher.close).toHaveBeenCalledOnce();

    await oldLease?.release();
    await nextLease?.release();
    expect(oldDispatcher.close).toHaveBeenCalledOnce();
    expect(nextDispatcher.close).toHaveBeenCalledOnce();
  });

  it("falls back to caller-owned dispatchers when capacity is fully leased", async () => {
    const pool = new PinnedDispatcherPool({ maxEntries: 1, idleTtlMs: 60_000 });
    const firstDispatcher = createDispatcher();
    const first = pool.acquire({
      key: "origin-a/pin-a",
      createDispatcher: () => firstDispatcher.dispatcher,
    });
    const secondFactory = vi.fn(() => createDispatcher().dispatcher);

    const second = pool.acquire({
      key: "origin-b/pin-b",
      createDispatcher: secondFactory,
    });

    expect(second).toBeUndefined();
    expect(secondFactory).not.toHaveBeenCalled();
    expect(firstDispatcher.close).not.toHaveBeenCalled();
    await first?.release();
    await pool.closeAll();
  });

  it.each(["expiry", "shutdown"] as const)(
    "keeps request contexts out of pool-owned %s cleanup",
    async (reason) => {
      const requestScope = new AsyncLocalStorage<object>();
      const sessionScope = new AsyncLocalStorage<object>();
      const request = {};
      const session = {};
      const closed = createDeferredCore<[object | undefined, object | undefined]>();
      const close = vi.fn(async () => {
        closed.resolve([requestScope.getStore(), sessionScope.getStore()]);
      });
      let pool: PinnedDispatcherPool | undefined;
      try {
        await requestScope.run(request, () =>
          sessionScope.run(session, async () => {
            pool = new PinnedDispatcherPool({ maxEntries: 1, idleTtlMs: 5 });
            const lease = pool.acquire({
              key: "origin-a/pin-a",
              createDispatcher: () => {
                expect(requestScope.getStore()).toBe(request);
                expect(sessionScope.getStore()).toBe(session);
                return { close } as unknown as Dispatcher;
              },
            });
            expect(lease).toBeDefined();
            if (reason === "shutdown") {
              await pool.closeAll();
            } else {
              await lease!.release();
            }
            expect(requestScope.getStore()).toBe(request);
            expect(sessionScope.getStore()).toBe(session);
          }),
        );
        expect(await closed.promise).toEqual([undefined, undefined]);
        expect(close).toHaveBeenCalledOnce();
      } finally {
        await pool?.closeAll();
      }
    },
  );
});
