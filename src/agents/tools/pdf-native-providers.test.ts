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

const TEST_PDF_INPUT = { base64: "dGVzdA==", filename: "doc.pdf" } as const;

function makeAnthropicAnalyzeParams(
  overrides: Partial<{
    apiKey: string;
    modelId: string;
    prompt: string;
    pdfs: Array<{ base64: string; filename: string }>;
    maxTokens: number;
    signal: AbortSignal;
    baseUrl: string;
    requestConfig: Parameters<typeof pdfNativeProviders.anthropicAnalyzePdf>[0]["requestConfig"];
  }> = {},
) {
  return {
    apiKey: "test-key",
    modelId: "claude-opus-4-6",
    prompt: "test",
    pdfs: [TEST_PDF_INPUT],
    ...overrides,
  };
}

function makeGeminiAnalyzeParams(
  overrides: Partial<{
    apiKey: string;
    modelId: string;
    prompt: string;
    pdfs: Array<{ base64: string; filename: string }>;
    baseUrl: string;
    requestConfig: Parameters<typeof pdfNativeProviders.geminiAnalyzePdf>[0]["requestConfig"];
    signal: AbortSignal;
  }> = {},
) {
  return {
    apiKey: "test-key",
    modelId: "gemini-2.5-pro",
    prompt: "test",
    pdfs: [TEST_PDF_INPUT],
    ...overrides,
  };
}

describe("native PDF provider API calls", () => {
  const priorFetch = global.fetch;

  const jsonResponse = (payload: unknown, init?: ResponseInit): Response =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
      ...init,
    });

  const textResponse = (body: string, init?: ResponseInit): Response => new Response(body, init);

  const mockFetchResponse = (response: Response, onFetch?: (init?: RequestInit) => void) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      onFetch?.(init);
      return response;
    });
    global.fetch = Object.assign(fetchMock, { preconnect: vi.fn() }) as typeof global.fetch;
    return fetchMock;
  };

  const firstFetchCall = (fetchMock: { mock: { calls: unknown[][] } }): unknown[] => {
    const call = fetchMock.mock.calls.at(0);
    if (!call) {
      throw new Error("expected fetch to be called");
    }
    return call;
  };

  const captureError = async (promise: Promise<unknown>, label: string): Promise<Error> => {
    const error = await promise.catch((caught: unknown) => caught);
    if (!(error instanceof Error)) {
      throw new Error(`expected ${label} to throw an Error`);
    }
    return error;
  };

  afterEach(() => {
    global.fetch = priorFetch;
    vi.unstubAllEnvs();
  });

  it("anthropicAnalyzePdf sends correct request shape", async () => {
    const parent = new AbortController();
    let abortedAtFetch: boolean | undefined;
    const fetchMock = mockFetchResponse(
      jsonResponse({
        content: [{ type: "text", text: "Analysis of PDF" }],
      }),
      (init) => {
        abortedAtFetch = init?.signal?.aborted;
      },
    );

    const result = await pdfNativeProviders.anthropicAnalyzePdf(
      makeAnthropicAnalyzeParams({
        modelId: "claude-opus-4-6",
        prompt: "Summarize these documents",
        pdfs: [
          { base64: "cGRmMQ==", filename: "doc1.pdf" },
          { base64: "cGRmMg==", filename: "doc2.pdf" },
        ],
        maxTokens: 4096,
        signal: parent.signal,
      }),
    );

    expect(result).toBe("Analysis of PDF");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = firstFetchCall(fetchMock) as [
      string,
      { body: string; headers: Headers; signal: AbortSignal },
    ];
    expect(url).toContain("/v1/messages");
    expect(opts.headers.get("x-api-key")).toBe("test-key");
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(abortedAtFetch).toBe(false);
    expect(opts.signal.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("claude-opus-4-6");
    expect(body.messages[0].content).toHaveLength(3);
    expect(body.messages[0].content[0].type).toBe("document");
    expect(body.messages[0].content[0].source.media_type).toBe("application/pdf");
    expect(body.messages[0].content[1].type).toBe("document");
    expect(body.messages[0].content[2].type).toBe("text");
  });

  it("unwraps sentinel-backed native PDF headers only at the request handoff", async () => {
    const apiKey = mintSecretSentinel("native-pdf-api-secret", {
      label: "model-auth:anthropic",
    });
    const managedHeader = mintSecretSentinel("native-pdf-managed-secret", {
      label: "model-auth:anthropic",
    });
    const fetchMock = mockFetchResponse(
      jsonResponse({ content: [{ type: "text", text: "Analysis" }] }),
    );

    await pdfNativeProviders.anthropicAnalyzePdf(
      makeAnthropicAnalyzeParams({
        apiKey,
        requestConfig: { headers: { "X-Managed": `Bearer ${managedHeader}` } },
      }),
    );

    const [, opts] = firstFetchCall(fetchMock) as [string, { headers: Headers }];
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
      pdfNativeProviders
        .anthropicAnalyzePdf(makeAnthropicAnalyzeParams())
        .catch((caught: unknown) => caught),
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
    mockFetchResponse(textResponse("", { status: 401, statusText: "reflected token=abc" }));

    const error = await captureError(
      pdfNativeProviders.anthropicAnalyzePdf(
        makeAnthropicAnalyzeParams({
          requestConfig: { headers: { Authorization: "bearer abc" } },
        }),
      ),
      "Anthropic PDF request",
    );
    const fetchMock = global.fetch as unknown as { mock: { calls: unknown[][] } };
    const [, opts] = firstFetchCall(fetchMock) as [string, { headers: Headers }];
    expect(opts.headers.get("Authorization")).toBe("bearer abc");
    expect(error.message).not.toContain("abc");
    expect(error.message).toContain("Anthropic PDF request failed (401 reflected token=***)");
  });

  it("masks a reflected custom request-auth credential and preserves its prefix", async () => {
    mockFetchResponse(
      textResponse("upstream echoed Token-abc123 and fallback-key", { status: 401 }),
    );

    const error = await captureError(
      pdfNativeProviders.geminiAnalyzePdf(
        makeGeminiAnalyzeParams({
          apiKey: "fallback-key",
          requestConfig: {
            request: {
              auth: {
                mode: "header",
                headerName: "X-Corp-Credential",
                value: "abc123",
                prefix: "Token-",
              },
            },
          },
        }),
      ),
      "Gemini PDF request",
    );
    const fetchMock = global.fetch as unknown as { mock: { calls: unknown[][] } };
    const [, opts] = firstFetchCall(fetchMock) as [string, { headers: Headers }];
    expect(opts.headers.get("X-Corp-Credential")).toBe("Token-abc123");
    expect(error.message).not.toContain("abc123");
    expect(error.message).not.toContain("fallback-key");
    expect(error.message).toContain("Token-***");
  });

  it.each([
    {
      name: "byte cutoff",
      credential: "a".repeat(7_900),
      body: `${"x".repeat(390)} Token-${"a".repeat(7_900)}`,
    },
  ])("masks a reflected custom credential crossing the $name", async ({ credential, body }) => {
    mockFetchResponse(textResponse(body, { status: 401 }));

    const error = await captureError(
      pdfNativeProviders.geminiAnalyzePdf(
        makeGeminiAnalyzeParams({
          requestConfig: {
            request: {
              auth: {
                mode: "header",
                headerName: "X-Corp-Credential",
                value: credential,
                prefix: "Token-",
              },
            },
          },
        }),
      ),
      "Gemini PDF request",
    );
    const fetchMock = global.fetch as unknown as { mock: { calls: unknown[][] } };
    const [, opts] = firstFetchCall(fetchMock) as [string, { headers: Headers }];
    expect(opts.headers.get("X-Corp-Credential")).toBe(`Token-${credential}`);
    expect(error.message).not.toContain("Token-a");
    expect(error.message).not.toContain("Token-custom");
    expect(error.message).toContain("Token-***");
  });

  it("anthropicAnalyzePdf throws when response has no text", async () => {
    mockFetchResponse(
      jsonResponse({
        content: [{ type: "text", text: "   " }],
      }),
    );

    await expect(
      pdfNativeProviders.anthropicAnalyzePdf(makeAnthropicAnalyzeParams()),
    ).rejects.toThrow("Anthropic PDF returned no text");
  });

  it("anthropicAnalyzePdf honors explicit private-network denial for a configured local origin", async () => {
    const fetchMock = mockFetchResponse(
      jsonResponse({
        content: [{ type: "text", text: "ok" }],
      }),
    );

    await expect(
      pdfNativeProviders.anthropicAnalyzePdf(
        makeAnthropicAnalyzeParams({
          baseUrl: "http://127.0.0.1:11434",
          requestConfig: {
            request: { allowPrivateNetwork: false },
          },
        }),
      ),
    ).rejects.toThrow(/private|SSRF|blocked/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("anthropicAnalyzePdf does not carry exact-origin trust across redirects", async () => {
    const fetchMock = mockFetchResponse(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:4321/v1/messages" },
      }),
    );

    await expect(
      pdfNativeProviders.anthropicAnalyzePdf(
        makeAnthropicAnalyzeParams({ baseUrl: "http://127.0.0.1:11434" }),
      ),
    ).rejects.toThrow(/private|SSRF|blocked/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("anthropicAnalyzePdf allows off-origin private redirects with explicit opt-in", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:4321/v1/messages" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          content: [{ type: "text", text: "ok" }],
        }),
      );
    global.fetch = Object.assign(fetchMock, { preconnect: vi.fn() }) as typeof global.fetch;

    await expect(
      pdfNativeProviders.anthropicAnalyzePdf(
        makeAnthropicAnalyzeParams({
          baseUrl: "http://127.0.0.1:11434",
          requestConfig: {
            request: { allowPrivateNetwork: true },
          },
        }),
      ),
    ).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("anthropicAnalyzePdf rejects oversized successful JSON responses", async () => {
    mockFetchResponse(
      jsonResponse({
        content: [{ type: "text", text: "x".repeat(17 * 1024 * 1024) }],
      }),
    );

    await expect(
      pdfNativeProviders.anthropicAnalyzePdf(makeAnthropicAnalyzeParams()),
    ).rejects.toThrow("JSON response exceeds");
  });

  it("geminiAnalyzePdf sends correct request shape", async () => {
    // Gemini API keys belong in headers here, not query strings that are more
    // likely to leak through logs and URL diagnostics.
    const parent = new AbortController();
    let abortedAtFetch: boolean | undefined;
    const fetchMock = mockFetchResponse(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "Gemini PDF analysis" }] } }],
      }),
      (init) => {
        abortedAtFetch = init?.signal?.aborted;
      },
    );

    const result = await pdfNativeProviders.geminiAnalyzePdf(
      makeGeminiAnalyzeParams({
        modelId: "gemini-2.5-pro",
        prompt: "Summarize this",
        signal: parent.signal,
      }),
    );

    expect(result).toBe("Gemini PDF analysis");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = firstFetchCall(fetchMock) as [
      string,
      { body: string; headers: Headers; signal: AbortSignal },
    ];
    expect(url).toContain("generateContent");
    expect(url).toContain("gemini-2.5-pro");
    expect(url).not.toContain("?key=");
    expect(opts.headers.get("x-goog-api-key")).toBe("test-key");
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(abortedAtFetch).toBe(false);
    expect(opts.signal.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
    const body = JSON.parse(opts.body);
    expect(body.contents[0].parts).toHaveLength(2);
    expect(body.contents[0].parts[0].inline_data.mime_type).toBe("application/pdf");
    expect(body.contents[0].parts[1].text).toBe("Summarize this");
  });

  it("geminiAnalyzePdf throws when no candidates returned", async () => {
    mockFetchResponse(jsonResponse({ candidates: [] }));

    await expect(pdfNativeProviders.geminiAnalyzePdf(makeGeminiAnalyzeParams())).rejects.toThrow(
      "Gemini PDF returned no candidates",
    );
  });

  it("anthropicAnalyzePdf uses custom base URL", async () => {
    const fetchMock = mockFetchResponse(
      jsonResponse({
        content: [{ type: "text", text: "ok" }],
      }),
    );

    await pdfNativeProviders.anthropicAnalyzePdf(
      makeAnthropicAnalyzeParams({ baseUrl: "https://custom.example.com" }),
    );

    expect(firstFetchCall(fetchMock)[0]).toContain("https://custom.example.com/v1/messages");
  });

  it("anthropicAnalyzePdf requires apiKey", async () => {
    await expect(
      pdfNativeProviders.anthropicAnalyzePdf(makeAnthropicAnalyzeParams({ apiKey: "" })),
    ).rejects.toThrow("apiKey required");
  });

  it("geminiAnalyzePdf requires apiKey", async () => {
    await expect(
      pdfNativeProviders.geminiAnalyzePdf(makeGeminiAnalyzeParams({ apiKey: "" })),
    ).rejects.toThrow("apiKey required");
  });
});
