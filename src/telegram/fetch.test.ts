import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveFetch } from "../infra/fetch.js";
import { resetTelegramFetchStateForTests, resolveTelegramFetch } from "./fetch.js";

const setDefaultAutoSelectFamily = vi.hoisted(() => vi.fn());

vi.mock("node:net", async () => {
  const actual = await vi.importActual<typeof import("node:net")>("node:net");
  return {
    ...actual,
    setDefaultAutoSelectFamily,
  };
});

const originalFetch = globalThis.fetch;

afterEach(() => {
  resetTelegramFetchStateForTests();
  setDefaultAutoSelectFamily.mockReset();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  } else {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  }
});

describe("resolveTelegramFetch", () => {
  it("returns wrapped global fetch when available", async () => {
    const fetchMock = vi.fn(async () => ({}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const resolved = resolveTelegramFetch();

    expect(resolved).toBeTypeOf("function");
    expect(resolved).not.toBe(fetchMock);
  });

  it("wraps proxy fetches and normalizes foreign signals once", async () => {
    let seenSignal: AbortSignal | undefined;
    const proxyFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal as AbortSignal | undefined;
      return {} as Response;
    });

    const resolved = resolveTelegramFetch(proxyFetch as unknown as typeof fetch);
    expect(resolved).toBeTypeOf("function");

    let abortHandler: (() => void) | null = null;
    const addEventListener = vi.fn((event: string, handler: () => void) => {
      if (event === "abort") {
        abortHandler = handler;
      }
    });
    const removeEventListener = vi.fn((event: string, handler: () => void) => {
      if (event === "abort" && abortHandler === handler) {
        abortHandler = null;
      }
    });
    const fakeSignal = {
      aborted: false,
      addEventListener,
      removeEventListener,
    } as AbortSignal;

    if (!resolved) {
      throw new Error("expected resolved proxy fetch");
    }
    await resolved("https://example.com", { signal: fakeSignal });

    expect(proxyFetch).toHaveBeenCalledOnce();
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal).not.toBe(fakeSignal);
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });

  it("does not double-wrap an already wrapped proxy fetch", async () => {
    const proxyFetch = vi.fn(async () => ({ ok: true }) as Response) as unknown as typeof fetch;
    const alreadyWrapped = resolveFetch(proxyFetch);

    const resolved = resolveTelegramFetch(alreadyWrapped);

    expect(resolved).toBe(alreadyWrapped);
  });

  it("honors env enable override", async () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY", "1");
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch();
    expect(setDefaultAutoSelectFamily).toHaveBeenCalledWith(true);
  });

  it("uses config override when provided", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });
    expect(setDefaultAutoSelectFamily).toHaveBeenCalledWith(true);
  });

  it("env disable override wins over config", async () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY", "0");
    vi.stubEnv("OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY", "1");
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });
    expect(setDefaultAutoSelectFamily).toHaveBeenCalledWith(false);
  });
});
