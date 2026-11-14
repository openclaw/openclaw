// Covers fetch resolution and abort-signal wrapping.
import { describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { resolveFetch, wrapFetchWithAbortSignal } from "./fetch.js";

async function waitForMicrotaskTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
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
    addEventListener: (_eventValue: string, _handler: () => void) => {},
    removeEventListener,
  } as unknown as AbortSignal;
  return { fakeSignal, removeEventListener };
}

function createSeenInitFetch() {
  let seenInit: RequestInit | undefined;
  const fetchImpl = withFetchPreconnect(
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenInit = init;
      return {} as Response;
    }),
  );
  return { fetchImpl, getSeenInit: () => seenInit };
}

function createSymbolHeaderInit(enumerable: boolean): RequestInit {
  const headers = { "Content-Type": "application/json" } as Record<string, string> & {
    [key: symbol]: unknown;
  };
  Object.defineProperty(headers, Symbol("sensitiveHeaders"), {
    value: new Set(["content-type"]),
    enumerable,
  });
  return { headers };
}

describe("wrapFetchWithAbortSignal", () => {
  it("adds duplex for requests with a body", async () => {
    const { fetchImpl, getSeenInit } = createSeenInitFetch();
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    await wrapped("https://example.com", { method: "POST", body: "hi" });

    expect((getSeenInit() as (RequestInit & { duplex?: string }) | undefined)?.duplex).toBe("half");
  });

  it("adds duplex when the input Request already carries the body", async () => {
    const { fetchImpl, getSeenInit } = createSeenInitFetch();
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    await wrapped(new Request("https://example.com", { method: "POST", body: "hi" }));

    expect((getSeenInit() as (RequestInit & { duplex?: string }) | undefined)?.duplex).toBe("half");
  });

  it("preserves an existing duplex init field", async () => {
    const { fetchImpl, getSeenInit } = createSeenInitFetch();
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    await wrapped("https://example.com", {
      method: "POST",
      body: "hi",
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    expect((getSeenInit() as (RequestInit & { duplex?: string }) | undefined)?.duplex).toBe("half");
  });

  it("converts foreign abort signals to native controllers", async () => {
    const { fetchImpl, getSeenInit } = createSeenInitFetch();
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    const { fakeSignal, triggerAbort } = createForeignSignalHarness();

    const promise = wrapped("https://example.com", { signal: fakeSignal });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const seenSignal = getSeenInit()?.signal;
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal).not.toBe(fakeSignal);

    triggerAbort();
    expect(seenSignal?.aborted).toBe(true);

    await promise;
  });

  it("keeps foreign cancellation connected after response headers", async () => {
    const { fakeSignal, triggerAbort, removeEventListener } = createForeignSignalHarness();
    let signal: AbortSignal | undefined;
    const fetchImpl = withFetchPreconnect(
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
              signal?.addEventListener("abort", () => controller.error(signal?.reason), {
                once: true,
              });
            },
          }),
        );
      }),
    );
    const response = await wrapFetchWithAbortSignal(fetchImpl)("https://example.com", {
      signal: fakeSignal,
    });
    const reader = response.body!.getReader();
    try {
      expect((await reader.read()).value).toEqual(new Uint8Array([1]));
      triggerAbort();
      // Headers must not disconnect the signal from the underlying fetch.
      expect(signal?.aborted).toBe(true);
      await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
      expect(removeEventListener).toHaveBeenCalledOnce();
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  });

  it.each(["eof", "error", "cancel"] as const)(
    "releases the foreign listener on body %s even when cleanup throws",
    async (terminal) => {
      const { fakeSignal, removeEventListener } = createForeignSignalHarness();
      removeEventListener.mockImplementation(() => {
        throw new Error("foreign cleanup failed");
      });
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const pull = vi.fn();
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>(
        {
          start(value) {
            controller = value;
          },
          pull,
          cancel,
        },
        { highWaterMark: 0 },
      );
      const fetchImpl = withFetchPreconnect(vi.fn(async () => new Response(body)));
      const response = await wrapFetchWithAbortSignal(fetchImpl)("https://example.com", {
        signal: fakeSignal,
      });
      await Promise.resolve();
      expect(pull).not.toHaveBeenCalled();
      expect(removeEventListener).not.toHaveBeenCalled();
      const failure = new Error("body failed");
      if (terminal === "eof") {
        controller.enqueue(new TextEncoder().encode("complete"));
        controller.close();
        await expect(response.text()).resolves.toBe("complete");
      } else if (terminal === "error") {
        controller.error(failure);
        await expect(response.text()).rejects.toBe(failure);
      } else {
        await response.body!.cancel(failure);
        expect(cancel).toHaveBeenCalledExactlyOnceWith(failure);
      }
      expect(removeEventListener).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    },
  );

  it("preserves response metadata and cloned body consumption", async () => {
    const { fakeSignal, removeEventListener } = createForeignSignalHarness();
    const source = new Response("complete", {
      status: 201,
      statusText: "Created",
      headers: { "content-type": "text/plain" },
    });
    Object.defineProperties(source, {
      url: { value: "https://example.com/final" },
      redirected: { value: true },
      type: { value: "cors" },
    });
    const fetchImpl = withFetchPreconnect(vi.fn(async () => source));
    const response = await wrapFetchWithAbortSignal(fetchImpl)("https://example.com", {
      signal: fakeSignal,
    });
    expect(response.bodyUsed).toBe(false);
    const clone = response.clone();
    for (const value of [response, clone]) {
      expect(value).toMatchObject({
        status: 201,
        statusText: "Created",
        url: "https://example.com/final",
        redirected: true,
        type: "cors",
      });
      expect(value.headers).toBe(source.headers);
    }
    await expect(Promise.all([response.text(), clone.text()])).resolves.toEqual([
      "complete",
      "complete",
    ]);
    expect(response.bodyUsed).toBe(true);
    expect(() => response.clone()).toThrow(TypeError);
    expect(removeEventListener).toHaveBeenCalledOnce();
  });

  it("releases the foreign listener immediately for a bodyless response", async () => {
    const { fakeSignal, removeEventListener } = createForeignSignalHarness();
    const source = new Response(null, { status: 204 });
    const fetchImpl = withFetchPreconnect(vi.fn(async () => source));
    await expect(
      wrapFetchWithAbortSignal(fetchImpl)("https://example.com", { signal: fakeSignal }),
    ).resolves.toBe(source);
    expect(removeEventListener).toHaveBeenCalledOnce();
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

      expect(unhandled).toStrictEqual([]);
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

  it("passes through foreign signal-like objects without addEventListener", async () => {
    const { fetchImpl, getSeenInit } = createSeenInitFetch();
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    const fakeSignal = {
      aborted: false,
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    await wrapped("https://example.com", { signal: fakeSignal });

    expect(getSeenInit()?.signal).toBe(fakeSignal);
  });

  it("passes through native AbortSignal instances unchanged", async () => {
    const { fetchImpl, getSeenInit } = createSeenInitFetch();
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);
    const controller = new AbortController();

    await wrapped("https://example.com", { signal: controller.signal });

    expect(getSeenInit()?.signal).toBe(controller.signal);
  });

  it("passes through foreign signals unchanged when AbortController is unavailable", async () => {
    const { fetchImpl, getSeenInit } = createSeenInitFetch();
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);
    const fakeSignal = {
      aborted: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const previousAbortController = globalThis.AbortController;
    vi.stubGlobal("AbortController", undefined);

    try {
      await wrapped("https://example.com", { signal: fakeSignal });
    } finally {
      vi.stubGlobal("AbortController", previousAbortController);
    }

    expect(getSeenInit()?.signal).toBe(fakeSignal);
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

  it.each([
    { enumerable: true, name: "enumerable" },
    { enumerable: false, name: "non-enumerable" },
  ])(
    "drops $name header symbol metadata before calling the wrapped fetch",
    async ({ enumerable }) => {
      const { fetchImpl, getSeenInit } = createSeenInitFetch();
      const wrapped = wrapFetchWithAbortSignal(fetchImpl);
      const init = createSymbolHeaderInit(enumerable);

      await wrapped("https://example.com", init);

      const seenHeaders = getSeenInit()?.headers;
      expect(seenHeaders).not.toBe(init.headers);
      expect(Object.getOwnPropertySymbols(seenHeaders as object)).toStrictEqual([]);
      expect(new Headers(seenHeaders).get("content-type")).toBe("application/json");
      expect(Object.getOwnPropertySymbols(init.headers as object)).toHaveLength(1);
    },
  );
});

describe("resolveFetch", () => {
  it("returns undefined when neither an explicit nor global fetch exists", () => {
    const previousFetch = globalThis.fetch;
    vi.stubGlobal("fetch", undefined);
    try {
      expect(resolveFetch(undefined)).toBeUndefined();
    } finally {
      vi.stubGlobal("fetch", previousFetch);
    }
  });
});
