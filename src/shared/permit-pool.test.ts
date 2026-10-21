import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPermitPool } from "./permit-pool.js";

describe("permit pool", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("admits FIFO without releasing another holder on a duplicate release", async () => {
    const pool = createPermitPool(2);
    const first = await pool.acquire();
    const second = pool.tryAcquire();
    expect(pool.tryAcquire()).toBeNull();
    const admitted: string[] = [];
    const queued = ["a", "b", "c"].map((name) =>
      pool.acquire().then((release) => {
        admitted.push(name);
        return release;
      }),
    );

    expect(first).toBeTypeOf("function");
    expect(second).toBeTypeOf("function");
    first?.();
    first?.();
    expect(pool.tryAcquire()).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(admitted).toEqual(["a"]);
    second?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(admitted).toEqual(["a", "b"]);
    (await queued[0])?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(admitted).toEqual(["a", "b", "c"]);
    (await queued[1])?.();
    (await queued[2])?.();
  });

  it("removes cancelled and expired waiters without revoking acquired permits", async () => {
    const pool = createPermitPool(1);
    const owner = new AbortController();
    const release = await pool.acquire({ signal: owner.signal, deadlineAtMs: Date.now() + 10 });
    const cancel = new AbortController();
    const cancelled = pool.acquire({ signal: cancel.signal });
    const expired = pool.acquire({ deadlineAtMs: Date.now() + 10 });
    let admitted = false;
    const next = pool.acquire().then((nextRelease) => {
      admitted = true;
      return nextRelease;
    });

    cancel.abort();
    owner.abort();
    await vi.advanceTimersByTimeAsync(10);
    await expect(cancelled).resolves.toBeNull();
    await expect(expired).resolves.toBeNull();
    expect(admitted).toBe(false);
    release?.();
    const nextRelease = await next;
    expect(nextRelease).toBeTypeOf("function");
    nextRelease?.();
  });

  it("preserves FIFO and capacity when a queued waiter cancels after sustained turnover", async () => {
    const pool = createPermitPool(1);
    let release = pool.tryAcquire();
    const cancelled: AbortController[] = [];
    const admitted: number[] = [];
    const waiting = Array.from({ length: 600 }, (_, index) => {
      const cancellation = index >= 450 && index < 500 ? new AbortController() : undefined;
      if (cancellation) {
        cancelled.push(cancellation);
      }
      return pool
        .acquire(cancellation ? { signal: cancellation.signal } : {})
        .then((nextRelease) => {
          if (nextRelease) {
            admitted.push(index);
          }
          return nextRelease;
        });
    });
    expect(pool.pendingCount).toBe(600);

    for (const [index, pending] of waiting.entries()) {
      if (index === 280) {
        break;
      }
      release?.();
      release = await pending;
    }
    expect(admitted).toEqual(Array.from({ length: 280 }, (_, index) => index));
    expect(pool.pendingCount).toBe(320);
    for (const cancellation of cancelled) {
      cancellation.abort();
    }
    await expect(Promise.all(waiting.slice(450, 500))).resolves.toEqual(
      Array.from({ length: 50 }, () => null),
    );
    expect(pool.pendingCount).toBe(270);
    expect(pool.tryAcquire()).toBeNull();

    for (const index of [600, 601]) {
      waiting.push(
        pool.acquire().then((nextRelease) => {
          if (nextRelease) {
            admitted.push(index);
          }
          return nextRelease;
        }),
      );
    }
    expect(pool.pendingCount).toBe(272);

    for (const [index, pending] of waiting.entries()) {
      if (index < 280 || (index >= 450 && index < 500)) {
        continue;
      }
      release?.();
      if (index === 280) {
        release?.();
      }
      release = await pending;
      if (index === 280) {
        expect(pool.pendingCount).toBe(271);
        expect(pool.tryAcquire()).toBeNull();
      }
    }
    release?.();
    expect(admitted).toEqual(
      Array.from({ length: 602 }, (_, index) => index).filter(
        (index) => index < 450 || index >= 500,
      ),
    );
    expect(pool.pendingCount).toBe(0);
    const fresh = pool.tryAcquire();
    expect(fresh).toBeTypeOf("function");
    fresh?.();
  });

  it("rechecks deadlines on release even before an expiry timer runs", async () => {
    const pool = createPermitPool(1);
    const release = await pool.acquire();
    const expired = pool.acquire({ deadlineAtMs: Date.now() + 10 });
    const next = pool.acquire();
    vi.setSystemTime(Date.now() + 10);
    release?.();
    await expect(expired).resolves.toBeNull();
    const nextRelease = await next;
    expect(nextRelease).toBeTypeOf("function");
    nextRelease?.();

    const aborted = new AbortController();
    aborted.abort();
    await expect(pool.acquire({ signal: aborted.signal })).resolves.toBeNull();
    await expect(pool.acquire({ deadlineAtMs: Date.now() })).resolves.toBeNull();
  });

  it("does not expire a queued permit before its deadline after a wall-clock step", async () => {
    vi.setSystemTime(1000);
    const pool = createPermitPool(1);
    const owner = pool.tryAcquire();
    const waiting = pool.acquire({ deadlineAtMs: 1100 });
    vi.setSystemTime(950);
    await vi.advanceTimersByTimeAsync(100);
    expect(pool.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    await expect(waiting).resolves.toBeNull();
    expect(pool.pendingCount).toBe(0);
    owner?.();
  });

  it("keeps a distant deadline from overflowing the native timer range", async () => {
    vi.setSystemTime(1000);
    const pool = createPermitPool(1);
    const owner = pool.tryAcquire();
    const waiting = pool.acquire({ deadlineAtMs: Date.now() + 2 ** 31 });
    await vi.advanceTimersByTimeAsync(1);
    expect(pool.pendingCount).toBe(1);
    owner?.();
    const release = await waiting;
    expect(release).toBeTypeOf("function");
    release?.();
  });
});
