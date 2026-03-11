import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ProxyAgent, EnvHttpProxyAgent, globalFetch, proxyAgentSpy, envAgentSpy, getLastAgent } =
  vi.hoisted(() => {
    const globalFetch = vi.fn();
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
      globalFetch,
      proxyAgentSpy,
      envAgentSpy,
      getLastAgent: () => ProxyAgent.lastCreated,
    };
  });

vi.mock("undici", () => ({
  ProxyAgent,
  EnvHttpProxyAgent,
}));

import { makeProxyFetch, resolveProxyFetchFromEnv } from "./proxy-fetch.js";

describe("makeProxyFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", globalFetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses global fetch with ProxyAgent dispatcher", async () => {
    const proxyUrl = "http://proxy.test:8080";
    globalFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch(proxyUrl);
    expect(proxyAgentSpy).not.toHaveBeenCalled();
    await proxyFetch("https://api.example.com/v1/audio");

    const request = globalFetch.mock.calls[0]?.[0] as Request;
    expect(proxyAgentSpy).toHaveBeenCalledWith(proxyUrl);
    expect(request).toBeInstanceOf(Request);
    expect(request.url).toBe("https://api.example.com/v1/audio");
    expect(globalFetch).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ dispatcher: getLastAgent() }),
    );
  });

  it("materializes multipart content-type before proxy dispatch", async () => {
    const proxyFetch = makeProxyFetch("http://proxy.test:8080");
    const form = new FormData();
    form.append("file", new Blob(["hello"]), "smoke.txt");
    globalFetch.mockResolvedValue({ ok: true });

    await proxyFetch("https://api.example.com/upload", {
      method: "POST",
      body: form,
    });

    const request = globalFetch.mock.calls[0]?.[0] as Request;
    expect(request.headers.get("content-type")).toContain("multipart/form-data");
  });
});

describe("resolveProxyFetchFromEnv", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", globalFetch);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

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
    globalFetch.mockResolvedValue({ ok: true });

    const fetchFn = resolveProxyFetchFromEnv();
    expect(fetchFn).toBeDefined();
    expect(envAgentSpy).toHaveBeenCalled();

    await fetchFn!("https://api.example.com");
    const request = globalFetch.mock.calls[0]?.[0] as Request;
    expect(globalFetch).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ dispatcher: EnvHttpProxyAgent.lastCreated }),
    );
    expect(request.url).toBe("https://api.example.com/");
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
