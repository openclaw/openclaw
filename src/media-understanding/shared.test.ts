// Shared provider helper tests cover deadlines, egress fetch policy, HTTP
// config, multipart transcription, and error response parsing.
import {
  MAX_DATE_TIMESTAMP_MS,
  MAX_TIMER_TIMEOUT_MS,
} from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { VERSION } from "../version.js";

const {
  captureHttpExchangeMock,
  isDebugProxyGlobalFetchPatchInstalledMock,
  shouldUseEnvHttpProxyForUrlMock,
} = vi.hoisted(() => ({
  captureHttpExchangeMock: vi.fn(),
  isDebugProxyGlobalFetchPatchInstalledMock: vi.fn(() => false),
  shouldUseEnvHttpProxyForUrlMock: vi.fn(() => false),
}));

vi.mock("../proxy-capture/runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../proxy-capture/runtime.js")>(
    "../proxy-capture/runtime.js",
  );
  return {
    ...actual,
    captureHttpExchange: captureHttpExchangeMock,
    isDebugProxyGlobalFetchPatchInstalled: isDebugProxyGlobalFetchPatchInstalledMock,
  };
});

vi.mock("../infra/net/proxy-env.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/net/proxy-env.js")>(
    "../infra/net/proxy-env.js",
  );
  return {
    ...actual,
    shouldUseEnvHttpProxyForUrl: shouldUseEnvHttpProxyForUrlMock,
  };
});

import {
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  fetchProviderDownloadResponse,
  fetchWithTimeoutGuarded,
  pollProviderOperationJson,
  postJsonRequest,
  postTranscriptionRequest,
  readErrorResponse,
  resolveProviderOperationTimeoutMs,
  resolveProviderHttpRequestConfig,
  waitProviderOperationPollInterval,
} from "./shared.js";

beforeEach(() => {
  captureHttpExchangeMock.mockClear();
  isDebugProxyGlobalFetchPatchInstalledMock.mockReturnValue(false);
  shouldUseEnvHttpProxyForUrlMock.mockReturnValue(false);
  delete process.env.OPENCLAW_DEBUG_PROXY_ENABLED;
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("provider operation deadlines", () => {
  it("keeps default per-call timeouts when no operation timeout is configured", () => {
    const deadline = createProviderOperationDeadline({
      label: "video generation",
    });

    expect(resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: 60_000 })).toBe(60_000);
  });

  it("caps oversized operation and per-call timeouts to timer-safe values", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const deadline = createProviderOperationDeadline({
      label: "video generation",
      timeoutMs: MAX_TIMER_TIMEOUT_MS + 1_000_000,
    });

    expect(deadline.timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(deadline.deadlineAtMs).toBe(1_000 + MAX_TIMER_TIMEOUT_MS);
    expect(
      resolveProviderOperationTimeoutMs({
        deadline: createProviderOperationDeadline({ label: "no deadline" }),
        defaultTimeoutMs: MAX_TIMER_TIMEOUT_MS + 1_000_000,
      }),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("keeps operation deadlines inside the Date timestamp range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(MAX_DATE_TIMESTAMP_MS));

    const deadline = createProviderOperationDeadline({
      label: "video generation",
      timeoutMs: 1,
    });

    expect(deadline.deadlineAtMs).toBe(MAX_DATE_TIMESTAMP_MS);
    expect(() => resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: 60_000 })).toThrow(
      "video generation timed out after 1ms",
    );
  });

  it("clamps per-call timeouts to the remaining operation deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const deadline = createProviderOperationDeadline({
      label: "video generation",
      timeoutMs: 5_000,
    });

    vi.setSystemTime(4_250);

    expect(resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: 60_000 })).toBe(1_750);
  });

  it("throws once the operation deadline has expired", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const deadline = createProviderOperationDeadline({
      label: "video generation",
      timeoutMs: 2_000,
    });

    vi.setSystemTime(3_001);

    expect(() => resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: 60_000 })).toThrow(
      "video generation timed out after 2000ms",
    );
  });

  it("clamps poll waits to the remaining operation deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const deadline = createProviderOperationDeadline({
      label: "video generation",
      timeoutMs: 1_000,
    });
    const wait = waitProviderOperationPollInterval({
      deadline,
      pollIntervalMs: 10_000,
    });

    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void wait.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(wait).resolves.toBeUndefined();
  });

  it("caps oversized provider poll waits without an operation deadline", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const wait = waitProviderOperationPollInterval({
      deadline: createProviderOperationDeadline({ label: "video generation" }),
      pollIntervalMs: MAX_TIMER_TIMEOUT_MS + 1_000_000,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
    await expect(wait).resolves.toBeUndefined();
  });

  it("polls provider status JSON until a payload is complete", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "in_progress" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "completed" })));

    const result = pollProviderOperationJson<{ status?: string }>({
      url: "https://api.example.com/v1/videos/task-1",
      headers: new Headers({ authorization: "Bearer test" }),
      deadline: createProviderOperationDeadline({
        label: "video generation task task-1",
        timeoutMs: 10_000,
      }),
      defaultTimeoutMs: 5_000,
      fetchFn,
      maxAttempts: 3,
      pollIntervalMs: 1_000,
      requestFailedMessage: "status failed",
      timeoutMessage: "task timed out",
      isComplete: (payload) => payload.status === "completed",
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toEqual({ status: "completed" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("passes guarded request policy through provider status polling", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "completed" })));

    const result = await pollProviderOperationJson<{ status?: string }>({
      url: "https://api.example.com/v1/videos/task-1",
      headers: new Headers({ authorization: "Bearer test" }),
      deadline: createProviderOperationDeadline({
        label: "video generation task task-1",
      }),
      defaultTimeoutMs: 5_000,
      fetchFn,
      maxAttempts: 3,
      pollIntervalMs: 1_000,
      requestFailedMessage: "status failed",
      timeoutMessage: "task timed out",
      dispatcherPolicy: { mode: "direct" },
      auditContext: "provider-video-status",
      isComplete: (payload) => payload.status === "completed",
    });

    expect(result).toEqual({ status: "completed" });
    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://api.example.com/v1/videos/task-1");
    expect(fetchFn.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        redirect: "manual",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("retries guarded transient provider status failures while polling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("busy", { status: 503, statusText: "Service Unavailable" }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "completed" })));

    const result = pollProviderOperationJson<{ status?: string }>({
      url: "https://api.example.com/v1/videos/task-1",
      headers: new Headers({ authorization: "Bearer test" }),
      deadline: createProviderOperationDeadline({
        label: "video generation task task-1",
        timeoutMs: 10_000,
      }),
      defaultTimeoutMs: 5_000,
      fetchFn,
      maxAttempts: 3,
      pollIntervalMs: 1_000,
      requestFailedMessage: "status failed",
      timeoutMessage: "task timed out",
      isComplete: (payload) => payload.status === "completed",
    });

    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toEqual({ status: "completed" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("throws provider failure messages while polling status JSON", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "failed", error: { message: "model rejected" } })),
      );

    await expect(
      pollProviderOperationJson<{ status?: string; error?: { message?: string } }>({
        url: "https://api.example.com/v1/videos/task-1",
        headers: new Headers(),
        deadline: createProviderOperationDeadline({
          label: "video generation task task-1",
        }),
        defaultTimeoutMs: 5_000,
        fetchFn,
        maxAttempts: 3,
        pollIntervalMs: 1_000,
        requestFailedMessage: "status failed",
        timeoutMessage: "task timed out",
        isComplete: (payload) => payload.status === "completed",
        getFailureMessage: (payload) =>
          payload.status === "failed" ? payload.error?.message : undefined,
      }),
    ).rejects.toThrow("model rejected");
  });

  it("wraps malformed provider status JSON while polling", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("{ nope"));

    await expect(
      pollProviderOperationJson<{ status?: string }>({
        url: "https://api.example.com/v1/videos/task-1",
        headers: new Headers(),
        deadline: createProviderOperationDeadline({
          label: "video generation task task-1",
        }),
        defaultTimeoutMs: 5_000,
        fetchFn,
        maxAttempts: 3,
        pollIntervalMs: 1_000,
        requestFailedMessage: "status failed",
        timeoutMessage: "task timed out",
        isComplete: (payload) => payload.status === "completed",
      }),
    ).rejects.toThrow("status failed: malformed JSON response");
  });

  it("wraps wrong-shaped provider status JSON roots while polling", async () => {
    for (const payload of ["[]", '"completed"', "null"]) {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(payload));

      await expect(
        pollProviderOperationJson<{ status?: string }>({
          url: "https://api.example.com/v1/videos/task-1",
          headers: new Headers(),
          deadline: createProviderOperationDeadline({
            label: "video generation task task-1",
          }),
          defaultTimeoutMs: 5_000,
          fetchFn,
          maxAttempts: 3,
          pollIntervalMs: 1_000,
          requestFailedMessage: "status failed",
          timeoutMessage: "task timed out",
          isComplete: (body) => body.status === "completed",
        }),
      ).rejects.toThrow("status failed: malformed JSON response");
    }
  });

  it("retries transient provider status failures while polling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("busy", { status: 503, statusText: "Service Unavailable" }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "completed" })));

    const result = pollProviderOperationJson<{ status?: string }>({
      url: "https://api.example.com/v1/videos/task-1",
      headers: new Headers({ authorization: "Bearer test" }),
      deadline: createProviderOperationDeadline({
        label: "video generation task task-1",
        timeoutMs: 10_000,
      }),
      defaultTimeoutMs: 5_000,
      fetchFn,
      maxAttempts: 3,
      pollIntervalMs: 1_000,
      requestFailedMessage: "status failed",
      timeoutMessage: "task timed out",
      isComplete: (payload) => payload.status === "completed",
    });

    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toEqual({ status: "completed" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("recomputes remaining poll timeout before retry attempts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fetchFn = vi.fn<typeof fetch>(async () => {
      vi.setSystemTime(2_001);
      return new Response("busy", { status: 503, statusText: "Service Unavailable" });
    });

    const result = pollProviderOperationJson<{ status?: string }>({
      url: "https://api.example.com/v1/videos/task-1",
      headers: new Headers({ authorization: "Bearer test" }),
      deadline: createProviderOperationDeadline({
        label: "video generation task task-1",
        timeoutMs: 1_000,
      }),
      defaultTimeoutMs: 5_000,
      fetchFn,
      maxAttempts: 3,
      pollIntervalMs: 1_000,
      requestFailedMessage: "status failed",
      timeoutMessage: "task timed out",
      isComplete: (payload) => payload.status === "completed",
    });
    const assertion = expect(result).rejects.toThrow(
      "video generation task task-1 timed out after 1000ms",
    );

    await vi.advanceTimersByTimeAsync(250);

    await assertion;
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries transient generated asset downloads", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce(new Response("video-bytes", { status: 200 }));

    const response = await fetchProviderDownloadResponse({
      url: "https://cdn.example.com/video.mp4",
      init: { method: "GET" },
      timeoutMs: 5_000,
      fetchFn,
      provider: "test-video",
      requestFailedMessage: "download failed",
      retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
    });

    expect(await response.text()).toBe("video-bytes");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0, undefined);
  });

  it("recomputes remaining download timeout before retry attempts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sleep = vi.fn(async () => undefined);
    const fetchFn = vi.fn<typeof fetch>(async () => {
      vi.setSystemTime(2_001);
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    });
    const deadline = createProviderOperationDeadline({
      label: "video download",
      timeoutMs: 1_000,
    });

    await expect(
      fetchProviderDownloadResponse({
        url: "https://cdn.example.com/video.mp4",
        init: { method: "GET" },
        timeoutMs: createProviderOperationTimeoutResolver({ deadline, defaultTimeoutMs: 5_000 }),
        fetchFn,
        provider: "test-video",
        requestFailedMessage: "download failed",
        retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
      }),
    ).rejects.toThrow("video download timed out after 1000ms");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(0, undefined);
  });
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
    expect(resolved.headers.get("authorization")).toBe("Bearer override");
    expect(resolved.headers.get("x-default")).toBe("1");
    expect(resolved.headers.get("user-agent")).toBe(`openclaw/${VERSION}`);
    expect(resolved.headers.get("originator")).toBe("openclaw");
    expect(resolved.headers.get("version")).toBe(VERSION);
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
    expect(resolved.headers.get("authorization")).toBe("Token test-key");
  });

  it("allows callers to preserve custom-base detection before URL normalization", () => {
    const resolved = resolveProviderHttpRequestConfig({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
      defaultHeaders: {
        "x-goog-api-key": "test-key",
      },
      provider: "google",
      api: "google-generative-ai",
      capability: "image",
      transport: "http",
    });

    expect(resolved.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
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
  it("applies timeout signals and handles redirects manually", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));

    await fetchWithTimeoutGuarded("https://example.com", {}, undefined, fetchFn);

    expect(fetchFn).toHaveBeenCalledWith(
      "https://example.com/",
      expect.objectContaining({
        redirect: "manual",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("follows provider HTTP redirects while stripping cross-origin credentials and bodies", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://regional.example.com/v1/analyze" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await fetchWithTimeoutGuarded(
      "https://api.example.com/v1/analyze",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
          "X-Api-Key": "secret",
        },
        body: '{"media":"base64"}',
      },
      undefined,
      fetchFn,
      {
        ssrfPolicy: { allowedHostnames: ["api.example.com", "regional.example.com"] },
      },
    );
    await result.release();

    expect(result.finalUrl).toBe("https://regional.example.com/v1/analyze");
    const secondInit = fetchFn.mock.calls[1]?.[1];
    expect(secondInit?.method).toBe("GET");
    expect(secondInit?.body).toBeUndefined();
    const headers = new Headers(secondInit?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("content-type")).toBe(false);
    expect(headers.has("x-api-key")).toBe(false);
  });

  it("cancels abandoned provider response bodies on release", async () => {
    const cancel = vi.fn();
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel,
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
          }),
          { status: 200 },
        ),
    );

    const result = await fetchWithTimeoutGuarded("https://example.com", {}, undefined, fetchFn);
    await result.release();

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("blocks provider HTTP requests outside explicit hostname allowlists", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));

    await expect(
      fetchWithTimeoutGuarded("https://blocked.example/v1/analyze", {}, undefined, fetchFn, {
        ssrfPolicy: { hostnameAllowlist: ["allowed.example"] },
      }),
    ).rejects.toThrow(SsrFBlockedError);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("blocks provider HTTP requests outside explicit origin allowlists", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));

    await expect(
      fetchWithTimeoutGuarded("https://blocked.example:8443/v1/analyze", {}, undefined, fetchFn, {
        ssrfPolicy: { allowedOrigins: ["https://allowed.example:8443"] },
      }),
    ).rejects.toThrow(SsrFBlockedError);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("forwards explicit provider allowlists through JSON request helpers", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));

    await expect(
      postJsonRequest({
        url: "https://blocked.example/v1/analyze",
        headers: new Headers(),
        body: { media: "base64" },
        fetchFn,
        ssrfPolicy: { allowedHostnames: ["allowed.example"] },
      }),
    ).rejects.toThrow(SsrFBlockedError);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("records provider HTTP exchanges for debug proxy capture", async () => {
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    const fetchFn = vi.fn<typeof fetch>(async () => new Response("ok", { status: 200 }));

    await fetchWithTimeoutGuarded(
      "https://api.deepgram.com/v1/listen",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"media":"base64"}',
      },
      undefined,
      fetchFn,
      { auditContext: "transcription" },
    );

    expect(captureHttpExchangeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.deepgram.com/v1/listen",
        method: "POST",
        requestBody: '{"media":"base64"}',
        response: expect.any(Response),
        transport: "http",
        meta: {
          captureOrigin: "provider-http",
          auditContext: "transcription",
        },
      }),
      expect.objectContaining({ enabled: true }),
    );
  });

  it("does not double-record provider HTTP exchanges already captured by the global fetch patch", async () => {
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    isDebugProxyGlobalFetchPatchInstalledMock.mockReturnValue(true);
    const fetchFn = vi.fn<typeof fetch>(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchFn);

    const result = await fetchWithTimeoutGuarded(
      "https://api.deepgram.com/v1/listen",
      { method: "GET" },
      undefined,
      globalThis.fetch,
      { auditContext: "transcription" },
    );
    await result.release();

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(captureHttpExchangeMock).not.toHaveBeenCalled();
  });

  it("forwards provider audit context through JSON request helpers", async () => {
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    const fetchFn = vi.fn<typeof fetch>(async () => new Response("ok", { status: 200 }));

    await postJsonRequest({
      url: "https://api.deepgram.com/v1/listen",
      headers: new Headers({ "content-type": "application/json" }),
      body: { media: "base64" },
      fetchFn,
      auditContext: "json-analysis",
    });

    expect(captureHttpExchangeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: {
          captureOrigin: "provider-http",
          auditContext: "json-analysis",
        },
      }),
      expect.objectContaining({ enabled: true }),
    );
  });

  it("forwards explicit dispatcher policies to provider requests", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));

    await postJsonRequest({
      url: "https://api.deepgram.com/v1/listen",
      headers: new Headers({ authorization: "Token test-key" }),
      body: { hello: "world" },
      fetchFn,
      dispatcherPolicy: {
        mode: "explicit-proxy",
        proxyUrl: "http://corp-proxy.internal:3128",
      },
    });

    const init = fetchFn.mock.calls[0]?.[1] as { dispatcher?: unknown } | undefined;
    expect(init?.dispatcher).toBeDefined();
  });

  it("routes direct TLS dispatcher policies through env proxy when proxy routing applies", async () => {
    shouldUseEnvHttpProxyForUrlMock.mockReturnValue(true);
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));

    await fetchWithTimeoutGuarded("https://api.deepgram.com/v1/listen", {}, undefined, fetchFn, {
      dispatcherPolicy: {
        mode: "direct",
        connect: { ca: "test-ca" },
      },
    });

    expect(shouldUseEnvHttpProxyForUrlMock).toHaveBeenCalledWith(
      "https://api.deepgram.com/v1/listen",
    );
    const init = fetchFn.mock.calls[0]?.[1] as
      | { dispatcher?: { constructor?: { name?: string } } }
      | undefined;
    expect(init?.dispatcher?.constructor?.name).toBe("EnvHttpProxyAgent");
  });

  it("does not retry JSON POST requests by default", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(
      postJsonRequest({
        url: "https://api.example.com/v1/create",
        headers: new Headers(),
        body: { prompt: "make a video" },
        fetchFn,
      }),
    ).rejects.toThrow("socket hang up");

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries JSON POST requests only when marked as read operations", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(
      postJsonRequest({
        url: "https://api.example.com/v1/analyze",
        headers: new Headers(),
        body: { media: "base64" },
        fetchFn,
        retryStage: "read",
        retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
      }),
    ).resolves.toEqual(expect.objectContaining({ finalUrl: "https://api.example.com/v1/analyze" }));

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0, undefined);
  });

  it("retries read JSON POST transient HTTP responses", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("busy", { status: 503, statusText: "Service Unavailable" }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const result = await postJsonRequest({
      url: "https://api.example.com/v1/analyze",
      headers: new Headers(),
      body: { media: "base64" },
      fetchFn,
      retryStage: "read",
      retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
    });

    expect(result.response.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0, undefined);
  });

  it("does not retry transcription POST requests by default", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(
      postTranscriptionRequest({
        url: "https://api.example.com/v1/transcriptions",
        headers: new Headers(),
        body: "audio-bytes",
        fetchFn,
      }),
    ).rejects.toThrow("socket hang up");

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries transcription POST requests only when marked as read operations", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(
      postTranscriptionRequest({
        url: "https://api.example.com/v1/transcriptions",
        headers: new Headers(),
        body: "audio-bytes",
        fetchFn,
        retryStage: "read",
        retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
      }),
    ).resolves.toEqual(
      expect.objectContaining({ finalUrl: "https://api.example.com/v1/transcriptions" }),
    );

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0, undefined);
  });
});
