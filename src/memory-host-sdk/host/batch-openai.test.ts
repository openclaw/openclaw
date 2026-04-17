import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  uploadBatchJsonlFile: vi.fn(async () => "file_in"),
  postJsonWithRetry: vi.fn(async () => ({ id: "batch_1", status: "in_progress" })),
  resolveCompletedBatchResult: vi.fn(async () => ({ outputFileId: "file_out" })),
  withRemoteHttpResponse: vi.fn(
    async (params: { url: string; onResponse: (res: Response) => Promise<unknown> }) => {
      if (params.url.endsWith("/files/file_out/content")) {
        const content = [
          JSON.stringify({
            custom_id: "0",
            response: {
              status_code: 200,
              body: { data: [{ embedding: [1, 0, 0], index: 0 }] },
            },
          }),
          JSON.stringify({
            custom_id: "1",
            response: {
              status_code: 200,
              body: { data: [{ embedding: [2, 0, 0], index: 0 }] },
            },
          }),
        ].join("\n");
        return await params.onResponse({
          ok: true,
          status: 200,
          text: async () => content,
        } as Response);
      }
      return await params.onResponse({
        ok: true,
        status: 200,
        json: async () => ({ id: "batch_1", status: "completed", output_file_id: "file_out" }),
      } as Response);
    },
  ),
}));

vi.mock("./batch-upload.js", () => ({
  uploadBatchJsonlFile: mocks.uploadBatchJsonlFile,
}));

vi.mock("./batch-http.js", () => ({
  postJsonWithRetry: mocks.postJsonWithRetry,
}));

vi.mock("./batch-status.js", () => ({
  resolveBatchCompletionFromStatus: vi.fn(),
  resolveCompletedBatchResult: mocks.resolveCompletedBatchResult,
  throwIfBatchTerminalFailure: vi.fn(),
}));

vi.mock("./remote-http.js", () => ({
  withRemoteHttpResponse: mocks.withRemoteHttpResponse,
}));

describe("runOpenAiEmbeddingBatches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps uploaded batch output rows back to embeddings", async () => {
    const { runOpenAiEmbeddingBatches, OPENAI_BATCH_ENDPOINT } = await import("./batch-openai.js");

    const result = await runOpenAiEmbeddingBatches({
      openAi: {
        baseUrl: "https://api.openai.com/v1",
        headers: { Authorization: "Bearer test" },
        fetchImpl: fetch,
        model: "text-embedding-3-small",
      },
      agentId: "main",
      requests: [
        {
          custom_id: "0",
          method: "POST",
          url: OPENAI_BATCH_ENDPOINT,
          body: { model: "text-embedding-3-small", input: "hello" },
        },
        {
          custom_id: "1",
          method: "POST",
          url: OPENAI_BATCH_ENDPOINT,
          body: { model: "text-embedding-3-small", input: "world" },
        },
      ],
      wait: true,
      pollIntervalMs: 1,
      timeoutMs: 1000,
      concurrency: 3,
    });

    expect(mocks.uploadBatchJsonlFile).toHaveBeenCalled();
    expect(mocks.postJsonWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        errorPrefix: "openai batch create failed",
        body: expect.objectContaining({
          endpoint: OPENAI_BATCH_ENDPOINT,
          metadata: { source: "openclaw-memory", agent: "main" },
        }),
      }),
    );
    expect(result.get("0")).toEqual([1, 0, 0]);
    expect(result.get("1")).toEqual([2, 0, 0]);
  });
});
