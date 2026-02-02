import { afterEach, describe, expect, it, vi } from "vitest";

describe("resolveTelegramFetch", () => {
  const originalFetch = globalThis.fetch;

  const loadModule = async () => {
    const setDefaultAutoSelectFamily = vi.fn();
    vi.resetModules();
    vi.doMock("node:net", () => ({
      setDefaultAutoSelectFamily,
    }));
    const mod = await import("./fetch.js");
    return { resolveTelegramFetch: mod.resolveTelegramFetch, setDefaultAutoSelectFamily };
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  });

  it("returns wrapped global fetch when available", async () => {
    const fetchMock = vi.fn(async () => ({}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { resolveTelegramFetch } = await loadModule();
    const resolved = resolveTelegramFetch();
    expect(resolved).toBeTypeOf("function");
  });

  it("prefers proxy fetch when provided", async () => {
    const fetchMock = vi.fn(async () => ({}));
    const { resolveTelegramFetch } = await loadModule();
    const resolved = resolveTelegramFetch(fetchMock as unknown as typeof fetch);
    expect(resolved).toBeTypeOf("function");
  });

  it("honors env enable override", async () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY", "1");
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    const { resolveTelegramFetch, setDefaultAutoSelectFamily } = await loadModule();
    resolveTelegramFetch();
    expect(setDefaultAutoSelectFamily).toHaveBeenCalledWith(true);
  });

  it("uses config override when provided", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    const { resolveTelegramFetch, setDefaultAutoSelectFamily } = await loadModule();
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });
    expect(setDefaultAutoSelectFamily).toHaveBeenCalledWith(true);
  });

  it("env disable override wins over config", async () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY", "1");
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    const { resolveTelegramFetch, setDefaultAutoSelectFamily } = await loadModule();
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });
    expect(setDefaultAutoSelectFamily).toHaveBeenCalledWith(false);
  });

  it("aborts requests after timeoutMs", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise((resolve) => {
        init?.signal?.addEventListener("abort", () => resolve({ ok: false }), { once: true });
      });
    });
    const { resolveTelegramFetch } = await loadModule();
    const resolved = resolveTelegramFetch(fetchMock as unknown as typeof fetch, {
      timeoutMs: 25,
    });
    if (!resolved) {
      throw new Error("expected fetch");
    }
    const response = resolved("https://api.telegram.org/bot123/getUpdates");
    await vi.advanceTimersByTimeAsync(30);
    await expect(response).resolves.toEqual({ ok: false });
    expect(fetchMock).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("skips timeout for non-getUpdates requests", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return Promise.resolve({ ok: true });
    });
    const { resolveTelegramFetch } = await loadModule();
    const resolved = resolveTelegramFetch(fetchMock as unknown as typeof fetch, {
      timeoutMs: 25,
    });
    if (!resolved) {
      throw new Error("expected fetch");
    }
    await resolved("https://api.telegram.org/bot123/getMe");
    await vi.advanceTimersByTimeAsync(30);
    expect(capturedSignal).toBeUndefined();
    vi.useRealTimers();
  });

  it("ignores getUpdatesStats paths for timeouts", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return Promise.resolve({ ok: true });
    });
    const { resolveTelegramFetch } = await loadModule();
    const resolved = resolveTelegramFetch(fetchMock as unknown as typeof fetch, {
      timeoutMs: 25,
    });
    if (!resolved) {
      throw new Error("expected fetch");
    }
    await resolved("https://api.telegram.org/bot123/getUpdatesStats?period=day");
    await vi.advanceTimersByTimeAsync(30);
    expect(capturedSignal).toBeUndefined();
    vi.useRealTimers();
  });
});
