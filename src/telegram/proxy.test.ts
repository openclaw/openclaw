import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const undiciFetch = vi.fn();
  const proxyAgentSpy = vi.fn();
  const setGlobalDispatcher = vi.fn();
  class ProxyAgent {
    static lastCreated: ProxyAgent | undefined;
    proxyUrl: string;
    constructor(proxyUrl: string) {
      this.proxyUrl = proxyUrl;
      ProxyAgent.lastCreated = this;
      proxyAgentSpy(proxyUrl);
    }
  }

  return {
    ProxyAgent,
    undiciFetch,
    proxyAgentSpy,
    setGlobalDispatcher,
    getLastAgent: () => ProxyAgent.lastCreated,
  };
});

vi.mock("undici", () => ({
  ProxyAgent: mocks.ProxyAgent,
  fetch: mocks.undiciFetch,
  setGlobalDispatcher: mocks.setGlobalDispatcher,
}));

import { makeProxyFetch, resolveProxyUrl } from "./proxy.js";

describe("resolveProxyUrl", () => {
  // Clear all proxy env vars before each test so CI-preset values
  // don't interfere with fallback-priority assertions.
  beforeEach(() => {
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("http_proxy", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns explicit config proxy when set", () => {
    vi.stubEnv("HTTPS_PROXY", "http://env-proxy:9090");
    expect(resolveProxyUrl("http://config-proxy:8080")).toBe("http://config-proxy:8080");
  });

  it("trims whitespace from explicit config proxy", () => {
    expect(resolveProxyUrl("  http://config-proxy:8080  ")).toBe("http://config-proxy:8080");
  });

  it("falls back to HTTPS_PROXY env var", () => {
    vi.stubEnv("HTTPS_PROXY", "http://env-proxy:9090");
    expect(resolveProxyUrl(undefined)).toBe("http://env-proxy:9090");
  });

  it("falls back to HTTP_PROXY when HTTPS_PROXY is not set", () => {
    vi.stubEnv("HTTP_PROXY", "http://env-proxy:7070");
    expect(resolveProxyUrl(undefined)).toBe("http://env-proxy:7070");
  });

  it("falls back to lowercase https_proxy", () => {
    vi.stubEnv("https_proxy", "http://env-proxy:6060");
    expect(resolveProxyUrl(undefined)).toBe("http://env-proxy:6060");
  });

  it("falls back to lowercase http_proxy", () => {
    vi.stubEnv("http_proxy", "http://env-proxy:5050");
    expect(resolveProxyUrl(undefined)).toBe("http://env-proxy:5050");
  });

  it("returns undefined when no proxy is configured", () => {
    expect(resolveProxyUrl(undefined)).toBeUndefined();
  });

  it("returns undefined when config proxy is empty string", () => {
    expect(resolveProxyUrl("")).toBeUndefined();
    expect(resolveProxyUrl("   ")).toBeUndefined();
  });
});

describe("makeProxyFetch", () => {
  it("uses undici fetch with ProxyAgent dispatcher", async () => {
    const proxyUrl = "http://proxy.test:8080";
    mocks.undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch(proxyUrl);
    await proxyFetch("https://api.telegram.org/bot123/getMe");

    expect(mocks.proxyAgentSpy).toHaveBeenCalledWith(proxyUrl);
    expect(mocks.undiciFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123/getMe",
      expect.objectContaining({ dispatcher: mocks.getLastAgent() }),
    );
    expect(mocks.setGlobalDispatcher).not.toHaveBeenCalled();
  });
});
