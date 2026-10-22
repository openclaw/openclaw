import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProxyUrlFromFetch, makeProxyFetch, resolveProxyFetchFromEnv } from "./proxy-fetch.js";
import { fetchWithRuntimeDispatcher } from "./runtime-fetch.js";

const {
  EnvHttpProxyAgent,
  MockUndiciFormData,
  undiciFetch,
  createHttp1EnvHttpProxyAgent,
  createHttp1ProxyAgent,
  loadUndiciRuntimeDeps,
} = vi.hoisted(() => {
  const fetchMock = vi.fn<typeof fetch>();
  class FormDataMock {
    readonly entriesList: [string, unknown, string | undefined][] = [];

    append(key: string, value: unknown, filename?: string): void {
      this.entriesList.push([key, value, filename]);
    }
  }
  const ProxyAgent = vi.fn();
  const EnvAgent = vi.fn(function EnvAgent(_options?: Record<string, unknown>) {});
  return {
    EnvHttpProxyAgent: EnvAgent,
    MockUndiciFormData: FormDataMock,
    undiciFetch: fetchMock,
    createHttp1EnvHttpProxyAgent: vi.fn(
      (options?: Record<string, unknown>) => new EnvAgent(options),
    ),
    createHttp1ProxyAgent: vi.fn(
      (options: { uri?: string; proxyTls?: unknown } | string) => new ProxyAgent(options),
    ),
    loadUndiciRuntimeDeps: vi.fn(() => ({
      ProxyAgent,
      EnvHttpProxyAgent: EnvAgent,
      FormData: FormDataMock,
      fetch: fetchMock,
    })),
  };
});

vi.mock("./undici-runtime.js", () => ({
  createHttp1EnvHttpProxyAgent,
  createHttp1ProxyAgent,
  loadUndiciRuntimeDeps,
}));

const requireUndiciFetchCall = () => expectDefined(undiciFetch.mock.calls[0], "runtime fetch call");

beforeEach(() => {
  vi.clearAllMocks();
  undiciFetch.mockResolvedValue(new Response());
  for (const key of "HTTPS_PROXY HTTP_PROXY ALL_PROXY https_proxy http_proxy all_proxy".split(
    " ",
  )) {
    vi.stubEnv(key, undefined);
  }
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => vi.doUnmock("./undici-runtime.js"));

describe("proxy fetch", () => {
  it("drops symbol header metadata before runtime fetch without mutating caller headers", async () => {
    const headers = { "Content-Type": "application/json" };
    Object.defineProperty(headers, Symbol("sensitiveHeaders"), {
      value: new Set(["content-type"]),
      enumerable: false,
    });
    const response = await fetchWithRuntimeDispatcher("https://example.com", {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(undiciFetch).toHaveBeenCalledOnce();
    const sentHeaders = requireUndiciFetchCall()[1]?.headers;
    expect(new Headers(sentHeaders).get("content-type")).toBe("application/json");
    expect(sentHeaders).not.toBe(headers);
    expect(Object.getOwnPropertySymbols(sentHeaders as object)).toStrictEqual([]);
    expect(Object.getOwnPropertySymbols(headers)).toHaveLength(1);
  });
  it("converts global FormData bodies before dispatching through undici", async () => {
    const proxyFetch = makeProxyFetch("http://proxy.test:8080");
    const form = new globalThis.FormData();
    form.append("model", "whisper-1");
    form.append("file", new Blob([new Uint8Array(4)], { type: "audio/ogg" }), "voice.ogg");

    await proxyFetch("https://api.example.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "content-length": "999",
        "content-type": "multipart/form-data; boundary=stale",
      },
      body: form,
    });

    const [, init] = requireUndiciFetchCall();
    expect(init?.body).toBeInstanceOf(MockUndiciFormData);
    expect(init).toMatchObject({
      body: {
        entriesList: [
          ["model", "whisper-1", undefined],
          ["file", expect.any(Blob), "voice.ogg"],
        ],
      },
    });
    const headers = new Headers(init?.headers);
    expect([headers.has("content-length"), headers.has("content-type")]).toEqual([false, false]);
  });
  it("returns undefined for plain fetch functions or blank metadata", () => {
    expect(getProxyUrlFromFetch(vi.fn<typeof fetch>())).toBeUndefined();
    expect(getProxyUrlFromFetch(makeProxyFetch("   "))).toBeUndefined();
  });
  it("returns proxy fetch using EnvHttpProxyAgent when HTTPS_PROXY is set", async () => {
    const fetchFn = expectDefined(
      resolveProxyFetchFromEnv({
        HTTP_PROXY: "",
        HTTPS_PROXY: "http://proxy.test:8080",
      }),
      "proxy fetch",
    );
    expect(EnvHttpProxyAgent).toHaveBeenCalledWith(
      expect.objectContaining({ httpsProxy: "http://proxy.test:8080" }),
    );

    await fetchFn("https://api.example.com");
    expect(undiciFetch).toHaveBeenCalledOnce();
    expect(requireUndiciFetchCall()).toEqual([
      "https://api.example.com",
      expect.objectContaining({ dispatcher: EnvHttpProxyAgent.mock.instances[0] }),
    ]);
  });

  it("returns undefined when EnvHttpProxyAgent constructor throws", () => {
    EnvHttpProxyAgent.mockImplementationOnce(() => {
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
