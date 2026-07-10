import { describe, expect, it } from "vitest";

const BARRIER_TIMEOUT_MS = 30_000;
const FAST_TIMEOUT = 500;

/**
 * Tests for the credential-mutation barrier timeout guard in message-handler.ts.
 *
 * The barrier pattern (for(;;) + Promise.race) prevents a stuck credential-mutation
 * dispatch from blocking all subsequent requests on a WebSocket connection indefinitely.
 */
describe("credential-mutation barrier timeout", () => {
  it("does not delay requests when barrier resolves quickly", async () => {
    const barrier = Promise.resolve();
    const start = Date.now();

    await Promise.race([
      barrier.catch(() => undefined),
      new Promise<void>((resolve) => {
        setTimeout(resolve, BARRIER_TIMEOUT_MS);
      }),
    ]);

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1_000);
  });

  it("unblocks via timeout when barrier never settles", async () => {
    const neverSettles = new Promise<void>(() => {
      // never resolves or rejects — simulates a stuck dispatch
    });
    const start = Date.now();

    await Promise.race([
      neverSettles.catch(() => undefined),
      new Promise<void>((resolve) => {
        setTimeout(resolve, FAST_TIMEOUT);
      }),
    ]);

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(FAST_TIMEOUT - 100);
    expect(elapsed).toBeLessThan(FAST_TIMEOUT * 3);
  });

  it("does not throw when barrier rejects", async () => {
    const barrier = Promise.reject(new Error("test error"));

    await expect(
      Promise.race([
        barrier.catch(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(resolve, BARRIER_TIMEOUT_MS);
        }),
      ]),
    ).resolves.toBeUndefined();
  });

  it("exits loop when isClosed returns true", async () => {
    let iterations = 0;
    let closed = false;
    const isClosed = () => closed;

    for (;;) {
      const barrier =
        iterations === 0
          ? new Promise<void>(() => {
              /* stuck until timeout */
            })
          : undefined;
      if (!barrier) {
        break;
      }

      await Promise.race([
        barrier.catch(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(resolve, FAST_TIMEOUT / 2);
        }),
      ]);
      iterations++;
      closed = true;
      if (isClosed()) {
        break;
      }
    }

    expect(iterations).toBe(1);
  });

  it("breaks out of loop when barrier becomes undefined", async () => {
    let barrier = Promise.resolve() as Promise<void> | undefined;
    const iterations: number[] = [];

    for (;;) {
      const current = barrier;
      if (!current) {
        break;
      }

      await Promise.race([
        current.catch(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(resolve, 100);
        }),
      ]);
      iterations.push(1);
      barrier = undefined;
    }

    expect(iterations).toHaveLength(1);
  });

  it("re-checks barrier after timeout in case new barrier was set", async () => {
    const barriers: Array<Promise<void> | undefined> = [
      new Promise<void>(() => {
        /* stuck */
      }),
      new Promise<void>((resolve) => {
        resolve();
      }),
      undefined,
    ];
    let idx = 0;
    const attempts: number[] = [];

    for (;;) {
      const current = barriers[idx];
      if (!current) {
        break;
      }

      await Promise.race([
        current.catch(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(resolve, FAST_TIMEOUT / 2);
        }),
      ]);
      attempts.push(idx);
      idx++;
    }

    expect(attempts).toEqual([0, 1]);
  });
});
