import { afterEach, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { mintSecretSentinel } from "../../secrets/sentinel.js";
import type { ModelProviderRequestTransportOverrides } from "../provider-request-config.types.js";
import * as pdfNativeProviders from "./pdf-native-providers.js";

// mock-isolation: native PDF tests bypass plugin loading; only Google URL normalization is used.
vi.mock("../../plugins/provider-runtime.js", () => ({
  normalizeProviderTransportWithPlugin: (params: { context?: { baseUrl?: string } }) =>
    params.context?.baseUrl ? { baseUrl: params.context.baseUrl } : undefined,
}));

type AnalyzeParams = Parameters<typeof pdfNativeProviders.anthropicAnalyzePdf>[0];
function makeAnthropicAnalyzeParams(overrides: Partial<AnalyzeParams> = {}) {
  return {
    apiKey: "test-key",
    modelId: "claude-opus-4-6",
    prompt: "test",
    pdfs: [{ base64: "dGVzdA==" }],
    ...overrides,
  };
}

function analyzeAnthropic(overrides: Partial<AnalyzeParams> = {}) {
  return pdfNativeProviders.anthropicAnalyzePdf(makeAnthropicAnalyzeParams(overrides));
}
function analyzeGemini(overrides: Partial<AnalyzeParams> = {}) {
  return pdfNativeProviders.geminiAnalyzePdf(
    makeAnthropicAnalyzeParams({ modelId: "gemini-2.5-pro", ...overrides }),
  );
}

const priorFetch = global.fetch;

const anthropicResponse = (text = "ok") => Response.json({ content: [{ type: "text", text }] });
const customAuth = (value: string) => ({
  request: {
    auth: { mode: "header" as const, headerName: "X-Corp-Credential", value, prefix: "Token-" },
  },
});

const mockFetchResponse = (response: Response, onFetch?: (init?: RequestInit) => void) => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    onFetch?.(init);
    return response;
  });
  global.fetch = Object.assign(fetchMock, { preconnect: vi.fn() }) as typeof global.fetch;
  return fetchMock;
};

const firstFetchCall = (fetchMock: { mock: { calls: unknown[][] } }) => {
  const call = fetchMock.mock.calls.at(0);
  if (!call) {
    throw new Error("expected fetch to be called");
  }
  return call as [string, { body: string; headers: Headers; signal: AbortSignal }];
};

const expectReleasedRequest = (
  fetchMock: { mock: { calls: unknown[][] } },
  parent: AbortController,
  abortedAtFetch: boolean | undefined,
) => {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const call = firstFetchCall(fetchMock);
  expect(call[1].signal).toBeInstanceOf(AbortSignal);
  expect(abortedAtFetch).toBe(false);
  expect(call[1].signal.aborted).toBe(true);
  expect(parent.signal.aborted).toBe(false);
  return call;
};

const captureError = async (promise: Promise<unknown>): Promise<Error> => {
  const error = await promise.catch((caught: unknown) => caught);
  if (!(error instanceof Error)) {
    throw new Error("expected PDF request to throw an Error");
  }
  return error;
};

afterEach(() => {
  global.fetch = priorFetch;
});

it.each(["Anthropic", "Gemini"])(
  "%s sends PDF parts and releases only its own signal",
  async (provider) => {
    const anthropic = provider === "Anthropic";
    const parent = new AbortController();
    let abortedAtFetch: boolean | undefined;
    const response = anthropic
      ? anthropicResponse("Analysis of PDF")
      : Response.json({
          candidates: [{ content: { parts: [{ text: "Gemini PDF analysis" }] } }],
        });
    const fetchMock = mockFetchResponse(response, (init) => {
      abortedAtFetch = init?.signal?.aborted;
    });
    const analyze = anthropic ? analyzeAnthropic : analyzeGemini;
    const result = await analyze({
      baseUrl: anthropic ? "https://custom.example.com" : undefined,
      prompt: anthropic ? "Summarize these documents" : "Summarize this",
      ...(anthropic
        ? { pdfs: [{ base64: "cGRmMQ==" }, { base64: "cGRmMg==" }], maxTokens: 4096 }
        : {}),
      signal: parent.signal,
    });
    expect(result).toBe(anthropic ? "Analysis of PDF" : "Gemini PDF analysis");
    const [url, opts] = expectReleasedRequest(fetchMock, parent, abortedAtFetch);
    expect(opts.headers.get(anthropic ? "x-api-key" : "x-goog-api-key")).toBe("test-key");
    const body = JSON.parse(opts.body);
    if (anthropic) {
      expect(url).toContain("https://custom.example.com/v1/messages");
      expect(body).toMatchObject({ model: "claude-opus-4-6" });
      expect(body.messages[0].content).toMatchObject([
        { type: "document", source: { media_type: "application/pdf" } },
        { type: "document" },
        { type: "text" },
      ]);
    } else {
      expect(url).toContain("generateContent");
      expect(url).toContain("gemini-2.5-pro");
      expect(url).not.toContain("?key=");
      expect(body.contents[0].parts).toMatchObject([
        { inline_data: { mime_type: "application/pdf" } },
        { text: "Summarize this" },
      ]);
    }
  },
);

it.each([false, true])(
  "unwraps sentinel-backed native PDF credentials (OAuth=%s)",
  async (oauth) => {
    const credential = oauth ? "sk-ant-oat01-fixture-token" : "native-pdf-api-secret";
    const apiKey = mintSecretSentinel(credential, { label: "model-auth:anthropic" });
    const managedHeader = mintSecretSentinel("native-pdf-managed-secret", {
      label: "model-auth:anthropic",
    });
    const fetchMock = mockFetchResponse(anthropicResponse("Analysis"));
    await analyzeAnthropic({
      apiKey,
      requestConfig: { headers: { "X-Managed": `Bearer ${managedHeader}` } },
    });
    const [, opts] = firstFetchCall(fetchMock);
    expect(opts.headers.get("x-api-key")).toBe(oauth ? null : credential);
    expect(opts.headers.get("authorization")).toBe(oauth ? `Bearer ${credential}` : null);
    expect(opts.headers.get("X-Managed")).toBe("Bearer native-pdf-managed-secret");
  },
);

it.each<ModelProviderRequestTransportOverrides>([
  { auth: { mode: "header", headerName: "x-api-key", value: "fixture-override" } },
  { headers: { "X-Api-Key": "fixture-override" } },
  {
    headers: { Authorization: "Bearer stale-fixture" },
    auth: { mode: "authorization-bearer", token: "fixture-override" },
  },
])("preserves explicit native PDF authentication: %j", async (request) => {
  const fetchMock = mockFetchResponse(anthropicResponse());
  await analyzeAnthropic({ apiKey: "sk-ant-oat01-fixture-token", requestConfig: { request } });
  const headers = firstFetchCall(fetchMock)[1].headers;
  const bearer = request.auth?.mode === "authorization-bearer";
  expect(headers.get("authorization")).toBe(bearer ? "Bearer fixture-override" : null);
  expect(headers.get("x-api-key")).toBe(bearer ? null : "fixture-override");
  expect(headers.get("anthropic-beta")).toBe("pdfs-2024-09-25");
  expect(headers.has("x-app")).toBe(false);
});

it("cancels Anthropic API error bodies that exactly fill the byte cap", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(8 * 1024)));
    },
    cancel() {
      canceled = true;
    },
  });
  mockFetchResponse(
    new Response(body, {
      status: 400,
      statusText: "Bad Request",
    }),
  );

  const error = await withTestTimeout(
    captureError(analyzeAnthropic()),
    500,
    "timed out waiting for bounded error body",
  );

  expect(error.message).toContain("Anthropic PDF request failed");
  expect(error.message.length).toBeLessThan(500);
  expect(canceled).toBe(true);
});

it("masks a short Bearer credential actually sent through extra headers", async () => {
  const fetchMock = mockFetchResponse(
    new Response("", { status: 401, statusText: "reflected token=abc" }),
  );

  const error = await captureError(
    analyzeAnthropic({
      requestConfig: { headers: { Authorization: "bearer abc" } },
    }),
  );
  const [, opts] = firstFetchCall(fetchMock);
  expect(opts.headers.get("Authorization")).toBe("bearer abc");
  expect(error.message).not.toContain("abc");
  expect(error.message).toContain("Anthropic PDF request failed (401 reflected token=***)");
});

it.each([false, true])("redacts custom request auth (crosses byte cap=%s)", async (cutoff) => {
  const credential = cutoff ? "a".repeat(7_900) : "abc123";
  const body = cutoff
    ? `${"x".repeat(390)} Token-${credential}`
    : "upstream echoed Token-abc123 and fallback-key";
  const fetchMock = mockFetchResponse(new Response(body, { status: 401 }));
  const error = await captureError(
    analyzeGemini({
      ...(cutoff ? {} : { apiKey: "fallback-key" }),
      requestConfig: customAuth(credential),
    }),
  );
  expect(firstFetchCall(fetchMock)[1].headers.get("X-Corp-Credential")).toBe(`Token-${credential}`);
  for (const secret of cutoff ? ["Token-a", "Token-custom"] : ["abc123", "fallback-key"]) {
    expect(error.message).not.toContain(secret);
  }
  expect(error.message).toContain("***");
  expect(error.message).not.toContain("Token-");
});

it.each([
  { name: "explicit private-network denial", redirect: false, allow: false, calls: 0 },
  {
    name: "exact-origin trust does not cross redirects",
    redirect: true,
    allow: undefined,
    calls: 1,
  },
  { name: "explicit private redirect opt-in", redirect: true, allow: true, calls: 2 },
])("$name", async ({ redirect, allow, calls }) => {
  const response = redirect
    ? new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:4321/v1/messages" },
      })
    : anthropicResponse();
  const fetchMock = mockFetchResponse(response);
  if (allow) {
    fetchMock.mockResolvedValueOnce(response).mockResolvedValueOnce(anthropicResponse());
  }
  const request = analyzeAnthropic({
    baseUrl: "http://127.0.0.1:11434",
    ...(allow === undefined ? {} : { requestConfig: { request: { allowPrivateNetwork: allow } } }),
  });
  if (allow) {
    await expect(request).resolves.toBe("ok");
  } else {
    await expect(request).rejects.toThrow(/private|SSRF|blocked/i);
  }
  expect(fetchMock).toHaveBeenCalledTimes(calls);
});

it.each([
  [analyzeAnthropic, () => anthropicResponse("   "), "Anthropic PDF returned no text"],
  [
    analyzeAnthropic,
    () => anthropicResponse("x".repeat(17 * 1024 * 1024)),
    "JSON response exceeds",
  ],
  [analyzeGemini, () => Response.json({ candidates: [] }), "Gemini PDF returned no candidates"],
] as const)(
  "rejects invalid successful responses: %s / %s / %s",
  async (analyze, response, error) => {
    mockFetchResponse(response());
    await expect(analyze()).rejects.toThrow(error);
  },
);

it.each([analyzeAnthropic, analyzeGemini])("%s requires apiKey", async (analyze) => {
  await expect(analyze({ apiKey: "" })).rejects.toThrow("apiKey required");
});
