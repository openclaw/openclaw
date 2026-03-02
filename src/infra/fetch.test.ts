import { describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { resolveFetch, wrapFetchWithAbortSignal } from "./fetch.js";

async function waitForMicrotaskTurn(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

function createForeignSignalHarness() {
  let abortHandler: (() => void) | null = null;
  const removeEventListener = vi.fn((event: string, handler: () => void) => {
    if (event === "abort" && abortHandler === handler) {
      abortHandler = null;
    }
  });

  const fakeSignal = {
    aborted: false,
    addEventListener: (event: string, handler: () => void) => {
      if (event === "abort") {
        abortHandler = handler;
      }
    },
    removeEventListener,
  } as unknown as AbortSignal;

  return {
    fakeSignal,
    removeEventListener,
    triggerAbort: () => abortHandler?.(),
  };
}

function createThrowingCleanupSignalHarness(cleanupError: Error) {
  const removeEventListener = vi.fn(() => {
    throw cleanupError;
  });
  const fakeSignal = {
    aborted: false,
    addEventListener: (_event: string, _handler: () => void) => {},
    removeEventListener,
  } as unknown as AbortSignal;
  return { fakeSignal, removeEventListener };
}

describe("wrapFetchWithAbortSignal", () => {
  it("adds duplex for requests with a body", async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = withFetchPreconnect(
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenInit = init;
        return {} as Response;
      }),
    );

    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    await wrapped("https://example.com", { method: "POST", body: "hi" });

    expect((seenInit as (RequestInit & { duplex?: string }) | undefined)?.duplex).toBe("half");
  });

  it("converts foreign abort signals to native controllers", async () => {
    let seenSignal: AbortSignal | undefined;
    const fetchImpl = withFetchPreconnect(
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenSignal = init?.signal as AbortSignal | undefined;
        return {} as Response;
      }),
    );

    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    const { fakeSignal, triggerAbort } = createForeignSignalHarness();

    const promise = wrapped("https://example.com", { signal: fakeSignal });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal).not.toBe(fakeSignal);

    triggerAbort();
    expect(seenSignal?.aborted).toBe(true);

    await promise;
  });

  it("does not emit an extra unhandled rejection when wrapped fetch rejects", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    const fetchError = new TypeError("fetch failed");
    const fetchImpl = withFetchPreconnect(
      vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.reject(fetchError)),
    );
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    const { fakeSignal, removeEventListener } = createForeignSignalHarness();

    try {
      await expect(wrapped("https://example.com", { signal: fakeSignal })).rejects.toBe(fetchError);
      await Promise.resolve();
      await waitForMicrotaskTurn();

      expect(unhandled).toEqual([]);
      expect(removeEventListener).toHaveBeenCalledOnce();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("preserves original rejection when listener cleanup throws", async () => {
    const fetchError = new TypeError("fetch failed");
    const cleanupError = new TypeError("cleanup failed");
    const fetchImpl = withFetchPreconnect(
      vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.reject(fetchError)),
    );
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    const { fakeSignal, removeEventListener } = createThrowingCleanupSignalHarness(cleanupError);

    await expect(wrapped("https://example.com", { signal: fakeSignal })).rejects.toBe(fetchError);
    expect(removeEventListener).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "cleans up listener and rethrows when fetch throws synchronously",
      makeSignalHarness: () => createForeignSignalHarness(),
    },
    {
      name: "preserves original sync throw when listener cleanup throws",
      makeSignalHarness: () => createThrowingCleanupSignalHarness(new TypeError("cleanup failed")),
    },
  ])("$name", ({ makeSignalHarness }) => {
    const syncError = new TypeError("sync fetch failure");
    const fetchImpl = withFetchPreconnect(
      vi.fn(() => {
        throw syncError;
      }),
    );
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    const { fakeSignal, removeEventListener } = makeSignalHarness();

    expect(() => wrapped("https://example.com", { signal: fakeSignal })).toThrow(syncError);
    expect(removeEventListener).toHaveBeenCalledOnce();
  });

  it("skips listener cleanup when foreign signal is already aborted", async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const fetchImpl = withFetchPreconnect(vi.fn(async () => ({ ok: true }) as Response));
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    const fakeSignal = {
      aborted: true,
      addEventListener,
      removeEventListener,
    } as unknown as AbortSignal;

    await wrapped("https://example.com", { signal: fakeSignal });

    expect(addEventListener).not.toHaveBeenCalled();
    expect(removeEventListener).not.toHaveBeenCalled();
  });

  it("returns the same function when called with an already wrapped fetch", () => {
    const fetchImpl = withFetchPreconnect(vi.fn(async () => ({ ok: true }) as Response));
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    expect(wrapFetchWithAbortSignal(wrapped)).toBe(wrapped);
    expect(resolveFetch(wrapped)).toBe(wrapped);
  });

  it("keeps preconnect bound to the original fetch implementation", () => {
    const preconnectSpy = vi.fn(function (this: unknown) {
      return this;
    });
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response) as unknown as typeof fetch & {
      preconnect: (url: string, init?: { credentials?: RequestCredentials }) => unknown;
    };
    fetchImpl.preconnect = preconnectSpy;

    const wrapped = wrapFetchWithAbortSignal(fetchImpl) as typeof fetch & {
      preconnect: (url: string, init?: { credentials?: RequestCredentials }) => unknown;
    };

    const seenThis = wrapped.preconnect("https://example.com");

    expect(preconnectSpy).toHaveBeenCalledOnce();
    expect(seenThis).toBe(fetchImpl);
  });
});
