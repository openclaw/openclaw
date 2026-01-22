import { describe, expect, it, vi } from "vitest";

import { resolveTelegramFetch } from "./fetch.js";

describe("resolveTelegramFetch", () => {
  it("wraps proxy fetch to normalize foreign abort signals", async () => {
    let seenSignal: AbortSignal | undefined;
    const proxyFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal as AbortSignal | undefined;
      return {} as Response;
    });

    const fetcher = resolveTelegramFetch(proxyFetch);
    expect(fetcher).toBeTypeOf("function");

    let abortHandler: (() => void) | null = null;
    const fakeSignal = {
      aborted: false,
      addEventListener: (event: string, handler: () => void) => {
        if (event === "abort") abortHandler = handler;
      },
      removeEventListener: (event: string, handler: () => void) => {
        if (event === "abort" && abortHandler === handler) abortHandler = null;
      },
    } as AbortSignal;

    const promise = fetcher!("https://example.com", { signal: fakeSignal });
    expect(proxyFetch).toHaveBeenCalledOnce();
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal).not.toBe(fakeSignal);

    abortHandler?.();
    expect(seenSignal?.aborted).toBe(true);

    await promise;
  });
});
