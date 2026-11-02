import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPermitPool } from "./permit-pool.js";

async function releaseAcquired(pending: Promise<(() => void) | null>) {
  const release = await pending;
  expect(release).toBeTypeOf("function");
  release?.();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("removes cancelled and expired waiters without revoking acquired permits", async () => {
  const pool = createPermitPool(1);
  const owner = new AbortController();
  const release = await pool.acquire({ signal: owner.signal, deadlineAtMs: Date.now() + 10 });
  const cancel = new AbortController();
  const cancelled = pool.acquire({ signal: cancel.signal });
  const expired = pool.acquire({ deadlineAtMs: Date.now() + 10 });
  const admitted = vi.fn();
  const next = pool.acquire();
  void next.then(admitted);

  cancel.abort();
  owner.abort();
  await vi.advanceTimersByTimeAsync(10);
  await expect(Promise.all([cancelled, expired])).resolves.toEqual([null, null]);
  expect(admitted).not.toHaveBeenCalled();
  release?.();
  await releaseAcquired(next);
});

it("rechecks deadlines on release even before an expiry timer runs", async () => {
  const pool = createPermitPool(1);
  const release = await pool.acquire();
  const expired = pool.acquire({ deadlineAtMs: Date.now() + 10 });
  const next = pool.acquire();
  vi.setSystemTime(Date.now() + 10);
  release?.();
  await expect(expired).resolves.toBeNull();
  await releaseAcquired(next);

  const aborted = new AbortController();
  aborted.abort();
  await expect(pool.acquire({ signal: aborted.signal })).resolves.toBeNull();
  await expect(pool.acquire({ deadlineAtMs: Date.now() })).resolves.toBeNull();
});

it.each([
  ["backward clock step", 1100, 950, 100, 50],
  ["native timer overflow", 1000 + 2 ** 31, 1000, 1, 0],
] as const)(
  "keeps a queued permit pending across %s",
  async (_name, deadline, clock, advance, expiry) => {
    vi.setSystemTime(1000);
    const pool = createPermitPool(1);
    const owner = pool.tryAcquire();
    const waiting = pool.acquire({ deadlineAtMs: deadline });
    vi.setSystemTime(clock);
    await vi.advanceTimersByTimeAsync(advance);
    expect(pool.pendingCount).toBe(1);
    if (expiry) {
      await vi.advanceTimersByTimeAsync(expiry);
      await expect(waiting).resolves.toBeNull();
      expect(pool.pendingCount).toBe(0);
    }
    owner?.();
    if (!expiry) {
      await releaseAcquired(waiting);
    }
  },
);

it("preserves FIFO and capacity when a queued waiter cancels after sustained turnover", async () => {
  const pool = createPermitPool(2);
  const held = await pool.acquire();
  let release = pool.tryAcquire();
  expect([held, release]).toEqual([expect.any(Function), expect.any(Function)]);
  expect(pool.tryAcquire()).toBeNull();
  const cancelled = Array.from({ length: 50 }, () => new AbortController());
  const admitted: number[] = [];
  const acquire = (index: number, signal?: AbortSignal) =>
    pool.acquire({ signal }).then((next) => {
      if (next) {
        admitted.push(index);
      }
      return next;
    });
  const waiting = Array.from({ length: 600 }, (_, index) =>
    acquire(index, cancelled[index - 450]?.signal),
  );
  expect(pool.pendingCount).toBe(600);

  for (const pending of waiting.slice(0, 280)) {
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

  waiting.push(acquire(600), acquire(601));
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
    Array.from({ length: 602 }, (_, index) => index).filter((index) => index < 450 || index >= 500),
  );
  expect(pool.pendingCount).toBe(0);
  const fresh = pool.tryAcquire();
  expect(fresh).toBeTypeOf("function");
  expect(pool.tryAcquire()).toBeNull();
  held?.();
  fresh?.();
});
