import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_NO_PROXY = process.env.NO_PROXY;
const ORIGINAL_no_proxy = process.env.no_proxy;

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

import {
  getProxyUrlFromFetch,
  makeProxyFetch,
  PROXY_FETCH_PROXY_URL,
  resolveProxyFetchFromEnv,
} from "./proxy-fetch.js";

describe("makeProxyFetch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses undici fetch with ProxyAgent dispatcher", async () => {
    const proxyUrl = "http://proxy.test:8080";
    undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch(proxyUrl);
    expect(proxyAgentSpy).not.toHaveBeenCalled();
    await proxyFetch("https://api.example.com/v1/audio");

    expect(proxyAgentSpy).toHaveBeenCalledWith(proxyUrl);
    expect(undiciFetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/audio",
      expect.objectContaining({ dispatcher: getLastAgent() }),
    );
  });

  it("reuses the same ProxyAgent across calls", async () => {
    undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch("http://proxy.test:8080");

    await proxyFetch("https://api.example.com/one");
    const firstDispatcher = undiciFetch.mock.calls[0]?.[1]?.dispatcher;
    await proxyFetch("https://api.example.com/two");
    const secondDispatcher = undiciFetch.mock.calls[1]?.[1]?.dispatcher;

    expect(proxyAgentSpy).toHaveBeenCalledOnce();
    expect(secondDispatcher).toBe(firstDispatcher);
  });
});

describe("getProxyUrlFromFetch", () => {
  it("returns the trimmed proxy url from proxy fetch wrappers", () => {
    expect(getProxyUrlFromFetch(makeProxyFetch("  http://proxy.test:8080  "))).toBe(
      "http://proxy.test:8080",
    );
  });

  it("returns undefined for plain fetch functions or blank metadata", () => {
    const plainFetch = vi.fn() as unknown as typeof fetch;
    const blankMetadataFetch = vi.fn() as unknown as typeof fetch;
    Object.defineProperty(blankMetadataFetch, PROXY_FETCH_PROXY_URL, {
      value: "   ",
      enumerable: false,
      configurable: true,
      writable: true,
    });

    expect(getProxyUrlFromFetch(plainFetch)).toBeUndefined();
    expect(getProxyUrlFromFetch(blankMetadataFetch)).toBeUndefined();
  });
});

describe("resolveProxyFetchFromEnv", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    if (ORIGINAL_NO_PROXY === undefined) {
      delete process.env.NO_PROXY;
    } else {
      process.env.NO_PROXY = ORIGINAL_NO_PROXY;
    }
    if (ORIGINAL_no_proxy === undefined) {
      delete process.env.no_proxy;
    } else {
      process.env.no_proxy = ORIGINAL_no_proxy;
    }
  });

  it("returns undefined when no proxy env vars are set", () => {
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("http_proxy", "");

    expect(resolveProxyFetchFromEnv()).toBeUndefined();
  });

  it("returns undefined for explicit no_proxy host matches", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    vi.stubEnv("NO_PROXY", "172.31.0.14,example.internal");

    expect(
      resolveProxyFetchFromEnv("http://172.31.0.14:9001/v1/audio/transcriptions"),
    ).toBeUndefined();
    expect(envAgentSpy).not.toHaveBeenCalled();
  });

  it("returns undefined for whitespace-delimited no_proxy entries", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    vi.stubEnv("NO_PROXY", "10.0.0.0/8 example.internal");

    expect(resolveProxyFetchFromEnv("http://example.internal:9001/v1/models")).toBeUndefined();
    expect(envAgentSpy).not.toHaveBeenCalled();
  });

  it("uses lowercase no_proxy in preference to NO_PROXY", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    vi.stubEnv("NO_PROXY", "example.internal");
    vi.stubEnv("no_proxy", "");

    expect(resolveProxyFetchFromEnv("http://example.internal:9001/v1/models")).toBeDefined();
    expect(envAgentSpy).toHaveBeenCalled();
  });

  it("returns undefined for IPv6 loopback targets", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");

    expect(resolveProxyFetchFromEnv("http://[::1]:9001/v1/models")).toBeUndefined();
    expect(envAgentSpy).not.toHaveBeenCalled();
  });

  it("returns undefined for IPv4 loopback targets", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");

    expect(resolveProxyFetchFromEnv("http://127.0.0.1:9001/v1/models")).toBeUndefined();
    expect(envAgentSpy).not.toHaveBeenCalled();
  });
  it("returns proxy fetch for private-network targets that are not in no_proxy", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");

    expect(resolveProxyFetchFromEnv("http://192.168.3.20:8080/health")).toBeDefined();
    expect(envAgentSpy).toHaveBeenCalled();
  });

  it("returns undefined for CIDR no_proxy matches", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    vi.stubEnv("NO_PROXY", "203.0.113.0/24");

    expect(resolveProxyFetchFromEnv("http://203.0.113.14:9001/v1/models")).toBeUndefined();
    expect(envAgentSpy).not.toHaveBeenCalled();
  });

  it("returns undefined for no_proxy host:port matches", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    vi.stubEnv("NO_PROXY", "172.31.0.14:9001,[::1]:9001");

    expect(
      resolveProxyFetchFromEnv("http://172.31.0.14:9001/v1/audio/transcriptions"),
    ).toBeUndefined();
    expect(resolveProxyFetchFromEnv("http://[::1]:9001/v1/models")).toBeUndefined();
    expect(envAgentSpy).not.toHaveBeenCalled();
  });
  it("keeps proxy fetch when no_proxy host:port only matches a different port", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    vi.stubEnv("NO_PROXY", "internal.example:8443,.example.internal:8443");

    expect(resolveProxyFetchFromEnv("http://internal.example:8080/health")).toBeDefined();
    expect(resolveProxyFetchFromEnv("http://api.example.internal:8080/health")).toBeDefined();
    expect(envAgentSpy).toHaveBeenCalledTimes(2);
  });

  it("returns undefined for no_proxy suffix host:port matches", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    vi.stubEnv("NO_PROXY", ".example.internal:8443");

    expect(resolveProxyFetchFromEnv("http://api.example.internal:8443/health")).toBeUndefined();
    expect(envAgentSpy).not.toHaveBeenCalled();
  });

  it("returns undefined for leading-dot no_proxy entries on the exact host", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    vi.stubEnv("NO_PROXY", ".example.internal:8443");

    expect(resolveProxyFetchFromEnv("http://example.internal:8443/health")).toBeUndefined();
    expect(envAgentSpy).not.toHaveBeenCalled();
  });

  it("returns undefined for wildcard-suffix no_proxy entries", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    vi.stubEnv("NO_PROXY", "*.example.internal:8443");

    expect(resolveProxyFetchFromEnv("http://api.example.internal:8443/health")).toBeUndefined();
    expect(envAgentSpy).not.toHaveBeenCalled();
  });

  it("returns undefined for no_proxy host:port entries that match the default scheme port", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    vi.stubEnv("NO_PROXY", "example.com:443");

    expect(resolveProxyFetchFromEnv("https://example.com/v1/models")).toBeUndefined();
    expect(envAgentSpy).not.toHaveBeenCalled();
  });

  it("keeps proxy fetch when wildcard no_proxy only matches a different port", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    vi.stubEnv("NO_PROXY", "*:8080");

    expect(resolveProxyFetchFromEnv("https://example.com:443/v1/models")).toBeDefined();
    expect(envAgentSpy).toHaveBeenCalled();
  });

  it("returns undefined when wildcard no_proxy matches the target port", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    vi.stubEnv("NO_PROXY", "*:8080");

    expect(resolveProxyFetchFromEnv("http://example.com:8080/health")).toBeUndefined();
    expect(envAgentSpy).not.toHaveBeenCalled();
  });
  it("returns proxy fetch using EnvHttpProxyAgent when HTTPS_PROXY is set", async () => {
    vi.stubEnv("HTTP_PROXY", "");
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
