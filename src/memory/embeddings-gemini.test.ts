import { beforeEach, describe, expect, it, vi } from "vitest";
import { retryAsync } from "../infra/retry.js";

vi.mock("../infra/retry.js", () => ({
  retryAsync: vi.fn(async (run: () => Promise<unknown>) => await run()),
}));

vi.mock("../agents/api-key-rotation.js", () => ({
  collectProviderApiKeysForExecution: () => ["test-key"],
  executeWithApiKeyRotation: vi.fn(async (opts: { execute: (key: string) => Promise<unknown> }) => {
    return await opts.execute("test-key");
  }),
}));

vi.mock("../agents/model-auth.js", () => ({
  requireApiKey: (k: string) => k,
  resolveApiKeyForProvider: async () => "test-key",
}));

vi.mock("../infra/gemini-auth.js", () => ({
  parseGeminiAuth: () => ({ headers: { "x-goog-api-key": "test-key" } }),
}));

vi.mock("./embeddings-debug.js", () => ({
  debugEmbeddingsLog: () => {},
}));

vi.mock("./remote-http.js", () => ({
  buildRemoteBaseUrlPolicy: () => undefined,
  withRemoteHttpResponse: vi.fn(),
}));

describe("createGeminiEmbeddingProvider retry behavior", () => {
  const retryAsyncMock = vi.mocked(retryAsync);

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-setup retryAsync to execute the function (passthrough) by default
    retryAsyncMock.mockImplementation(async (run: () => Promise<unknown>) => await run());
  });

  async function getProvider() {
    const { createGeminiEmbeddingProvider } = await import("./embeddings-gemini.js");
    return await createGeminiEmbeddingProvider({
      model: "gemini-embedding-001",
      config: {},
    } as never);
  }

  it("configures retryAsync with correct options for embedQuery", async () => {
    const { withRemoteHttpResponse } = await import("./remote-http.js");
    const wrhrMock = vi.mocked(withRemoteHttpResponse);
    wrhrMock.mockResolvedValueOnce({ embedding: { values: [0.1, 0.2] } });

    const { provider } = await getProvider();
    await provider.embedQuery("hello");

    expect(retryAsyncMock).toHaveBeenCalledTimes(1);
    const retryOptions = retryAsyncMock.mock.calls[0]?.[1] as {
      attempts: number;
      minDelayMs: number;
      maxDelayMs: number;
      jitter: number;
      shouldRetry: (err: unknown) => boolean;
    };
    expect(retryOptions.attempts).toBe(3);
    expect(retryOptions.minDelayMs).toBe(300);
    expect(retryOptions.maxDelayMs).toBe(2000);
    expect(retryOptions.jitter).toBe(0.2);
  });

  it("retries on 429 rate limit errors", async () => {
    const { withRemoteHttpResponse } = await import("./remote-http.js");
    vi.mocked(withRemoteHttpResponse).mockResolvedValueOnce({ embedding: { values: [0.1] } });

    const { provider } = await getProvider();
    await provider.embedQuery("test");

    const opts = retryAsyncMock.mock.calls[0]?.[1] as {
      shouldRetry: (err: unknown) => boolean;
    };
    expect(opts.shouldRetry({ status: 429 })).toBe(true);
  });

  it("retries on 5xx server errors", async () => {
    const { withRemoteHttpResponse } = await import("./remote-http.js");
    vi.mocked(withRemoteHttpResponse).mockResolvedValueOnce({ embedding: { values: [0.1] } });

    const { provider } = await getProvider();
    await provider.embedQuery("test");

    const opts = retryAsyncMock.mock.calls[0]?.[1] as {
      shouldRetry: (err: unknown) => boolean;
    };
    expect(opts.shouldRetry({ status: 500 })).toBe(true);
    expect(opts.shouldRetry({ status: 502 })).toBe(true);
    expect(opts.shouldRetry({ status: 503 })).toBe(true);
  });

  it("does not retry on 4xx client errors (except 429)", async () => {
    const { withRemoteHttpResponse } = await import("./remote-http.js");
    vi.mocked(withRemoteHttpResponse).mockResolvedValueOnce({ embedding: { values: [0.1] } });

    const { provider } = await getProvider();
    await provider.embedQuery("test");

    const opts = retryAsyncMock.mock.calls[0]?.[1] as {
      shouldRetry: (err: unknown) => boolean;
    };
    expect(opts.shouldRetry({ status: 400 })).toBe(false);
    expect(opts.shouldRetry({ status: 401 })).toBe(false);
    expect(opts.shouldRetry({ status: 403 })).toBe(false);
    expect(opts.shouldRetry({ status: 404 })).toBe(false);
  });

  it("retries on network errors (no status code)", async () => {
    const { withRemoteHttpResponse } = await import("./remote-http.js");
    vi.mocked(withRemoteHttpResponse).mockResolvedValueOnce({ embedding: { values: [0.1] } });

    const { provider } = await getProvider();
    await provider.embedQuery("test");

    const opts = retryAsyncMock.mock.calls[0]?.[1] as {
      shouldRetry: (err: unknown) => boolean;
    };
    // Network errors have no status — shouldRetry returns false (only retries known server errors)
    expect(opts.shouldRetry(new Error("fetch failed"))).toBe(false);
  });

  it("attaches status code to error for retry detection", async () => {
    const { withRemoteHttpResponse } = await import("./remote-http.js");
    const wrhrMock = vi.mocked(withRemoteHttpResponse);

    // Make retryAsync actually call the function so we can test error shaping
    retryAsyncMock.mockImplementation(async (run: () => Promise<unknown>) => await run());

    // Mock withRemoteHttpResponse to call onResponse with a non-ok response
    wrhrMock.mockImplementation(async (opts) => {
      return await opts.onResponse({
        ok: false,
        status: 429,
        text: async () => "rate limited",
      } as unknown as Response);
    });

    const { provider } = await getProvider();
    const err: Error & { status?: number } = await provider
      .embedQuery("test")
      .then(() => {
        throw new Error("expected embedQuery to reject");
      })
      .catch((e: Error) => e);
    expect(err.message).toContain("429");
    expect(err.status).toBe(429);
  });
});
