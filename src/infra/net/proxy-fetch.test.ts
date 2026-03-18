import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ProxyAgent, EnvHttpProxyAgent, undiciFetch, proxyAgentSpy, envAgentSpy, getLastAgent } =
  vi.hoisted(() => {
    const undiciFetch = vi.fn();
    const proxyAgentSpy = vi.fn();
    const envAgentSpy = vi.fn();
    class ProxyAgent {
      static lastCreated: ProxyAgent | undefined;
      proxyUrl: string;
      constructor(proxyUrl: string) {
        this.proxyUrl = proxyUrl;
        ProxyAgent.lastCreated = this;
        proxyAgentSpy(proxyUrl);
      }
    }
    class EnvHttpProxyAgent {
      static lastCreated: EnvHttpProxyAgent | undefined;
      constructor() {
        EnvHttpProxyAgent.lastCreated = this;
        envAgentSpy();
      }
    }

    return {
      ProxyAgent,
      EnvHttpProxyAgent,
      undiciFetch,
      proxyAgentSpy,
      envAgentSpy,
      getLastAgent: () => ProxyAgent.lastCreated,
    };
  });

vi.mock("undici", () => ({
  ProxyAgent,
  EnvHttpProxyAgent,
  fetch: undiciFetch,
}));

import { makeProxyFetch, resolveProxyFetchFromEnv } from "./proxy-fetch.js";
import { resetProxyCircuits } from "./proxy-probe.js";

describe("makeProxyFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProxyCircuits();
  });

  it("uses undici fetch with ProxyAgent dispatcher", async () => {
    const proxyUrl = "http://proxy.test:8080";
    undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch(proxyUrl);
    await proxyFetch("https://api.example.com/v1/audio");

    expect(proxyAgentSpy).toHaveBeenCalledWith(proxyUrl);
    expect(undiciFetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/audio",
      expect.objectContaining({ dispatcher: getLastAgent() }),
    );
  });
});

describe("resolveProxyFetchFromEnv", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it("returns undefined when no proxy env vars are set", () => {
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("http_proxy", "");

    expect(resolveProxyFetchFromEnv()).toBeUndefined();
  });

  it("returns proxy fetch using EnvHttpProxyAgent when HTTPS_PROXY is set", async () => {
    // Stub empty vars first — on Windows, process.env is case-insensitive so
    // HTTPS_PROXY and https_proxy share the same slot. Value must be set LAST.
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("http_proxy", "");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    undiciFetch.mockResolvedValue({ ok: true });

    const fetchFn = resolveProxyFetchFromEnv();
    expect(fetchFn).toBeDefined();
    expect(envAgentSpy).toHaveBeenCalled();

    await fetchFn!("https://api.example.com");
    expect(undiciFetch).toHaveBeenCalledWith(
      "https://api.example.com",
      expect.objectContaining({ dispatcher: EnvHttpProxyAgent.lastCreated }),
    );
  });

  it("returns proxy fetch when HTTP_PROXY is set", () => {
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("http_proxy", "");
    vi.stubEnv("HTTP_PROXY", "http://fallback.test:3128");

    const fetchFn = resolveProxyFetchFromEnv();
    expect(fetchFn).toBeDefined();
    expect(envAgentSpy).toHaveBeenCalled();
  });

  it("returns proxy fetch when lowercase https_proxy is set", () => {
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("http_proxy", "");
    vi.stubEnv("https_proxy", "http://lower.test:1080");

    const fetchFn = resolveProxyFetchFromEnv();
    expect(fetchFn).toBeDefined();
    expect(envAgentSpy).toHaveBeenCalled();
  });

  it("returns proxy fetch when lowercase http_proxy is set", () => {
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("http_proxy", "http://lower-http.test:1080");

    const fetchFn = resolveProxyFetchFromEnv();
    expect(fetchFn).toBeDefined();
    expect(envAgentSpy).toHaveBeenCalled();
  });

  it("returns undefined when EnvHttpProxyAgent constructor throws", () => {
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("http_proxy", "");
    vi.stubEnv("HTTPS_PROXY", "not-a-valid-url");
    envAgentSpy.mockImplementationOnce(() => {
      throw new Error("Invalid URL");
    });

    const fetchFn = resolveProxyFetchFromEnv();
    expect(fetchFn).toBeUndefined();
  });
});

describe("circuit breaker integration", () => {
  const directFetchResult = { ok: true, direct: true } as unknown as Response;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    resetProxyCircuits();
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(directFetchResult);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("falls back to direct fetch on proxy connection error", async () => {
    const connError = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    undiciFetch.mockRejectedValueOnce(connError);

    const proxyFetch = makeProxyFetch("http://proxy.test:8080");
    const result = await proxyFetch("https://api.example.com");

    expect(result).toBe(directFetchResult);
    expect(globalThis.fetch).toHaveBeenCalledWith("https://api.example.com", undefined);
  });

  it("rethrows non-connection errors without fallback", async () => {
    const apiError = new Error("500 Internal Server Error");
    undiciFetch.mockRejectedValueOnce(apiError);

    const proxyFetch = makeProxyFetch("http://proxy.test:9090");
    await expect(proxyFetch("https://api.example.com")).rejects.toThrow("500 Internal Server Error");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("skips proxy after circuit opens", async () => {
    const connError = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    undiciFetch.mockRejectedValueOnce(connError);

    const proxyFetch = makeProxyFetch("http://proxy.test:7070");

    // First call: proxy fails, falls back to direct
    await proxyFetch("https://api.example.com/1");
    expect(undiciFetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // Second call: circuit open, goes direct immediately (no proxy attempt)
    await proxyFetch("https://api.example.com/2");
    expect(undiciFetch).toHaveBeenCalledTimes(1); // still 1 — proxy skipped
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("resumes proxy after circuit closes on success", async () => {
    vi.useFakeTimers();
    const connError = Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
    undiciFetch.mockRejectedValueOnce(connError);

    const proxyFetch = makeProxyFetch("http://proxy.test:6060");

    // First call: proxy fails
    await proxyFetch("https://api.example.com/1");
    expect(undiciFetch).toHaveBeenCalledTimes(1);

    // Wait for cooldown to expire
    vi.advanceTimersByTime(11_000);

    // Next call: half_open, tries proxy again — this time it succeeds
    undiciFetch.mockResolvedValueOnce({ ok: true, proxy: true });
    const result = await proxyFetch("https://api.example.com/2");
    expect(undiciFetch).toHaveBeenCalledTimes(2); // proxy was tried again
    expect((result as unknown as { proxy: boolean }).proxy).toBe(true);

    vi.useRealTimers();
  });
});
