import { describe, expect, it, vi } from "vitest";
import { botCtorSpy } from "./bot.create-telegram-bot.test-harness.js";
import { createTelegramBot } from "./bot.js";

describe("createTelegramBot fetch abort", () => {
  it("aborts wrapped client fetch when fetchAbortSignal aborts", async () => {
    const originalFetch = globalThis.fetch;
    const shutdown = new AbortController();
    const fetchSpy = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<AbortSignal>((resolve) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener("abort", () => resolve(signal), { once: true });
        }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      botCtorSpy.mockClear();
      createTelegramBot({ token: "tok", fetchAbortSignal: shutdown.signal });
      const clientFetch = (botCtorSpy.mock.calls.at(-1)?.[1] as { client?: { fetch?: unknown } })
        ?.client?.fetch as (input: RequestInfo | URL, init?: RequestInit) => Promise<unknown>;
      expect(clientFetch).toBeTypeOf("function");

      const observedSignalPromise = clientFetch("https://example.test");
      shutdown.abort(new Error("shutdown"));
      const observedSignal = (await observedSignalPromise) as AbortSignal;

      expect(observedSignal).toBeInstanceOf(AbortSignal);
      expect(observedSignal.aborted).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
