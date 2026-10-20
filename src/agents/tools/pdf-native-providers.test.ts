// Native PDF provider tests cover direct Anthropic and Gemini request shapes,
// base URL handling, and bounded API error reporting.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { mintSecretSentinel } from "../../secrets/sentinel.js";
import * as pdfNativeProviders from "./pdf-native-providers.js";

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

describe("native PDF provider API calls", () => {
  const priorFetch = global.fetch;

  const jsonResponse = (payload: unknown, init?: ResponseInit) => Response.json(payload, init);

  const textResponse = (body: string, init?: ResponseInit): Response => new Response(body, init);
  const anthropicResponse = (text = "ok") => jsonResponse({ content: [{ type: "text", text }] });
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
    vi.unstubAllEnvs();
  });

  it.each(["Anthropic", "Gemini"])(
    "%s sends PDF parts and releases only its own signal",
    async (provider) => {
      const anthropic = provider === "Anthropic";
      const parent = new AbortController();
      let abortedAtFetch: boolean | undefined;
      const response = anthropic
        ? anthropicResponse("Analysis of PDF")
        : jsonResponse({ candidates: [{ content: { parts: [{ text: "Gemini PDF analysis" }] } }] });
      const fetchMock = mockFetchResponse(response, (init) => {
        abortedAtFetch = init?.signal?.aborted;
      });
      const analyze = anthropic ? analyzeAnthropic : analyzeGemini;
      const result = await analyze({
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
        expect(url).toContain("/v1/messages");
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

  it("unwraps sentinel-backed native PDF headers only at the request handoff", async () => {
    const apiKey = mintSecretSentinel("native-pdf-api-secret", {
      label: "model-auth:anthropic",
    });
    const managedHeader = mintSecretSentinel("native-pdf-managed-secret", {
      label: "model-auth:anthropic",
    });
    const fetchMock = mockFetchResponse(anthropicResponse("Analysis"));

    await analyzeAnthropic({
      apiKey,
      requestConfig: { headers: { "X-Managed": `Bearer ${managedHeader}` } },
    });

    const [, opts] = firstFetchCall(fetchMock);
    expect(opts.headers.get("x-api-key")).toBe("native-pdf-api-secret");
    expect(opts.headers.get("X-Managed")).toBe("Bearer native-pdf-managed-secret");
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
      analyzeAnthropic().catch((caught: unknown) => caught),
      500,
      "timed out waiting for bounded error body",
    );

    if (!(error instanceof Error)) {
      throw new Error("expected Anthropic PDF request to throw an Error");
    }
    expect(error.message).toContain("Anthropic PDF request failed");
    expect(error.message.length).toBeLessThan(500);
    expect(canceled).toBe(true);
  });

  it("masks a short Bearer credential actually sent through extra headers", async () => {
    const fetchMock = mockFetchResponse(
      textResponse("", { status: 401, statusText: "reflected token=abc" }),
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

  it("masks a reflected custom request-auth header and credential", async () => {
    const fetchMock = mockFetchResponse(
      textResponse("upstream echoed Token-abc123 and fallback-key", { status: 401 }),
    );

    const error = await captureError(
      analyzeGemini({
        apiKey: "fallback-key",
        requestConfig: customAuth("abc123"),
      }),
    );
    const [, opts] = firstFetchCall(fetchMock);
    expect(opts.headers.get("X-Corp-Credential")).toBe("Token-abc123");
    expect(error.message).not.toContain("abc123");
    expect(error.message).not.toContain("fallback-key");
    expect(error.message).toContain("***");
    expect(error.message).not.toContain("Token-");
  });

  it("masks a reflected custom credential crossing the byte cutoff", async () => {
    const credential = "a".repeat(7_900);
    const fetchMock = mockFetchResponse(
      textResponse(`${"x".repeat(390)} Token-${credential}`, { status: 401 }),
    );

    const error = await captureError(
      analyzeGemini({
        requestConfig: customAuth(credential),
      }),
    );
    const [, opts] = firstFetchCall(fetchMock);
    expect(opts.headers.get("X-Corp-Credential")).toBe(`Token-${credential}`);
    expect(error.message).not.toContain("Token-a");
    expect(error.message).not.toContain("Token-custom");
    expect(error.message).toContain("***");
    expect(error.message).not.toContain("Token-");
  });

  it("anthropicAnalyzePdf throws when response has no text", async () => {
    mockFetchResponse(anthropicResponse("   "));

    await expect(analyzeAnthropic()).rejects.toThrow("Anthropic PDF returned no text");
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
      ...(allow === undefined
        ? {}
        : { requestConfig: { request: { allowPrivateNetwork: allow } } }),
    });
    if (allow) {
      await expect(request).resolves.toBe("ok");
    } else {
      await expect(request).rejects.toThrow(/private|SSRF|blocked/i);
    }
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it("anthropicAnalyzePdf rejects oversized successful JSON responses", async () => {
    mockFetchResponse(anthropicResponse("x".repeat(17 * 1024 * 1024)));

    await expect(analyzeAnthropic()).rejects.toThrow("JSON response exceeds");
  });

  it("geminiAnalyzePdf throws when no candidates returned", async () => {
    mockFetchResponse(jsonResponse({ candidates: [] }));

    await expect(analyzeGemini()).rejects.toThrow("Gemini PDF returned no candidates");
  });

  it("anthropicAnalyzePdf uses custom base URL", async () => {
    const fetchMock = mockFetchResponse(anthropicResponse());

    await analyzeAnthropic({ baseUrl: "https://custom.example.com" });

    expect(firstFetchCall(fetchMock)[0]).toContain("https://custom.example.com/v1/messages");
  });

  it.each([analyzeAnthropic, analyzeGemini])("%s requires apiKey", async (analyze) => {
    await expect(analyze({ apiKey: "" })).rejects.toThrow("apiKey required");
  });
});
