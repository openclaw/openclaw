import { beforeEach, describe, expect, it, vi } from "vitest";
import { retryAsync } from "../infra/retry.js";
import { postJsonWithRetry } from "./batch-http.js";
import { postJson } from "./post-json.js";

vi.mock("../infra/retry.js", () => ({
  retryAsync: vi.fn(async (run: () => Promise<unknown>) => await run()),
}));

vi.mock("./post-json.js", () => ({
  postJson: vi.fn(),
}));

describe("postJsonWithRetry", () => {
  const retryAsyncMock = vi.mocked(retryAsync);
  const postJsonMock = vi.mocked(postJson);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts JSON and returns parsed response payload", async () => {
    postJsonMock.mockImplementationOnce(async (params) => {
      return await params.parse({ ok: true, ids: [1, 2] });
    });

    const result = await postJsonWithRetry<{ ok: boolean; ids: number[] }>({
      url: "https://memory.example/v1/batch",
      headers: { Authorization: "Bearer test" },
      body: { chunks: ["a", "b"] },
      errorPrefix: "memory batch failed",
    });

    expect(result).toEqual({ ok: true, ids: [1, 2] });
    expect(postJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://memory.example/v1/batch",
        headers: { Authorization: "Bearer test" },
        body: { chunks: ["a", "b"] },
        errorPrefix: "memory batch failed",
        attachStatus: true,
      }),
    );

    const retryOptions = retryAsyncMock.mock.calls[0]?.[1] as
      | {
          attempts: number;
          minDelayMs: number;
          maxDelayMs: number;
          shouldRetry: (err: unknown) => boolean;
        }
      | undefined;
    expect(retryOptions?.attempts).toBe(3);
    expect(retryOptions?.minDelayMs).toBe(300);
    expect(retryOptions?.maxDelayMs).toBe(2000);
    expect(retryOptions?.shouldRetry({ status: 429 })).toBe(true);
    expect(retryOptions?.shouldRetry({ status: 503 })).toBe(true);
    expect(retryOptions?.shouldRetry({ status: 400 })).toBe(false);
  });

  it("attaches status to non-ok errors", async () => {
    postJsonMock.mockRejectedValueOnce(
      Object.assign(new Error("memory batch failed: 503 backend down"), { status: 503 }),
    );

    await expect(
      postJsonWithRetry({
        url: "https://memory.example/v1/batch",
        headers: {},
        body: { chunks: [] },
        errorPrefix: "memory batch failed",
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("memory batch failed: 503 backend down"),
      status: 503,
    });
  });
});
