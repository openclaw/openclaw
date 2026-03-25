import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeminiEmbeddingClient } from "./embeddings-gemini.js";

vi.mock("./remote-http.js", () => ({
  withRemoteHttpResponse: vi.fn(),
}));

function magnitude(values: number[]) {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
}

describe("runGeminiEmbeddingBatches", () => {
  let runGeminiEmbeddingBatches: typeof import("./batch-gemini.js").runGeminiEmbeddingBatches;
  let withRemoteHttpResponse: typeof import("./remote-http.js").withRemoteHttpResponse;
  let remoteHttpMock: ReturnType<typeof vi.mocked<typeof withRemoteHttpResponse>>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({ runGeminiEmbeddingBatches } = await import("./batch-gemini.js"));
    ({ withRemoteHttpResponse } = await import("./remote-http.js"));
    remoteHttpMock = vi.mocked(withRemoteHttpResponse);
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  const mockClient: GeminiEmbeddingClient = {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    headers: {},
    model: "gemini-embedding-2-preview",
    modelPath: "models/gemini-embedding-2-preview",
    apiKeys: ["test-key"],
    outputDimensionality: 1536,
  };

  it("includes outputDimensionality in batch upload requests", async () => {
    remoteHttpMock.mockImplementationOnce(async (params) => {
      expect(params.url).toContain("/upload/v1beta/files?uploadType=multipart");
      const body = params.init?.body;
      if (!(body instanceof Blob)) {
        throw new Error("expected multipart blob body");
      }
      const text = await body.text();
      expect(text).toContain('"taskType":"RETRIEVAL_DOCUMENT"');
      expect(text).toContain('"outputDimensionality":1536');
      return await params.onResponse(
        new Response(JSON.stringify({ name: "files/file-123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    remoteHttpMock.mockImplementationOnce(async (params) => {
      expect(params.url).toMatch(/:asyncBatchEmbedContent$/u);
      return await params.onResponse(
        new Response(
          JSON.stringify({
            name: "batches/batch-1",
            state: "COMPLETED",
            outputConfig: { file: "files/output-1" },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    });
    remoteHttpMock.mockImplementationOnce(async (params) => {
      expect(params.url).toMatch(/\/files\/output-1:download$/u);
      return await params.onResponse(
        new Response(
          JSON.stringify({
            key: "req-1",
            response: { embedding: { values: [3, 4] } },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/jsonl" },
          },
        ),
      );
    });

    const results = await runGeminiEmbeddingBatches({
      gemini: mockClient,
      agentId: "main",
      requests: [
        {
          custom_id: "req-1",
          request: {
            content: { parts: [{ text: "hello world" }] },
            taskType: "RETRIEVAL_DOCUMENT",
            outputDimensionality: 1536,
          },
        },
      ],
      wait: true,
      pollIntervalMs: 1,
      timeoutMs: 1000,
      concurrency: 1,
    });

    const embedding = results.get("req-1");
    expect(embedding).toBeDefined();
    expect(embedding?.[0]).toBeCloseTo(0.6, 5);
    expect(embedding?.[1]).toBeCloseTo(0.8, 5);
    expect(magnitude(embedding ?? [])).toBeCloseTo(1, 5);
    expect(remoteHttpMock).toHaveBeenCalledTimes(3);
  });
});
