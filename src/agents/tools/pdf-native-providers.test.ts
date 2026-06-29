// Native PDF provider tests cover direct Anthropic and Gemini request shapes,
// base URL handling, bounded API error reporting, and the 16 MiB response-size
// guard added to prevent OOM on oversized AI provider responses.
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    baseUrl: string;
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

  const mockFetchResponse = (response: unknown) => {
    const fetchMock = vi.fn().mockResolvedValue(response);
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

  const withTimeout = async <T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(message));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  };

  afterEach(() => {
    global.fetch = priorFetch;
    vi.unstubAllEnvs();
  });

  it("anthropicAnalyzePdf sends correct request shape", async () => {
    const fetchMock = mockFetchResponse(
      new Response(JSON.stringify({ content: [{ type: "text", text: "Analysis of PDF" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await pdfNativeProviders.anthropicAnalyzePdf(
      makeAnthropicAnalyzeParams({
        modelId: "claude-opus-4-6",
        prompt: "Summarize this document",
        maxTokens: 4096,
      }),
    );

    expect(result).toBe("Analysis of PDF");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = firstFetchCall(fetchMock) as [
      string,
      { body: string; signal: AbortSignal },
    ];
    expect(url).toContain("/v1/messages");
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.signal.aborted).toBe(false);
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("claude-opus-4-6");
    expect(body.messages[0].content).toHaveLength(2);
    expect(body.messages[0].content[0].type).toBe("document");
    expect(body.messages[0].content[0].source.media_type).toBe("application/pdf");
    expect(body.messages[0].content[1].type).toBe("text");
  });

  it("anthropicAnalyzePdf honors ANTHROPIC_BASE_URL when no base URL is configured", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://anthropic-pdf-proxy.example/v1");
    const fetchMock = mockFetchResponse(
      new Response(JSON.stringify({ content: [{ type: "text", text: "Analysis of PDF" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await pdfNativeProviders.anthropicAnalyzePdf(makeAnthropicAnalyzeParams());

    const [url] = firstFetchCall(fetchMock) as [string];
    expect(url).toBe("https://anthropic-pdf-proxy.example/v1/messages");
  });

  it("anthropicAnalyzePdf throws on API error", async () => {
    mockFetchResponse({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => "invalid request",
    });

    await expect(
      pdfNativeProviders.anthropicAnalyzePdf(makeAnthropicAnalyzeParams()),
    ).rejects.toThrow("Anthropic PDF request failed");
  });

  it("bounds large Anthropic API error bodies", async () => {
    // Provider errors can contain large or sensitive payloads; surface a compact
    // diagnostic and cancel the stream once the cap is reached.
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${"x".repeat(9_000)}tail-marker`));
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

    const error = await pdfNativeProviders
      .anthropicAnalyzePdf(makeAnthropicAnalyzeParams())
      .catch((caught: unknown) => caught);

    if (!(error instanceof Error)) {
      throw new Error("expected Anthropic PDF request to throw an Error");
    }
    expect(error.message).toContain("Anthropic PDF request failed");
    expect(error.message).not.toContain("tail-marker");
    expect(error.message.length).toBeLessThan(500);
    expect(canceled).toBe(true);
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

    const error = await withTimeout(
      pdfNativeProviders
        .anthropicAnalyzePdf(makeAnthropicAnalyzeParams())
        .catch((caught: unknown) => caught),
      2_000,
      "timed out waiting for bounded error body",
    );

    if (!(error instanceof Error)) {
      throw new Error("expected Anthropic PDF request to throw an Error");
    }
    expect(error.message).toContain("Anthropic PDF request failed");
    expect(canceled).toBe(true);
  });

  it("anthropicAnalyzePdf throws when response has no text", async () => {
    mockFetchResponse(
      new Response(JSON.stringify({ content: [{ type: "text", text: "   " }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      pdfNativeProviders.anthropicAnalyzePdf(makeAnthropicAnalyzeParams()),
    ).rejects.toThrow("Anthropic PDF returned no text");
  });

  it("geminiAnalyzePdf sends correct request shape", async () => {
    // Gemini API keys belong in headers here, not query strings that are more
    // likely to leak through logs and URL diagnostics.
    const fetchMock = mockFetchResponse(
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "Gemini PDF analysis" }] } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await pdfNativeProviders.geminiAnalyzePdf(
      makeGeminiAnalyzeParams({
        modelId: "gemini-2.5-pro",
        prompt: "Summarize this",
      }),
    );

    expect(result).toBe("Gemini PDF analysis");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = firstFetchCall(fetchMock) as [
      string,
      { body: string; headers: Record<string, string>; signal: AbortSignal },
    ];
    expect(url).toContain("generateContent");
    expect(url).toContain("gemini-2.5-pro");
    expect(url).not.toContain("?key=");
    expect(opts.headers["x-goog-api-key"]).toBe("test-key");
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.signal.aborted).toBe(false);
    const body = JSON.parse(opts.body);
    expect(body.contents[0].parts).toHaveLength(2);
    expect(body.contents[0].parts[0].inline_data.mime_type).toBe("application/pdf");
    expect(body.contents[0].parts[1].text).toBe("Summarize this");
  });

  it("geminiAnalyzePdf throws on API error", async () => {
    mockFetchResponse({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "server error",
    });

    await expect(pdfNativeProviders.geminiAnalyzePdf(makeGeminiAnalyzeParams())).rejects.toThrow(
      "Gemini PDF request failed",
    );
  });

  it("geminiAnalyzePdf throws when no candidates returned", async () => {
    mockFetchResponse(
      new Response(JSON.stringify({ candidates: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(pdfNativeProviders.geminiAnalyzePdf(makeGeminiAnalyzeParams())).rejects.toThrow(
      "Gemini PDF returned no candidates",
    );
  });

  it("anthropicAnalyzePdf supports multiple PDFs", async () => {
    const fetchMock = mockFetchResponse(
      new Response(JSON.stringify({ content: [{ type: "text", text: "Multi-doc analysis" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await pdfNativeProviders.anthropicAnalyzePdf(
      makeAnthropicAnalyzeParams({
        modelId: "claude-opus-4-6",
        prompt: "Compare these documents",
        pdfs: [
          { base64: "cGRmMQ==", filename: "doc1.pdf" },
          { base64: "cGRmMg==", filename: "doc2.pdf" },
        ],
      }),
    );

    const [, opts] = firstFetchCall(fetchMock) as [unknown, { body: string }];
    const body = JSON.parse(opts.body);
    expect(body.messages[0].content).toHaveLength(3);
    expect(body.messages[0].content[0].type).toBe("document");
    expect(body.messages[0].content[1].type).toBe("document");
    expect(body.messages[0].content[2].type).toBe("text");
  });

  it("anthropicAnalyzePdf uses custom base URL", async () => {
    const fetchMock = mockFetchResponse(
      new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
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

  it("geminiAnalyzePdf does not duplicate /v1beta when baseUrl already includes it", async () => {
    const fetchMock = mockFetchResponse(
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await pdfNativeProviders.geminiAnalyzePdf(
      makeGeminiAnalyzeParams({
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      }),
    );

    const [url] = firstFetchCall(fetchMock);
    expect(url).toContain("/v1beta/models/");
    expect(url).not.toContain("/v1beta/v1beta");
  });

  it("geminiAnalyzePdf normalizes bare Google API hosts to a single /v1beta root", async () => {
    const fetchMock = mockFetchResponse(
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await pdfNativeProviders.geminiAnalyzePdf(
      makeGeminiAnalyzeParams({
        baseUrl: "https://generativelanguage.googleapis.com",
      }),
    );

    const [url] = firstFetchCall(fetchMock);
    expect(url).toContain("https://generativelanguage.googleapis.com/v1beta/models/");
    expect(url).not.toContain("/v1beta/v1beta");
  });
});

// ---------------------------------------------------------------------------
// 16 MiB response-size guard — real node:http server (no fetch mock)
// Drives the exported functions end-to-end to prove readProviderJsonResponse
// caps oversized bodies before OOM can occur.
// ---------------------------------------------------------------------------

type ServerHandle = { port: number; stop: () => Promise<void> };

function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        stop: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => {
              if (err) {
                rej(err);
                return;
              }
              res();
            });
          }),
      });
    });
  });
}

/**
 * Returns an HTTP handler that streams 20 MiB of content in 1 MiB chunks.
 * The caller-supplied callback fires once per chunk so tests can confirm the
 * cap fires before all chunks are consumed.
 */
function makeOversizedStreamHandler(
  onChunkWritten: () => void,
): (req: IncomingMessage, res: ServerResponse) => void {
  const CHUNK_SIZE = 1024 * 1024; // 1 MiB
  const TOTAL_CHUNKS = 20; // 20 MiB total — well above the 16 MiB default cap
  const CHUNK = Buffer.alloc(CHUNK_SIZE, 0x61); // fill with 'a'

  return (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    let written = 0;
    let closed = false;
    let pendingWrite: ReturnType<typeof setTimeout> | undefined;

    const clearPendingWrite = () => {
      if (pendingWrite) {
        clearTimeout(pendingWrite);
        pendingWrite = undefined;
      }
    };

    const scheduleNext = () => {
      if (closed || pendingWrite) {
        return;
      }
      pendingWrite = setTimeout(writeNext, 5);
    };

    function writeNext() {
      pendingWrite = undefined;
      if (closed) {
        return;
      }
      if (written >= TOTAL_CHUNKS) {
        res.end();
        return;
      }
      written++;
      onChunkWritten();
      const ok = res.write(CHUNK);
      if (closed) {
        return;
      }
      if (!ok) {
        res.once("drain", scheduleNext);
        return;
      }
      scheduleNext();
    }

    res.on("close", () => {
      closed = true;
      clearPendingWrite();
      res.off("drain", scheduleNext);
    });

    scheduleNext();
  };
}

describe("anthropicAnalyzePdf — 16 MiB response-size guard (real HTTP server)", () => {
  it("returns extracted text for a well-formed response under the cap", async () => {
    const responseBody = JSON.stringify({
      content: [{ type: "text", text: "Summary of the PDF document." }],
    });

    const srv = await startTestServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(responseBody);
    });

    try {
      const result = await pdfNativeProviders.anthropicAnalyzePdf({
        apiKey: "sk-test-placeholder",
        modelId: "claude-3-5-sonnet-20241022",
        prompt: "Summarize",
        pdfs: [{ base64: "dGVzdA==" }],
        baseUrl: `http://127.0.0.1:${srv.port}`,
      });
      expect(result).toBe("Summary of the PDF document.");
    } finally {
      await srv.stop();
    }
  });

  it("rejects oversized AI responses before buffering all 20 MiB (OOM guard)", async () => {
    let chunksWritten = 0;
    const TOTAL_CHUNKS = 20;

    const srv = await startTestServer(
      makeOversizedStreamHandler(() => {
        chunksWritten++;
      }),
    );

    try {
      // Mutation-control: bare `res.json()` would buffer all 20 MiB and then
      // throw a JSON parse error. readProviderJsonResponse throws with this
      // specific message once the 16 MiB cap is crossed.
      await expect(
        pdfNativeProviders.anthropicAnalyzePdf({
          apiKey: "sk-test-placeholder",
          modelId: "claude-3-5-sonnet-20241022",
          prompt: "Summarize",
          pdfs: [{ base64: "dGVzdA==" }],
          baseUrl: `http://127.0.0.1:${srv.port}`,
        }),
      ).rejects.toThrow(/JSON response exceeds/);

      // Negative-control: the cap fires well before the server finishes
      // streaming, proving the body was NOT fully buffered.
      expect(chunksWritten).toBeLessThan(TOTAL_CHUNKS);
    } finally {
      await srv.stop();
    }
  });
});

describe("geminiAnalyzePdf — 16 MiB response-size guard (real HTTP server)", () => {
  it("returns extracted text for a well-formed response under the cap", async () => {
    const responseBody = JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Extracted Gemini PDF text." }] } }],
    });

    const srv = await startTestServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(responseBody);
    });

    try {
      const result = await pdfNativeProviders.geminiAnalyzePdf({
        apiKey: "gai-test-placeholder",
        modelId: "gemini-2.0-flash",
        prompt: "Summarize",
        pdfs: [{ base64: "dGVzdA==" }],
        baseUrl: `http://127.0.0.1:${srv.port}`,
      });
      expect(result).toBe("Extracted Gemini PDF text.");
    } finally {
      await srv.stop();
    }
  });

  it("rejects oversized AI responses before buffering all 20 MiB (OOM guard)", async () => {
    let chunksWritten = 0;
    const TOTAL_CHUNKS = 20;

    const srv = await startTestServer(
      makeOversizedStreamHandler(() => {
        chunksWritten++;
      }),
    );

    try {
      // Mutation-control: bare `res.json()` would buffer all 20 MiB and then
      // throw a JSON parse error. readProviderJsonResponse throws with this
      // specific message once the 16 MiB cap is crossed.
      await expect(
        pdfNativeProviders.geminiAnalyzePdf({
          apiKey: "gai-test-placeholder",
          modelId: "gemini-2.0-flash",
          prompt: "Summarize",
          pdfs: [{ base64: "dGVzdA==" }],
          baseUrl: `http://127.0.0.1:${srv.port}`,
        }),
      ).rejects.toThrow(/JSON response exceeds/);

      // Negative-control: the cap fires well before the server finishes
      // streaming, proving the body was NOT fully buffered.
      expect(chunksWritten).toBeLessThan(TOTAL_CHUNKS);
    } finally {
      await srv.stop();
    }
  });
});
