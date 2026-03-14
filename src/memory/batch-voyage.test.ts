import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { VoyageBatchOutputLine, VoyageBatchRequest } from "./batch-voyage.js";
import type { VoyageEmbeddingClient } from "./embeddings-voyage.js";

// Mock internal.js if needed, but runWithConcurrency is simple enough to keep real.
// We DO need to mock retryAsync to avoid actual delays/retries logic complicating tests
vi.mock("../infra/retry.js", () => ({
  retryAsync: async <T>(fn: () => Promise<T>) => fn(),
}));

const withRemoteHttpResponseMock = vi.hoisted(() => vi.fn());

vi.mock("./remote-http.js", () => ({
  withRemoteHttpResponse: (...args: unknown[]) => withRemoteHttpResponseMock(...args),
}));

describe("runVoyageEmbeddingBatches", () => {
  let runVoyageEmbeddingBatches: typeof import("./batch-voyage.js").runVoyageEmbeddingBatches;

  function createRemoteHttpSequenceMock(
    responses: Array<
      | Response
      | ((params: {
          url: string;
          init?: RequestInit;
          onResponse: (response: Response) => Promise<unknown>;
        }) => Response | Promise<Response>)
    >,
  ) {
    let index = 0;
    withRemoteHttpResponseMock.mockImplementation(
      async (params: {
        url: string;
        init?: RequestInit;
        onResponse: (response: Response) => Promise<unknown>;
      }) => {
        const next = responses[index];
        index += 1;
        if (!next) {
          throw new Error(`unexpected request ${params.url}`);
        }
        const response = next instanceof Response ? next : await next(params);
        return await params.onResponse(response);
      },
    );
    return withRemoteHttpResponseMock;
  }

  beforeAll(async () => {
    ({ runVoyageEmbeddingBatches } = await import("./batch-voyage.js"));
  });

  afterEach(() => {
    withRemoteHttpResponseMock.mockReset();
    vi.resetAllMocks();
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
    const remoteHttpMock = createRemoteHttpSequenceMock([
      new Response(JSON.stringify({ id: "file-123" }), { status: 200 }),
      new Response(JSON.stringify({ id: "batch-abc", status: "pending" }), { status: 200 }),
      new Response(
        JSON.stringify({
          id: "batch-abc",
          status: "completed",
          output_file_id: "file-out-999",
        }),
        { status: 200 },
      ),
      new Response(stream, { status: 200 }),
    ]);

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

    // Verify calls
    expect(remoteHttpMock).toHaveBeenCalledTimes(4);

    // Verify File Upload
    const uploadCall = remoteHttpMock.mock.calls[0]?.[0] as
      | { url: string; init?: RequestInit }
      | undefined;
    expect(uploadCall?.url).toContain("/files");
    const uploadBody = uploadCall?.init?.body as FormData;
    expect(uploadBody).toBeInstanceOf(FormData);
    expect(uploadBody.get("purpose")).toBe("batch");

    // Verify Batch Create
    const createCall = remoteHttpMock.mock.calls[1]?.[0] as
      | { url: string; init?: RequestInit }
      | undefined;
    expect(createCall?.url).toContain("/batches");
    const createBody = JSON.parse((createCall?.init?.body as string | undefined) ?? "{}");
    expect(createBody.input_file_id).toBe("file-123");
    expect(createBody.completion_window).toBe("12h");
    expect(createBody.request_params).toEqual({
      model: "voyage-4-large",
      input_type: "document",
    });

    // Verify Content Fetch
    const contentCall = remoteHttpMock.mock.calls[3]?.[0] as { url: string } | undefined;
    expect(contentCall?.url).toContain("/files/file-out-999/content");
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
    createRemoteHttpSequenceMock([
      new Response(JSON.stringify({ id: "f1" }), { status: 200 }),
      new Response(JSON.stringify({ id: "b1", status: "completed", output_file_id: "out1" }), {
        status: 200,
      }),
      new Response(stream, { status: 200 }),
    ]);

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
