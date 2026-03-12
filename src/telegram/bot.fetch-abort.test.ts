import { describe, expect, it, vi } from "vitest";
import { botCtorSpy } from "./bot.create-telegram-bot.test-harness.js";
import { createTelegramBot } from "./bot.js";
import { getTelegramNetworkErrorOrigin } from "./network-errors.js";

describe("createTelegramBot fetch abort", () => {
  it("aborts wrapped client fetch when fetchAbortSignal aborts", async () => {
    const shutdown = new AbortController();
    const fetchSpy = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<AbortSignal>((resolve) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener("abort", () => resolve(signal), { once: true });
        }),
    );
    botCtorSpy.mockClear();
    createTelegramBot({
      token: "tok",
      fetchAbortSignal: shutdown.signal,
      proxyFetch: fetchSpy as unknown as typeof fetch,
    });
    const clientFetch = (botCtorSpy.mock.calls.at(-1)?.[1] as { client?: { fetch?: unknown } })
      ?.client?.fetch as (input: RequestInfo | URL, init?: RequestInit) => Promise<unknown>;
    expect(clientFetch).toBeTypeOf("function");

    const observedSignalPromise = clientFetch("https://example.test");
    shutdown.abort(new Error("shutdown"));
    const observedSignal = (await observedSignalPromise) as AbortSignal;

    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal.aborted).toBe(true);
  });

  it("tags wrapped Telegram fetch failures with the Bot API method", async () => {
    const shutdown = new AbortController();
    const fetchError = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect timeout"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });
    const fetchSpy = vi.fn(async () => {
      throw fetchError;
    });
    botCtorSpy.mockClear();
    createTelegramBot({
      token: "tok",
      fetchAbortSignal: shutdown.signal,
      proxyFetch: fetchSpy as unknown as typeof fetch,
    });
    const clientFetch = (botCtorSpy.mock.calls.at(-1)?.[1] as { client?: { fetch?: unknown } })
      ?.client?.fetch as (input: RequestInfo | URL, init?: RequestInit) => Promise<unknown>;
    expect(clientFetch).toBeTypeOf("function");

    await expect(clientFetch("https://api.telegram.org/bot123456:ABC/getUpdates")).rejects.toBe(
      fetchError,
    );
    expect(getTelegramNetworkErrorOrigin(fetchError)).toEqual({
      method: "getupdates",
      url: "https://api.telegram.org/bot123456:ABC/getUpdates",
    });
  });

  it("preserves the original fetch error when tagging cannot attach metadata", async () => {
    const shutdown = new AbortController();
    const frozenError = Object.freeze(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect timeout"), {
          code: "UND_ERR_CONNECT_TIMEOUT",
        }),
      }),
    );
    const fetchSpy = vi.fn(async () => {
      throw frozenError;
    });
    botCtorSpy.mockClear();
    createTelegramBot({
      token: "tok",
      fetchAbortSignal: shutdown.signal,
      proxyFetch: fetchSpy as unknown as typeof fetch,
    });
    const clientFetch = (botCtorSpy.mock.calls.at(-1)?.[1] as { client?: { fetch?: unknown } })
      ?.client?.fetch as (input: RequestInfo | URL, init?: RequestInit) => Promise<unknown>;
    expect(clientFetch).toBeTypeOf("function");

    await expect(clientFetch("https://api.telegram.org/bot123456:ABC/getUpdates")).rejects.toBe(
      frozenError,
    );
    expect(getTelegramNetworkErrorOrigin(frozenError)).toBeNull();
  });
});
