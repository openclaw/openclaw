import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider: vi.fn(),
  requireApiKey: (auth: { apiKey?: string; mode?: string }, provider: string) => {
    if (auth?.apiKey) {
      return auth.apiKey;
    }
    throw new Error(`No API key resolved for provider "${provider}" (auth mode: ${auth?.mode}).`);
  },
}));

const createPredictFetchMock = (values: number[] = [0.1, 0.2, 0.3]) =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      predictions: [{ embeddings: { values, statistics: { truncated: false, token_count: 3 } } }],
    }),
    text: async () => "",
  })) as unknown as typeof fetch;

const createBatchPredictFetchMock = () =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      predictions: [
        { embeddings: { values: [0.1, 0.2, 0.3] } },
        { embeddings: { values: [0.4, 0.5, 0.6] } },
      ],
    }),
    text: async () => "",
  })) as unknown as typeof fetch;

describe("vertex embedding provider", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("builds correct Vertex AI predict URL", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "my-project";
    process.env.GOOGLE_CLOUD_LOCATION = "us-central1";

    const fetchMock = createPredictFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { createVertexEmbeddingProvider } = await import("./embeddings-vertex.js");
    const { provider, client } = await createVertexEmbeddingProvider({
      config: {} as never,
      provider: "google-vertex",
      model: "text-embedding-005",
      fallback: "none",
    });
    client.getAccessToken = async () => "mock-token";

    await provider.embedQuery("hello");

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/my-project/locations/us-central1/publishers/google/models/text-embedding-005:predict",
    );
  });

  it("uses Bearer authorization header", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "my-project";
    process.env.GOOGLE_CLOUD_LOCATION = "us-central1";

    const fetchMock = createPredictFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { createVertexEmbeddingProvider } = await import("./embeddings-vertex.js");
    const { provider, client } = await createVertexEmbeddingProvider({
      config: {} as never,
      provider: "google-vertex",
      model: "text-embedding-005",
      fallback: "none",
    });
    client.getAccessToken = async () => "mock-token";

    await provider.embedQuery("hello");

    const headers = (fetchMock.mock.calls[0]![1]?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer mock-token");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sends instances array in request body for embedQuery", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "my-project";
    process.env.GOOGLE_CLOUD_LOCATION = "us-central1";

    const fetchMock = createPredictFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { createVertexEmbeddingProvider } = await import("./embeddings-vertex.js");
    const { provider, client } = await createVertexEmbeddingProvider({
      config: {} as never,
      provider: "google-vertex",
      model: "text-embedding-005",
      fallback: "none",
    });
    client.getAccessToken = async () => "mock-token";

    await provider.embedQuery("test text");

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body ?? "{}"));
    expect(body).toEqual({
      instances: [{ content: "test text", task_type: "RETRIEVAL_QUERY" }],
    });
  });

  it("parses predictions[].embeddings.values from response", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "my-project";
    process.env.GOOGLE_CLOUD_LOCATION = "us-central1";

    const fetchMock = createPredictFetchMock([1.0, 2.0, 3.0]);
    vi.stubGlobal("fetch", fetchMock);

    const { createVertexEmbeddingProvider } = await import("./embeddings-vertex.js");
    const { provider, client } = await createVertexEmbeddingProvider({
      config: {} as never,
      provider: "google-vertex",
      model: "text-embedding-005",
      fallback: "none",
    });
    client.getAccessToken = async () => "mock-token";

    const result = await provider.embedQuery("hello");
    expect(result).toEqual([1.0, 2.0, 3.0]);
  });

  it("handles batch embedding with multiple instances", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "my-project";
    process.env.GOOGLE_CLOUD_LOCATION = "us-central1";

    const fetchMock = createBatchPredictFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { createVertexEmbeddingProvider } = await import("./embeddings-vertex.js");
    const { provider, client } = await createVertexEmbeddingProvider({
      config: {} as never,
      provider: "google-vertex",
      model: "text-embedding-005",
      fallback: "none",
    });
    client.getAccessToken = async () => "mock-token";

    const results = await provider.embedBatch(["first doc", "second doc"]);
    expect(results).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body ?? "{}"));
    expect(body.instances).toEqual([
      { content: "first doc", task_type: "RETRIEVAL_DOCUMENT" },
      { content: "second doc", task_type: "RETRIEVAL_DOCUMENT" },
    ]);
  });

  it("returns empty array for empty text", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "my-project";
    process.env.GOOGLE_CLOUD_LOCATION = "us-central1";

    const { createVertexEmbeddingProvider } = await import("./embeddings-vertex.js");
    const { provider } = await createVertexEmbeddingProvider({
      config: {} as never,
      provider: "google-vertex",
      model: "text-embedding-005",
      fallback: "none",
    });

    const result = await provider.embedQuery("   ");
    expect(result).toEqual([]);
  });

  it("returns empty array for empty batch", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "my-project";
    process.env.GOOGLE_CLOUD_LOCATION = "us-central1";

    const { createVertexEmbeddingProvider } = await import("./embeddings-vertex.js");
    const { provider } = await createVertexEmbeddingProvider({
      config: {} as never,
      provider: "google-vertex",
      model: "text-embedding-005",
      fallback: "none",
    });

    const results = await provider.embedBatch([]);
    expect(results).toEqual([]);
  });

  it("throws when GOOGLE_CLOUD_PROJECT is not set", async () => {
    delete process.env.GOOGLE_CLOUD_PROJECT;

    const { createVertexEmbeddingProvider } = await import("./embeddings-vertex.js");
    await expect(
      createVertexEmbeddingProvider({
        config: {} as never,
        provider: "google-vertex",
        model: "text-embedding-005",
        fallback: "none",
      }),
    ).rejects.toThrow(/GOOGLE_CLOUD_PROJECT/);
  });

  it("normalizes model name by stripping google-vertex/ prefix", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "my-project";
    process.env.GOOGLE_CLOUD_LOCATION = "us-central1";

    const fetchMock = createPredictFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { createVertexEmbeddingProvider } = await import("./embeddings-vertex.js");
    const { provider, client } = await createVertexEmbeddingProvider({
      config: {} as never,
      provider: "google-vertex",
      model: "google-vertex/text-embedding-005",
      fallback: "none",
    });
    client.getAccessToken = async () => "mock-token";

    expect(provider.model).toBe("text-embedding-005");

    await provider.embedQuery("hello");
    expect(fetchMock.mock.calls[0]![0]).toContain("/models/text-embedding-005:predict");
  });

  it("defaults to text-embedding-005 when model is empty", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "my-project";
    process.env.GOOGLE_CLOUD_LOCATION = "us-central1";

    const { createVertexEmbeddingProvider } = await import("./embeddings-vertex.js");
    const { provider } = await createVertexEmbeddingProvider({
      config: {} as never,
      provider: "google-vertex",
      model: "",
      fallback: "none",
    });

    expect(provider.model).toBe("text-embedding-005");
  });

  it("defaults location to us-central1 when GOOGLE_CLOUD_LOCATION is global", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "my-project";
    process.env.GOOGLE_CLOUD_LOCATION = "global";

    const fetchMock = createPredictFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { createVertexEmbeddingProvider } = await import("./embeddings-vertex.js");
    const { provider, client } = await createVertexEmbeddingProvider({
      config: {} as never,
      provider: "google-vertex",
      model: "text-embedding-005",
      fallback: "none",
    });
    client.getAccessToken = async () => "mock-token";

    await provider.embedQuery("hello");
    expect(fetchMock.mock.calls[0]![0]).toContain("us-central1-aiplatform.googleapis.com");
  });
});
