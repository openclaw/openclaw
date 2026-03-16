import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const {
  ProxyAgent,
  EnvHttpProxyAgent,
  RealUndiciFormData,
  undiciFetch,
  proxyAgentSpy,
  envAgentSpy,
  getLastAgent,
} = vi.hoisted(() => {
  // Pull the real FormData from undici so normalizeInitForUndici can compare
  // class identity between globalThis.FormData and undici's FormData.
  const { FormData: RealUndiciFormData } = require("undici") as typeof import("undici");

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
    RealUndiciFormData,
    undiciFetch,
    proxyAgentSpy,
    envAgentSpy,
    getLastAgent: () => ProxyAgent.lastCreated,
  };
});

vi.mock("undici", () => ({
  ProxyAgent,
  EnvHttpProxyAgent,
  FormData: RealUndiciFormData,
  fetch: undiciFetch,
}));

import {
  getProxyUrlFromFetch,
  makeProxyFetch,
  PROXY_FETCH_PROXY_URL,
  resolveProxyFetchFromEnv,
} from "./proxy-fetch.js";

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

  it("converts globalThis.FormData body to undici FormData", async () => {
    undiciFetch.mockResolvedValue({ ok: true });

    const fetchFn = resolveProxyFetchFromEnv({
      HTTP_PROXY: "",
      HTTPS_PROXY: "http://proxy.test:8080",
    });
    expect(fetchFn).toBeDefined();

    const form = new globalThis.FormData();
    form.append("file", new Blob([new Uint8Array(8)], { type: "audio/wav" }), "test.wav");
    form.append("model", "test-model");

    await fetchFn!("https://api.example.com/v1/audio/transcriptions", {
      method: "POST",
      body: form,
    });

    const passedInit = undiciFetch.mock.calls[0]?.[1];
    expect(passedInit.body).toBeInstanceOf(RealUndiciFormData);
    expect(passedInit.body.get("model")).toBe("test-model");
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

describe("FormData normalization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("converts globalThis.FormData to undici FormData for makeProxyFetch", async () => {
    undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch("http://proxy.test:8080");
    const form = new globalThis.FormData();
    form.append("model", "whisper-1");
    form.append("file", new Blob([new Uint8Array(4)], { type: "audio/ogg" }), "voice.ogg");

    await proxyFetch("https://api.example.com/v1/audio/transcriptions", {
      method: "POST",
      body: form,
    });

    const passedInit = undiciFetch.mock.calls[0]?.[1];
    // The body must be an undici FormData, not globalThis.FormData.
    expect(passedInit.body).toBeInstanceOf(RealUndiciFormData);
    expect(passedInit.body.get("model")).toBe("whisper-1");
    const file = passedInit.body.get("file") as Blob;
    expect(file).toBeInstanceOf(Blob);
  });

  it("passes non-FormData bodies through unchanged", async () => {
    undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch("http://proxy.test:8080");
    const jsonBody = JSON.stringify({ hello: "world" });

    await proxyFetch("https://api.example.com/test", {
      method: "POST",
      body: jsonBody,
    });

    const passedInit = undiciFetch.mock.calls[0]?.[1];
    expect(passedInit.body).toBe(jsonBody);
  });

  it("preserves undici FormData without re-conversion", async () => {
    undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch("http://proxy.test:8080");
    const form = new RealUndiciFormData();
    form.append("key", "value");

    await proxyFetch("https://api.example.com/test", {
      method: "POST",
      body: form as unknown as BodyInit,
    });

    const passedInit = undiciFetch.mock.calls[0]?.[1];
    // Should be the exact same instance — no conversion needed.
    expect(passedInit.body).toBe(form);
  });
});
