import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const undiciFetch = vi.fn();
  const proxyAgentSpy = vi.fn();
  const setGlobalDispatcher = vi.fn();
  const envHttpProxyAgentSpy = vi.fn();
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
    constructor() {
      envHttpProxyAgentSpy();
    }
  }

  return {
    ProxyAgent,
    EnvHttpProxyAgent,
    undiciFetch,
    proxyAgentSpy,
    envHttpProxyAgentSpy,
    setGlobalDispatcher,
    getLastAgent: () => ProxyAgent.lastCreated,
  };
});

vi.mock("undici", () => ({
  ProxyAgent: mocks.ProxyAgent,
  EnvHttpProxyAgent: mocks.EnvHttpProxyAgent,
  fetch: mocks.undiciFetch,
  setGlobalDispatcher: mocks.setGlobalDispatcher,
}));

import {
  makeProxyFetch,
  resolveTelegramProxyFetch,
  resolveTelegramProxyUrl,
  TELEGRAM_PROXY_ENV,
} from "./proxy.js";

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.proxyAgentSpy.mockClear();
  mocks.envHttpProxyAgentSpy.mockClear();
  mocks.undiciFetch.mockReset();
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

describe("resolveTelegramProxyUrl", () => {
  it("returns config proxy when provided", () => {
    expect(resolveTelegramProxyUrl("http://config-proxy:8080")).toBe("http://config-proxy:8080");
  });

  it("trims whitespace from config proxy", () => {
    expect(resolveTelegramProxyUrl("  http://config-proxy:8080  ")).toBe(
      "http://config-proxy:8080",
    );
  });

  it("falls back to OPENCLAW_TELEGRAM_PROXY env var", () => {
    vi.stubEnv(TELEGRAM_PROXY_ENV, "http://env-proxy:9090");
    expect(resolveTelegramProxyUrl()).toBe("http://env-proxy:9090");
  });

  it("prefers config proxy over env var", () => {
    vi.stubEnv(TELEGRAM_PROXY_ENV, "http://env-proxy:9090");
    expect(resolveTelegramProxyUrl("http://config-proxy:8080")).toBe("http://config-proxy:8080");
  });

  it("returns undefined when nothing is configured", () => {
    expect(resolveTelegramProxyUrl()).toBeUndefined();
  });

  it("ignores blank config proxy and uses env var", () => {
    vi.stubEnv(TELEGRAM_PROXY_ENV, "http://env-proxy:9090");
    expect(resolveTelegramProxyUrl("  ")).toBe("http://env-proxy:9090");
  });
});

describe("resolveTelegramProxyFetch", () => {
  it("returns ProxyAgent fetch when config proxy is set", () => {
    mocks.undiciFetch.mockResolvedValue({ ok: true });
    const result = resolveTelegramProxyFetch("http://config-proxy:8080");

    expect(result).toBeTypeOf("function");
    expect(mocks.proxyAgentSpy).toHaveBeenCalledWith("http://config-proxy:8080");
  });

  it("returns ProxyAgent fetch when OPENCLAW_TELEGRAM_PROXY env is set", () => {
    vi.stubEnv(TELEGRAM_PROXY_ENV, "http://env-proxy:9090");
    mocks.undiciFetch.mockResolvedValue({ ok: true });
    const result = resolveTelegramProxyFetch();

    expect(result).toBeTypeOf("function");
    expect(mocks.proxyAgentSpy).toHaveBeenCalledWith("http://env-proxy:9090");
  });

  it("falls back to HTTP_PROXY env var via resolveProxyFetchFromEnv", () => {
    vi.stubEnv("HTTP_PROXY", "http://http-proxy:3128");
    mocks.undiciFetch.mockResolvedValue({ ok: true });
    const result = resolveTelegramProxyFetch();

    expect(result).toBeTypeOf("function");
    expect(mocks.envHttpProxyAgentSpy).toHaveBeenCalled();
  });

  it("falls back to HTTPS_PROXY env var via resolveProxyFetchFromEnv", () => {
    vi.stubEnv("HTTPS_PROXY", "http://https-proxy:3128");
    mocks.undiciFetch.mockResolvedValue({ ok: true });
    const result = resolveTelegramProxyFetch();

    expect(result).toBeTypeOf("function");
    expect(mocks.envHttpProxyAgentSpy).toHaveBeenCalled();
  });

  it("returns undefined when no proxy is configured", () => {
    expect(resolveTelegramProxyFetch()).toBeUndefined();
  });

  it("prefers config proxy over HTTP_PROXY env", () => {
    vi.stubEnv("HTTP_PROXY", "http://http-proxy:3128");
    mocks.undiciFetch.mockResolvedValue({ ok: true });
    const result = resolveTelegramProxyFetch("http://config-proxy:8080");

    expect(result).toBeTypeOf("function");
    expect(mocks.proxyAgentSpy).toHaveBeenCalledWith("http://config-proxy:8080");
    expect(mocks.envHttpProxyAgentSpy).not.toHaveBeenCalled();
  });

  it("prefers OPENCLAW_TELEGRAM_PROXY over HTTP_PROXY", () => {
    vi.stubEnv(TELEGRAM_PROXY_ENV, "http://tg-proxy:9090");
    vi.stubEnv("HTTP_PROXY", "http://http-proxy:3128");
    mocks.undiciFetch.mockResolvedValue({ ok: true });
    const result = resolveTelegramProxyFetch();

    expect(result).toBeTypeOf("function");
    expect(mocks.proxyAgentSpy).toHaveBeenCalledWith("http://tg-proxy:9090");
    expect(mocks.envHttpProxyAgentSpy).not.toHaveBeenCalled();
  });
});
