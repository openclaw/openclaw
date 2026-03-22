import { ReadableStream } from "node:stream/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoyageBatchOutputLine, VoyageBatchRequest } from "./batch-voyage.js";
import type { VoyageEmbeddingClient } from "./embeddings-voyage.js";

// Mock internal.js if needed, but runWithConcurrency is simple enough to keep real.
// We DO need to mock retryAsync to avoid actual delays/retries logic complicating tests
vi.mock("../infra/retry.js", () => ({
  retryAsync: async <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock("./remote-http.js", () => ({
  withRemoteHttpResponse: vi.fn(),
}));

describe("runVoyageEmbeddingBatches", () => {
  let runVoyageEmbeddingBatches: typeof import("./batch-voyage.js").runVoyageEmbeddingBatches;
  let withRemoteHttpResponse: typeof import("./remote-http.js").withRemoteHttpResponse;
  let remoteHttpMock: ReturnType<typeof vi.mocked<typeof withRemoteHttpResponse>>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({ runVoyageEmbeddingBatches } = await import("./batch-voyage.js"));
    ({ withRemoteHttpResponse } = await import("./remote-http.js"));
    remoteHttpMock = vi.mocked(withRemoteHttpResponse);
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  const mockClient: VoyageEmbeddingClient = {
    baseUrl: "https://api.voyageai.com/v1",
    headers: { Authorization: "Bearer test-key" },
    model: "voyage-4-large",
  };

  const mockRequests: VoyageBatchRequest[] = [
    { custom_id: "req-1", body: { input: "text1" } },
    { custom_id: "req-2", body: { input: "text2" } },
  ];

  it("successfully submits batch, waits, and streams results", async () => {
    const outputLines: VoyageBatchOutputLine[] = [
      {
        custom_id: "req-1",
        response: { status_code: 200, body: { data: [{ embedding: [0.1, 0.1] }] } },
      },
      {
        custom_id: "req-2",
        response: { status_code: 200, body: { data: [{ embedding: [0.2, 0.2] }] } },
      },
    ];

    // Create a stream that emits the NDJSON lines
    const stream = new ReadableStream({
      start(controller) {
        const text = outputLines.map((l) => JSON.stringify(l)).join("\n");
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    remoteHttpMock.mockImplementationOnce(async (params) => {
      expect(params.url).toContain("/files");
      const uploadBody = params.init?.body;
      expect(uploadBody).toBeInstanceOf(FormData);
      expect((uploadBody as FormData).get("purpose")).toBe("batch");
      return await params.onResponse(
        new Response(JSON.stringify({ id: "file-123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    remoteHttpMock.mockImplementationOnce(async (params) => {
      expect(params.url).toContain("/batches");
      const body = params.init?.body;
      expect(typeof body).toBe("string");
      const createBody = JSON.parse(body as string) as {
        input_file_id: string;
        completion_window: string;
        request_params: { model: string; input_type: string };
      };
      expect(createBody.input_file_id).toBe("file-123");
      expect(createBody.completion_window).toBe("12h");
      expect(createBody.request_params).toEqual({
        model: "voyage-4-large",
        input_type: "document",
      });
      return await params.onResponse(
        new Response(JSON.stringify({ id: "batch-abc", status: "pending" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    remoteHttpMock.mockImplementationOnce(async (params) => {
      expect(params.url).toContain("/batches/batch-abc");
      return await params.onResponse(
        new Response(
          JSON.stringify({
            id: "batch-abc",
            status: "completed",
            output_file_id: "file-out-999",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    });
    remoteHttpMock.mockImplementationOnce(async (params) => {
      expect(params.url).toContain("/files/file-out-999/content");
      return await params.onResponse(
        new Response(stream as unknown as BodyInit, {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson" },
        }),
      );
    });

    const results = await runVoyageEmbeddingBatches({
      client: mockClient,
      agentId: "agent-1",
      requests: mockRequests,
      wait: true,
      pollIntervalMs: 1, // fast poll
      timeoutMs: 1000,
      concurrency: 1,
    });

    expect(results.size).toBe(2);
    expect(results.get("req-1")).toEqual([0.1, 0.1]);
    expect(results.get("req-2")).toEqual([0.2, 0.2]);
    expect(remoteHttpMock).toHaveBeenCalledTimes(4);
  });

  it("handles empty lines and stream chunks correctly", async () => {
    const stream = new ReadableStream({
      start(controller) {
        const line1 = JSON.stringify({
          custom_id: "req-1",
          response: { body: { data: [{ embedding: [1] }] } },
        });
        const line2 = JSON.stringify({
          custom_id: "req-2",
          response: { body: { data: [{ embedding: [2] }] } },
        });

        // Split across chunks
        controller.enqueue(new TextEncoder().encode(line1 + "\n"));
        controller.enqueue(new TextEncoder().encode("\n")); // empty line
        controller.enqueue(new TextEncoder().encode(line2)); // no newline at EOF
        controller.close();
      },
    });
    remoteHttpMock.mockImplementationOnce(async (params) => {
      expect(params.url).toContain("/files");
      return await params.onResponse(new Response(JSON.stringify({ id: "f1" }), { status: 200 }));
    });
    remoteHttpMock.mockImplementationOnce(async (params) => {
      expect(params.url).toContain("/batches");
      return await params.onResponse(
        new Response(JSON.stringify({ id: "b1", status: "completed", output_file_id: "out1" }), {
          status: 200,
        }),
      );
    });
    remoteHttpMock.mockImplementationOnce(async (params) => {
      expect(params.url).toContain("/files/out1/content");
      return await params.onResponse(new Response(stream as unknown as BodyInit, { status: 200 }));
    });

    const results = await runVoyageEmbeddingBatches({
      client: mockClient,
      agentId: "a1",
      requests: mockRequests,
      wait: true,
      pollIntervalMs: 1,
      timeoutMs: 1000,
      concurrency: 1,
    });

    expect(results.get("req-1")).toEqual([1]);
    expect(results.get("req-2")).toEqual([2]);
  });
});
