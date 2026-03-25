import { ReadableStream } from "node:stream/web";
import { setTimeout as nativeSleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  runVoyageEmbeddingBatches,
  type VoyageBatchOutputLine,
  type VoyageBatchRequest,
} from "./batch-voyage.js";
import type { VoyageEmbeddingClient } from "./embeddings-voyage.js";

const realNow = Date.now.bind(Date);

describe("runVoyageEmbeddingBatches", () => {
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
    const withRemoteHttpResponse = vi.fn();
    const postJsonWithRetry = vi.fn();
    const uploadBatchJsonlFile = vi.fn();

    // Create a stream that emits the NDJSON lines
    const stream = new ReadableStream({
      start(controller) {
        const text = outputLines.map((l) => JSON.stringify(l)).join("\n");
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    uploadBatchJsonlFile.mockImplementationOnce(async (params) => {
      expect(params.errorPrefix).toBe("voyage batch file upload failed");
      expect(params.requests).toEqual(mockRequests);
      return "file-123";
    });
    postJsonWithRetry.mockImplementationOnce(async (params) => {
      expect(params.url).toContain("/batches");
      expect(params.body).toMatchObject({
        input_file_id: "file-123",
        completion_window: "12h",
        request_params: {
          model: "voyage-4-large",
          input_type: "document",
        },
      });
      return {
        id: "batch-abc",
        status: "pending",
      };
    });
    withRemoteHttpResponse.mockImplementationOnce(async (params) => {
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
    withRemoteHttpResponse.mockImplementationOnce(async (params) => {
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
      deps: {
        now: realNow,
        sleep: async (ms) => {
          await nativeSleep(ms);
        },
        postJsonWithRetry,
        uploadBatchJsonlFile,
        withRemoteHttpResponse,
      },
    });

    expect(results.size).toBe(2);
    expect(results.get("req-1")).toEqual([0.1, 0.1]);
    expect(results.get("req-2")).toEqual([0.2, 0.2]);
    expect(uploadBatchJsonlFile).toHaveBeenCalledTimes(1);
    expect(postJsonWithRetry).toHaveBeenCalledTimes(1);
    expect(withRemoteHttpResponse).toHaveBeenCalledTimes(2);
  });

  it("handles empty lines and stream chunks correctly", async () => {
    const withRemoteHttpResponse = vi.fn();
    const postJsonWithRetry = vi.fn();
    const uploadBatchJsonlFile = vi.fn();
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
    uploadBatchJsonlFile.mockResolvedValueOnce("f1");
    postJsonWithRetry.mockResolvedValueOnce({
      id: "b1",
      status: "completed",
      output_file_id: "out1",
    });
    withRemoteHttpResponse.mockImplementationOnce(async (params) => {
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
      deps: {
        now: realNow,
        sleep: async (ms) => {
          await nativeSleep(ms);
        },
        postJsonWithRetry,
        uploadBatchJsonlFile,
        withRemoteHttpResponse,
      },
    });

    expect(results.get("req-1")).toEqual([1]);
    expect(results.get("req-2")).toEqual([2]);
  });
});
