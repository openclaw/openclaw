import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProxyUrlFromFetch, makeProxyFetch, resolveProxyFetchFromEnv } from "./proxy-fetch.js";

const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
] as const;

const {
  EnvHttpProxyAgent,
  MockUndiciFormData,
  undiciFetch,
  envAgentSpy,
  createHttp1EnvHttpProxyAgent,
  createHttp1ProxyAgent,
  loadUndiciRuntimeDeps,
} = vi.hoisted(() => {
  const fetchMock = vi.fn<typeof fetch>();
  const agentSpy = vi.fn();
  class FormDataMock {
    readonly entriesList: [string, unknown, string | undefined][] = [];

    append(key: string, value: unknown, filename?: string): void {
      this.entriesList.push([key, value, filename]);
    }

    get(key: string): unknown {
      return this.entriesList.find(([entryKey]) => entryKey === key)?.[1] ?? null;
    }
  }
  const ProxyAgent = vi.fn();
  class EnvAgent {
    static lastCreated: EnvAgent | undefined;
    constructor(options?: Record<string, unknown>) {
      EnvAgent.lastCreated = this;
      agentSpy(options);
    }
  }
  return {
    EnvHttpProxyAgent: EnvAgent,
    MockUndiciFormData: FormDataMock,
    undiciFetch: fetchMock,
    envAgentSpy: agentSpy,
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

function requireProxyFetch(
  fetchFn: ReturnType<typeof resolveProxyFetchFromEnv>,
): NonNullable<ReturnType<typeof resolveProxyFetchFromEnv>> {
  if (!fetchFn) {
    throw new Error("expected proxy env to resolve a fetch function");
  }
  return fetchFn;
}

function requireUndiciFetchCall(index = 0) {
  const call = undiciFetch.mock.calls[index];
  if (!call) {
    throw new Error(`expected undici fetch call at index ${index}`);
  }
  return call;
}

function requireUndiciFetchInit(index = 0) {
  const init = requireUndiciFetchCall(index)[1];
  if (!init) {
    throw new Error(`expected undici fetch init at index ${index}`);
  }
  return init;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of PROXY_ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => vi.doUnmock("./undici-runtime.js"));

describe("proxy fetch", () => {
  it("converts global FormData bodies before dispatching through undici", async () => {
    undiciFetch.mockResolvedValue(new Response());

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

    const passedInit = requireUndiciFetchInit();
    const passedBody = passedInit.body;
    expect(passedBody).toBeInstanceOf(MockUndiciFormData);
    if (!(passedBody instanceof MockUndiciFormData)) {
      throw new Error("expected converted FormData");
    }
    expect(passedBody.get("model")).toBe("whisper-1");
    expect(passedBody.get("file")).toBeInstanceOf(Blob);
    expect(passedBody.entriesList.find(([key]) => key === "file")?.[2]).toBe("voice.ogg");
    const sentHeaders = new Headers(passedInit.headers);
    expect(sentHeaders.has("content-length")).toBe(false);
    expect(sentHeaders.has("content-type")).toBe(false);
  });
  it("returns undefined for plain fetch functions or blank metadata", () => {
    const plainFetch = vi.fn() as unknown as typeof fetch;
    const blankMetadataFetch = makeProxyFetch("   ");

    expect(getProxyUrlFromFetch(plainFetch)).toBeUndefined();
    expect(getProxyUrlFromFetch(blankMetadataFetch)).toBeUndefined();
  });
  it("returns proxy fetch using EnvHttpProxyAgent when HTTPS_PROXY is set", async () => {
    undiciFetch.mockResolvedValue(new Response());

    const fetchFn = requireProxyFetch(
      resolveProxyFetchFromEnv({
        HTTP_PROXY: "",
        HTTPS_PROXY: "http://proxy.test:8080",
      }),
    );
    expect(envAgentSpy).toHaveBeenCalledWith(
      expect.objectContaining({ httpsProxy: "http://proxy.test:8080" }),
    );

    await fetchFn("https://api.example.com");
    expect(undiciFetch).toHaveBeenCalledOnce();
    expect(requireUndiciFetchCall()).toEqual([
      "https://api.example.com",
      expect.objectContaining({ dispatcher: EnvHttpProxyAgent.lastCreated }),
    ]);
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
