import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../version.js";

const { guardedFetch, usesProxy } = vi.hoisted(() => ({
  guardedFetch: vi.fn<typeof import("../infra/net/fetch-guard.js").fetchWithSsrFGuard>(),
  usesProxy: vi.fn(() => false),
}));

vi.mock("../infra/net/fetch-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/net/fetch-guard.js")>()),
  fetchWithSsrFGuard: guardedFetch,
}));

vi.mock("../infra/net/proxy-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/net/proxy-env.js")>()),
  shouldUseEnvHttpProxyForUrl: usesProxy,
}));

import { postJsonResponse } from "./provider-json-post.js";
import {
  createProviderOperationDeadline,
  fetchProviderDownloadResponse,
  fetchWithTimeoutGuarded,
  pollProviderOperationJson,
  postJsonRequest,
  postMultipartRequest,
  postTranscriptionRequest,
  resolveProviderHttpRequestConfig,
  resolveProviderHttpRequestConfigWithOriginTrust,
  resolveProviderOperationTimeoutMs,
  waitProviderOperationPollInterval,
} from "./shared.js";

it.each([
  ['{"id":"job-1"}', 200, true, undefined, { id: "job-1" }],
  ['["job-1"]', 200, false, undefined, ["job-1"]],
  ["[]", 200, true, "response: malformed JSON response", undefined],
  ["{", 200, false, "response: malformed JSON response", undefined],
  ['{"error":"bad request"}', 400, false, "submission", undefined],
] as const)(
  "releases the response for %s (%i, object=%s)",
  async (body, status, objectResponse, error, expected) => {
    const release = queueGuardedResponse(new Response(body, { status }));
    const params = {
      url: "https://provider.example/jobs",
      headers: new Headers({ "Content-Type": "application/json" }),
      body: { prompt: "Synthetic submission" },
      fetchFn: fetch,
      errorLabel: "submission",
      responseLabel: "response",
    };
    const result = objectResponse
      ? postJsonResponse({ ...params, objectResponse: true })
      : postJsonResponse<unknown>(params);
    if (error) {
      await expect(result).rejects.toThrow(error);
    } else {
      await expect(result).resolves.toEqual(expected);
    }
    expect(release).toHaveBeenCalledExactlyOnceWith();
  },
);
beforeEach(() => {
  usesProxy.mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

const getFirstGuardedFetchCall = () => guardedFetch.mock.calls[0]![0];

function createTricklingResponse(status = 200): Response {
  const chunk = new TextEncoder().encode("{");
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(chunk);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

const pollLabel = "video generation task task-1";
const makeDeadline = (timeoutMs?: number, label = "video generation") =>
  createProviderOperationDeadline({ label, timeoutMs });
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body));
const busyResponse = () => new Response("busy", { status: 503, statusText: "Service Unavailable" });
type PollPayload = { status?: string; error?: { message?: string } };
type PollOptions = Partial<Parameters<typeof pollProviderOperationJson<PollPayload>>[0]>;
function poll(fetchFn: typeof fetch, timeoutMs?: number, options: PollOptions = {}) {
  return pollProviderOperationJson<PollPayload>({
    url: "https://api.example.com/v1/videos/task-1",
    headers: new Headers(),
    deadline: makeDeadline(timeoutMs, pollLabel),
    defaultTimeoutMs: 5_000,
    fetchFn,
    maxAttempts: 3,
    pollIntervalMs: 1_000,
    requestFailedMessage: "status failed",
    timeoutMessage: "task timed out",
    isComplete: (payload: { status?: string }) => payload.status === "completed",
    ...options,
  });
}

function downloadOptions(fetchFn: typeof fetch) {
  return {
    url: "https://cdn.example.com/video.mp4",
    init: { method: "GET" },
    fetchFn,
    provider: "test-video",
    requestFailedMessage: "download failed",
  };
}
function postOptions() {
  const body = { ok: true };
  return { url: "https://api.example.com/v1/test", headers: new Headers(), body, fetchFn: fetch };
}
function queueGuardedResponse(response: Response) {
  const release = vi.fn(async () => {});
  guardedFetch.mockResolvedValueOnce({
    response,
    finalUrl: "https://api.example.com",
    release,
  });
  return release;
}

describe("provider operation deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });
  it("caps oversized operation and per-call timeouts to timer-safe values", () => {
    const deadline = makeDeadline(MAX_TIMER_TIMEOUT_MS + 1_000_000);

    expect(deadline.timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(deadline.deadlineAtMs).toBe(1_000 + MAX_TIMER_TIMEOUT_MS);
    expect(
      resolveProviderOperationTimeoutMs({
        deadline: makeDeadline(undefined, "no deadline"),
        defaultTimeoutMs: MAX_TIMER_TIMEOUT_MS + 1_000_000,
      }),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("exhausts a short deadline as the monotonic clock advances", () => {
    const deadline = makeDeadline(1);

    vi.advanceTimersByTime(1);

    expect(() => resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: 60_000 })).toThrow(
      "video generation timed out after 1ms",
    );
  });

  it.each([false, true])("keeps admitted budgets monotonic (cloned=%s)", (cloned) => {
    const created = makeDeadline(60_000);
    const deadline = cloned ? structuredClone(created) : created;
    expect(resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: 120_000 })).toBe(60_000);
    vi.setSystemTime(1_000 - 100_000);
    expect(resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: 120_000 })).toBe(60_000);
    vi.setSystemTime(1_000 + 120_000);
    expect(resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: 120_000 })).toBe(60_000);

    vi.advanceTimersByTime(30_000);
    expect(resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: 120_000 })).toBe(30_000);
  });

  it("honors public epoch edits without resolving a lazy total timeout again", () => {
    const resolveTimeoutMs = vi.fn(() => 5_000);

    const deadline = createProviderOperationDeadline({
      label: "generated media download",
      timeoutMs: resolveTimeoutMs,
    });
    vi.advanceTimersByTime(3_250);

    deadline.deadlineAtMs = 7_000;
    expect(resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: 60_000 })).toBe(2_750);
    expect(resolveTimeoutMs).toHaveBeenCalledTimes(1);
  });

  it("normalizes fractional remaining budgets before passing them to Node timers", () => {
    const deadline = makeDeadline(5_000);
    vi.advanceTimersByTime(1.25);

    expect(resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: 60_000 })).toBe(4_998);
  });

  it.each([
    ["remaining deadline", 1_000, 10_000, 1_000],
    ["timer maximum", undefined, MAX_TIMER_TIMEOUT_MS + 1_000_000, MAX_TIMER_TIMEOUT_MS],
  ] as const)("caps poll waits at the %s", async (_label, timeoutMs, pollIntervalMs, expected) => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const wait = waitProviderOperationPollInterval({
      deadline: makeDeadline(timeoutMs),
      pollIntervalMs,
    });
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), expected);
    let settled = false;
    void wait.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(expected - 1);
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(wait).resolves.toBeUndefined();
  });

  it.each(["poll", "download"])("bounds a trickling %s response body", async (stage) => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(createTricklingResponse(stage === "poll" ? 200 : 503));
    const result =
      stage === "poll"
        ? poll(fetchFn, 100)
        : fetchProviderDownloadResponse({
            ...downloadOptions(fetchFn),
            deadline: makeDeadline(100, "download failed"),
            retry: { attempts: 1 },
          });
    const label = stage === "poll" ? pollLabel : "download failed";
    const assertion = expect(result).rejects.toThrow(`${label} timed out after 100ms`);
    await vi.advanceTimersByTimeAsync(110);
    await assertion;
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries guarded transient provider status failures while polling", async () => {
    const firstRelease = queueGuardedResponse(busyResponse());
    const secondRelease = queueGuardedResponse(jsonResponse({ status: "completed" }));

    const result = poll(fetch, 10_000, {
      headers: new Headers({ authorization: "Bearer test" }),
      allowPrivateNetwork: true,
      dispatcherPolicy: { mode: "direct" },
      auditContext: "provider-video-status",
    });

    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toEqual({ status: "completed" });
    expect(guardedFetch).toHaveBeenCalledTimes(2);
    const call = getFirstGuardedFetchCall();
    expect([call.policy, call.dispatcherPolicy, call.auditContext]).toEqual([
      { allowPrivateNetwork: true },
      { mode: "direct" },
      "provider-video-status",
    ]);
    expect(firstRelease).toHaveBeenCalledTimes(1);
    expect(secondRelease).toHaveBeenCalledTimes(1);
  });

  it.each(["poll", "download"])(
    "recomputes the remaining %s timeout before retries",
    async (stage) => {
      const sleep = vi.fn(async () => undefined);
      const fetchFn = vi.fn<typeof fetch>(async () => {
        vi.advanceTimersByTime(1_001);
        if (stage === "download") {
          throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
        }
        return busyResponse();
      });
      const result =
        stage === "poll"
          ? poll(fetchFn, 1_000, {
              headers: new Headers({ authorization: "Bearer test" }),
            })
          : fetchProviderDownloadResponse({
              ...downloadOptions(fetchFn),
              deadline: makeDeadline(1_000, "video download"),
              retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
            });
      const label = stage === "poll" ? pollLabel : "video download";
      const assertion = expect(result).rejects.toThrow(`${label} timed out after 1000ms`);
      if (stage === "poll") {
        await vi.advanceTimersByTimeAsync(250);
      }
      await assertion;
      expect(fetchFn).toHaveBeenCalledTimes(1);
      if (stage === "download") {
        expect(sleep).toHaveBeenCalledWith(0, undefined);
      }
    },
  );

  it("retries transient generated asset downloads", async () => {
    vi.useRealTimers();
    const sleep = vi.fn(async () => undefined);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce(new Response("video-bytes", { status: 200 }));

    const response = await fetchProviderDownloadResponse({
      ...downloadOptions(fetchFn),
      // Keep the shipped timeoutMs call shape working for external plugins.
      timeoutMs: 5_000,
      retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
    });

    expect(await response.text()).toBe("video-bytes");
    expect(fetchFn).toHaveBeenCalledTimes(2);
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

    expect(resolved).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      allowPrivateNetwork: false,
    });
    expect(Object.fromEntries(resolved.headers)).toMatchObject({
      authorization: "Bearer override",
      "x-default": "1",
      "user-agent": `openclaw/${VERSION}`,
      originator: "openclaw",
      version: VERSION,
    });
  });

  it("removes default headers marked null by the runtime caller", () => {
    const defaults = { Authorization: "Bearer original", "X-Keep": "retained" };
    const resolved = resolveProviderHttpRequestConfig({
      defaultBaseUrl: "https://provider.example/v1",
      defaultHeaders: defaults,
      headers: { authorization: null },
      provider: "custom",
    });
    expect(resolved.headers.has("authorization")).toBe(false);
    expect(resolved.headers.get("x-keep")).toBe("retained");
    expect(defaults.Authorization).toBe("Bearer original");
  });

  it("keeps configured-origin trust eligibility internal to core callers", () => {
    const customConfig = {
      baseUrl: "https://models.internal/v1",
      defaultBaseUrl: "https://api.example.com/v1",
      provider: "example",
    };
    const custom = resolveProviderHttpRequestConfigWithOriginTrust(customConfig);
    const deniedLocal = resolveProviderHttpRequestConfigWithOriginTrust({
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultBaseUrl: "https://api.example.com/v1",
      provider: "example",
      request: { allowPrivateNetwork: false },
    });

    expect(custom.trustConfiguredBaseUrlOrigin).toBe(true);
    expect(deniedLocal.trustConfiguredBaseUrlOrigin).toBe(false);
    expect(resolveProviderHttpRequestConfig(customConfig)).not.toHaveProperty(
      "trustConfiguredBaseUrlOrigin",
    );
  });

  it("fails fast when no base URL can be resolved", () => {
    const emptyUrls = { baseUrl: "   ", defaultBaseUrl: "   " };
    expect(() => resolveProviderHttpRequestConfig(emptyUrls)).toThrow("Missing baseUrl");
  });
});

describe("fetchWithTimeoutGuarded", () => {
  beforeEach(() => {
    guardedFetch.mockResolvedValue({
      response: new Response(),
      finalUrl: "https://example.com",
      release: async () => {},
    });
  });
  it("truncates auditContext without leaving a lone surrogate at the max boundary", async () => {
    const prefix = "a".repeat(79);
    await fetchWithTimeoutGuarded("https://example.com", {}, 5000, fetch, {
      auditContext: `${prefix}${String.fromCodePoint(0x1f600)}tail`,
    });

    const call = getFirstGuardedFetchCall();
    expect(call.auditContext).toBe(prefix);
    expect(call.auditContext).not.toContain(String.fromCharCode(0xd83d));
  });

  it("merges full SSRF policy into JSON request guards", async () => {
    await postJsonRequest({
      ...postOptions(),
      allowPrivateNetwork: true,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });
    expect(getFirstGuardedFetchCall().policy).toEqual({
      allowPrivateNetwork: true,
      allowRfc2544BenchmarkRange: true,
    });
  });

  it.each([
    ["pinDns", postMultipartRequest, { pinDns: false }, false],
    ["mode", postTranscriptionRequest, {}, "trusted_env_proxy"],
    ["mode", postTranscriptionRequest, { mode: "strict" }, "strict"],
  ] as const)("forwards multipart %s (case %#)", async (field, send, options, expected) => {
    usesProxy.mockReturnValue(true);
    await send({ ...postOptions(), body: "audio-bytes", ...options });
    expect(getFirstGuardedFetchCall()[field]).toEqual(expected);
  });

  it("does not retry JSON POST requests by default", async () => {
    guardedFetch.mockReset();
    guardedFetch.mockRejectedValueOnce(
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    );
    queueGuardedResponse(new Response(null, { status: 200 }));

    await expect(postJsonRequest(postOptions())).rejects.toThrow("socket hang up");

    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it("retries read JSON POST transient HTTP responses", async () => {
    guardedFetch.mockReset();
    const firstRelease = queueGuardedResponse(busyResponse());
    const secondRelease = queueGuardedResponse(new Response(null, { status: 200 }));
    const sleep = vi.fn(async () => undefined);

    const result = await postJsonRequest({
      ...postOptions(),
      retryStage: "read",
      retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
    });

    expect(result.response.status).toBe(200);
    expect(guardedFetch).toHaveBeenCalledTimes(2);
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(secondRelease).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledWith(0, undefined);
  });

  it("does not auto-upgrade when caller passes explicit dispatcherPolicy", async () => {
    // Auto-upgrade would discard the caller's explicit dispatcher overrides.
    usesProxy.mockReturnValue(true);

    const explicitPolicy = {
      mode: "explicit-proxy" as const,
      proxyUrl: "http://corp-proxy.internal:3128",
    };

    await fetchWithTimeoutGuarded("https://api.example.com/v1/image", {}, undefined, fetch, {
      dispatcherPolicy: explicitPolicy,
    });

    const call = getFirstGuardedFetchCall();
    expect(call).not.toHaveProperty("mode");
    expect(call).toHaveProperty("dispatcherPolicy", explicitPolicy);
  });
});
