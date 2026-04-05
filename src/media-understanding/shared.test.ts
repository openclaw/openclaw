import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("../infra/net/fetch-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

import {
  fetchWithTimeoutGuarded,
  postJsonRequest,
  postTranscriptionRequest,
  readErrorResponse,
  resolveProviderHttpRequestConfig,
} from "./shared.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveProviderHttpRequestConfig", () => {
  it("preserves explicit caller headers but protects attribution headers", () => {
    const resolved = resolveProviderHttpRequestConfig({
      baseUrl: "https://api.openai.com/v1/",
      defaultBaseUrl: "https://api.openai.com/v1",
      headers: {
        authorization: "Bearer override",
        "User-Agent": "custom-agent/1.0",
        originator: "spoofed",
      },
      defaultHeaders: {
        authorization: "Bearer default-token",
        "X-Default": "1",
      },
      provider: "openai",
      api: "openai-audio-transcriptions",
      capability: "audio",
      transport: "media-understanding",
    });

    expect(resolved.baseUrl).toBe("https://api.openai.com/v1");
    expect(resolved.allowPrivateNetwork).toBe(true);
    expect(resolved.headers.get("authorization")).toBe("Bearer override");
    expect(resolved.headers.get("x-default")).toBe("1");
    expect(resolved.headers.get("user-agent")).toMatch(/^openclaw\//);
    expect(resolved.headers.get("originator")).toBe("openclaw");
    expect(resolved.headers.get("version")).toBeTruthy();
  });

  it("uses the fallback base URL without enabling private-network access", () => {
    const resolved = resolveProviderHttpRequestConfig({
      defaultBaseUrl: "https://api.deepgram.com/v1/",
      defaultHeaders: {
        authorization: "Token test-key",
      },
      provider: "deepgram",
      capability: "audio",
      transport: "media-understanding",
    });

    expect(resolved.baseUrl).toBe("https://api.deepgram.com/v1");
    expect(resolved.allowPrivateNetwork).toBe(false);
    expect(resolved.headers.get("authorization")).toBe("Token test-key");
  });

  it("allows callers to preserve custom-base detection before URL normalization", () => {
    const resolved = resolveProviderHttpRequestConfig({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
      allowPrivateNetwork: false,
      defaultHeaders: {
        "x-goog-api-key": "test-key",
      },
      provider: "google",
      api: "google-generative-ai",
      capability: "image",
      transport: "http",
    });

    expect(resolved.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(resolved.allowPrivateNetwork).toBe(false);
    expect(resolved.headers.get("x-goog-api-key")).toBe("test-key");
  });

  it("surfaces dispatcher policy for explicit proxy and mTLS transport overrides", () => {
    const resolved = resolveProviderHttpRequestConfig({
      baseUrl: "https://api.deepgram.com/v1",
      defaultBaseUrl: "https://api.deepgram.com/v1",
      defaultHeaders: {
        authorization: "Token test-key",
      },
      request: {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
          tls: {
            ca: "proxy-ca",
          },
        },
        tls: {
          cert: "client-cert",
          key: "client-key",
        },
      },
      provider: "deepgram",
      capability: "audio",
      transport: "media-understanding",
    });

    expect(resolved.dispatcherPolicy).toEqual({
      mode: "explicit-proxy",
      proxyUrl: "http://proxy.internal:8443",
      proxyTls: {
        ca: "proxy-ca",
      },
    });
  });

  it("fails fast when no base URL can be resolved", () => {
    expect(() =>
      resolveProviderHttpRequestConfig({
        baseUrl: "   ",
        defaultBaseUrl: "   ",
      }),
    ).toThrow("Missing baseUrl");
  });
});

describe("readErrorResponse", () => {
  it("caps streamed error bodies instead of buffering the whole response", async () => {
    const encoder = new TextEncoder();
    let reads = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          reads += 1;
          controller.enqueue(encoder.encode("a".repeat(2048)));
          if (reads >= 10) {
            controller.close();
          }
        },
      }),
      {
        status: 500,
      },
    );

    const detail = await readErrorResponse(response);

    expect(detail).toBe(`${"a".repeat(300)}…`);
    expect(reads).toBe(2);
  });
});

describe("fetchWithTimeoutGuarded", () => {
  it("applies a default timeout when callers omit one", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await fetchWithTimeoutGuarded("https://example.com", {}, undefined, fetch);

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com",
        timeoutMs: 60_000,
      }),
    );
  });

  it("sanitizes auditContext before passing it to the SSRF guard", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await fetchWithTimeoutGuarded("https://example.com", {}, 5000, fetch, {
      auditContext: "provider-http\r\nfal\timage\u001btest",
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        auditContext: "provider-http fal image test",
        timeoutMs: 5000,
      }),
    );
  });

  it("passes configured explicit proxy policy through the SSRF guard", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await postJsonRequest({
      url: "https://api.deepgram.com/v1/listen",
      headers: new Headers({ authorization: "Token test-key" }),
      body: { hello: "world" },
      fetchFn: fetch,
      dispatcherPolicy: {
        mode: "explicit-proxy",
        proxyUrl: "http://169.254.169.254:8080",
      },
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatcherPolicy: {
          mode: "explicit-proxy",
          proxyUrl: "http://169.254.169.254:8080",
        },
      }),
    );
  });

  it("forwards explicit pinDns overrides to JSON requests", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await postJsonRequest({
      url: "https://api.example.com/v1/test",
      headers: new Headers(),
      body: { ok: true },
      fetchFn: fetch,
      pinDns: false,
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pinDns: false,
      }),
    );
  });

  it("forwards explicit pinDns overrides to transcription requests", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await postTranscriptionRequest({
      url: "https://api.example.com/v1/transcriptions",
      headers: new Headers(),
      body: "audio-bytes",
      fetchFn: fetch,
      pinDns: false,
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pinDns: false,
      }),
    );
  });
});
