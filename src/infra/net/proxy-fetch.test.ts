import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
] as const;

const ORIGINAL_PROXY_ENV = Object.fromEntries(
  PROXY_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>;

const { ProxyAgent, Socks5ProxyAgent, EnvHttpProxyAgent, undiciFetch, proxyAgentSpy, socks5AgentSpy, envAgentSpy, getLastAgent, getLastSocksAgent } =
  vi.hoisted(() => {
    const undiciFetch = vi.fn();
    const proxyAgentSpy = vi.fn();
    const socks5AgentSpy = vi.fn();
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
    class Socks5ProxyAgent {
      static lastCreated: Socks5ProxyAgent | undefined;
      uri: string;
      constructor(opts: { uri: string }) {
        this.uri = opts.uri;
        Socks5ProxyAgent.lastCreated = this;
        socks5AgentSpy(opts.uri);
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
      Socks5ProxyAgent,
      EnvHttpProxyAgent,
      undiciFetch,
      proxyAgentSpy,
      socks5AgentSpy,
      envAgentSpy,
      getLastAgent: () => ProxyAgent.lastCreated,
      getLastSocksAgent: () => Socks5ProxyAgent.lastCreated,
    };
  });

const mockedModuleIds = ["undici"] as const;

vi.mock("undici", () => ({
  ProxyAgent,
  Socks5ProxyAgent,
  EnvHttpProxyAgent,
  fetch: undiciFetch,
}));

let getProxyUrlFromFetch: typeof import("./proxy-fetch.js").getProxyUrlFromFetch;
let makeProxyFetch: typeof import("./proxy-fetch.js").makeProxyFetch;
let PROXY_FETCH_PROXY_URL: typeof import("./proxy-fetch.js").PROXY_FETCH_PROXY_URL;
let resolveProxyFetchFromEnv: typeof import("./proxy-fetch.js").resolveProxyFetchFromEnv;

function clearProxyEnv(): void {
  for (const key of PROXY_ENV_KEYS) {
    delete process.env[key];
  }
}

function restoreProxyEnv(): void {
  clearProxyEnv();
  for (const key of PROXY_ENV_KEYS) {
    const value = ORIGINAL_PROXY_ENV[key];
    if (typeof value === "string") {
      process.env[key] = value;
    }
  }
}

describe("makeProxyFetch", () => {
  beforeAll(async () => {
    ({ getProxyUrlFromFetch, makeProxyFetch, PROXY_FETCH_PROXY_URL, resolveProxyFetchFromEnv } =
      await import("./proxy-fetch.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it("uses Socks5ProxyAgent for socks5:// proxy URLs", async () => {
    const proxyUrl = "socks5://127.0.0.1:1080";
    undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch(proxyUrl);
    expect(socks5AgentSpy).not.toHaveBeenCalled();
    await proxyFetch("https://api.telegram.org/file/bot123/photo.jpg");

    expect(socks5AgentSpy).toHaveBeenCalledWith(proxyUrl);
    expect(proxyAgentSpy).not.toHaveBeenCalled();
    expect(undiciFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/file/bot123/photo.jpg",
      expect.objectContaining({ dispatcher: getLastSocksAgent() }),
    );
  });

  it("uses Socks5ProxyAgent for socks4:// proxy URLs", async () => {
    const proxyUrl = "socks4://127.0.0.1:1080";
    undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch(proxyUrl);
    await proxyFetch("https://api.telegram.org/file/bot123/photo.jpg");

    expect(socks5AgentSpy).toHaveBeenCalledWith(proxyUrl);
    expect(proxyAgentSpy).not.toHaveBeenCalled();
  });

  it("reuses the same Socks5ProxyAgent across calls", async () => {
    undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch("socks5://127.0.0.1:1080");

    await proxyFetch("https://api.telegram.org/one");
    const firstDispatcher = undiciFetch.mock.calls[0]?.[1]?.dispatcher;
    await proxyFetch("https://api.telegram.org/two");
    const secondDispatcher = undiciFetch.mock.calls[1]?.[1]?.dispatcher;

    expect(socks5AgentSpy).toHaveBeenCalledOnce();
    expect(secondDispatcher).toBe(firstDispatcher);
  });

  it("preserves proxyUrl metadata on socks5 proxy fetch", () => {
    const proxyUrl = "socks5://127.0.0.1:1080";
    expect(getProxyUrlFromFetch(makeProxyFetch(proxyUrl))).toBe(proxyUrl);
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
    vi.unstubAllEnvs();
    clearProxyEnv();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    restoreProxyEnv();
  });

  it("returns undefined when no proxy env vars are set", () => {
    expect(resolveProxyFetchFromEnv({})).toBeUndefined();
  });

  it("returns proxy fetch using EnvHttpProxyAgent when HTTPS_PROXY is set", async () => {
    undiciFetch.mockResolvedValue({ ok: true });

    const fetchFn = resolveProxyFetchFromEnv({
      HTTP_PROXY: "",
      HTTPS_PROXY: "http://proxy.test:8080",
    });
    expect(fetchFn).toBeDefined();
    expect(envAgentSpy).toHaveBeenCalled();

    await fetchFn!("https://api.example.com");
    expect(undiciFetch).toHaveBeenCalledWith(
      "https://api.example.com",
      expect.objectContaining({ dispatcher: EnvHttpProxyAgent.lastCreated }),
    );
  });

  it("returns proxy fetch when HTTP_PROXY is set", () => {
    const fetchFn = resolveProxyFetchFromEnv({
      HTTPS_PROXY: "",
      HTTP_PROXY: "http://fallback.test:3128",
    });
    expect(fetchFn).toBeDefined();
    expect(envAgentSpy).toHaveBeenCalled();
  });

  it("returns proxy fetch when lowercase https_proxy is set", () => {
    const fetchFn = resolveProxyFetchFromEnv({
      HTTPS_PROXY: "",
      HTTP_PROXY: "",
      http_proxy: "",
      https_proxy: "http://lower.test:1080",
    });
    expect(fetchFn).toBeDefined();
    expect(envAgentSpy).toHaveBeenCalled();
  });

  it("returns proxy fetch when lowercase http_proxy is set", () => {
    const fetchFn = resolveProxyFetchFromEnv({
      HTTPS_PROXY: "",
      HTTP_PROXY: "",
      https_proxy: "",
      http_proxy: "http://lower-http.test:1080",
    });
    expect(fetchFn).toBeDefined();
    expect(envAgentSpy).toHaveBeenCalled();
  });

  it("returns undefined when EnvHttpProxyAgent constructor throws", () => {
    envAgentSpy.mockImplementationOnce(() => {
      throw new Error("Invalid URL");
    });

    const fetchFn = resolveProxyFetchFromEnv({
      HTTP_PROXY: "",
      https_proxy: "",
      http_proxy: "",
      HTTPS_PROXY: "not-a-valid-url",
    });
    expect(fetchFn).toBeUndefined();
  });
});

afterAll(() => {
  for (const id of mockedModuleIds) {
    vi.doUnmock(id);
  }
});
