import { afterEach, describe, expect, it, vi } from "vitest";

const { ProxyAgent, undiciFetch, proxyAgentSpy, getLastAgent } = vi.hoisted(() => {
  const undiciFetch = vi.fn();
  const proxyAgentSpy = vi.fn();
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
    getLastAgent: () => ProxyAgent.lastCreated,
  };
});

vi.mock("undici", () => ({
  ProxyAgent,
  fetch: undiciFetch,
}));

import { makeProxyFetch, resolveProxyUrlFromEnv, shouldBypassProxyForUrl } from "./proxy.js";

describe("makeProxyFetch", () => {
  it("uses undici fetch with ProxyAgent dispatcher", async () => {
    const proxyUrl = "http://proxy.test:8080";
    undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch(proxyUrl);
    await proxyFetch("https://api.telegram.org/bot123/getMe");

    expect(proxyAgentSpy).toHaveBeenCalledWith(proxyUrl);
    expect(undiciFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123/getMe",
      expect.objectContaining({ dispatcher: getLastAgent() }),
    );
  });
});

describe("resolveProxyUrlFromEnv", () => {
  const vars = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];

  afterEach(() => {
    for (const key of vars) {
      delete process.env[key];
    }
  });

  it("returns undefined when no proxy env var is set", () => {
    expect(resolveProxyUrlFromEnv()).toBeUndefined();
  });

  it("prefers HTTPS_PROXY over HTTP_PROXY and ALL_PROXY", () => {
    process.env.ALL_PROXY = "http://all:8080";
    process.env.HTTP_PROXY = "http://http:8080";
    process.env.HTTPS_PROXY = "http://https:8080";
    expect(resolveProxyUrlFromEnv()).toBe("http://https:8080");
  });

  it("falls back to HTTP_PROXY then ALL_PROXY", () => {
    process.env.ALL_PROXY = "http://all:8080";
    process.env.HTTP_PROXY = "http://http:8080";
    expect(resolveProxyUrlFromEnv()).toBe("http://http:8080");
    delete process.env.HTTP_PROXY;
    expect(resolveProxyUrlFromEnv()).toBe("http://all:8080");
  });

  it("ignores blank values", () => {
    process.env.HTTPS_PROXY = "  ";
    process.env.HTTP_PROXY = "http://http:8080";
    expect(resolveProxyUrlFromEnv()).toBe("http://http:8080");
  });
});

describe("shouldBypassProxyForUrl", () => {
  afterEach(() => {
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  });

  it("returns false when NO_PROXY is unset", () => {
    expect(shouldBypassProxyForUrl("https://api.telegram.org")).toBe(false);
  });

  it("supports exact host matches", () => {
    process.env.NO_PROXY = "api.telegram.org";
    expect(shouldBypassProxyForUrl("https://api.telegram.org")).toBe(true);
    expect(shouldBypassProxyForUrl("https://core.telegram.org")).toBe(false);
  });

  it("supports domain suffix matches and avoids partial host overmatch", () => {
    process.env.NO_PROXY = ".telegram.org";
    expect(shouldBypassProxyForUrl("https://api.telegram.org")).toBe(true);
    expect(shouldBypassProxyForUrl("https://telegram.org")).toBe(true);
    expect(shouldBypassProxyForUrl("https://eviltelegram.org")).toBe(false);
  });

  it("supports wildcard bypass", () => {
    process.env.NO_PROXY = "*";
    expect(shouldBypassProxyForUrl("https://api.telegram.org")).toBe(true);
    expect(shouldBypassProxyForUrl("https://example.com")).toBe(true);
  });

  it("supports entries with port/scheme and list syntax", () => {
    process.env.NO_PROXY = "https://api.telegram.org:443, localhost";
    expect(shouldBypassProxyForUrl("https://api.telegram.org")).toBe(true);
    expect(shouldBypassProxyForUrl("https://localhost:9000")).toBe(true);
    expect(shouldBypassProxyForUrl("https://example.org")).toBe(false);
  });

  it("does not broaden port-scoped NO_PROXY entries", () => {
    process.env.NO_PROXY = "api.telegram.org:8443";
    expect(shouldBypassProxyForUrl("https://api.telegram.org")).toBe(false);
    expect(shouldBypassProxyForUrl("https://api.telegram.org:8443")).toBe(true);
  });

  it("matches IPv6 localhost entries with bracketed URL hostnames", () => {
    process.env.NO_PROXY = "[::1], [::1]:443";
    expect(shouldBypassProxyForUrl("https://[::1]")).toBe(true);
    expect(shouldBypassProxyForUrl("https://[::1]:443")).toBe(true);
    expect(shouldBypassProxyForUrl("https://[::1]:8443")).toBe(true);
  });
});
