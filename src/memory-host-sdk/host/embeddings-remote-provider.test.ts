import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fetchVectorsMock = vi.hoisted(() => vi.fn());
const resolveBearerMock = vi.hoisted(() => vi.fn());

vi.mock("./embeddings-remote-fetch.js", () => ({
  fetchRemoteEmbeddingVectors: fetchVectorsMock,
}));
vi.mock("./embeddings-remote-client.js", () => ({
  resolveRemoteEmbeddingBearerClient: resolveBearerMock,
}));

type Module = typeof import("./embeddings-remote-provider.js");

let createRemoteEmbeddingProvider: Module["createRemoteEmbeddingProvider"];
let resolveRemoteEmbeddingClient: Module["resolveRemoteEmbeddingClient"];

describe("createRemoteEmbeddingProvider", () => {
  beforeAll(async () => {
    ({ createRemoteEmbeddingProvider, resolveRemoteEmbeddingClient } =
      await import("./embeddings-remote-provider.js"));
  });

  beforeEach(() => {
    fetchVectorsMock.mockReset();
    resolveBearerMock.mockReset();
    // Return one unit vector per input, echoing nothing else.
    fetchVectorsMock.mockImplementation(async (params: { body: { input: string[] } }) =>
      params.body.input.map((_, i) => [i]),
    );
  });

  it("omits dimensions and sends a single request by default", async () => {
    const provider = createRemoteEmbeddingProvider({
      id: "openai",
      client: { baseUrl: "https://api.example/v1", headers: {}, model: "m" },
      errorPrefix: "fail",
    });

    await provider.embedBatch(["a", "b", "c"]);

    expect(fetchVectorsMock).toHaveBeenCalledTimes(1);
    const body = fetchVectorsMock.mock.calls[0][0].body;
    expect(body).toEqual({ model: "m", input: ["a", "b", "c"] });
    expect(body).not.toHaveProperty("dimensions");
  });

  it("includes dimensions in the request body when configured", async () => {
    const provider = createRemoteEmbeddingProvider({
      id: "openai",
      client: { baseUrl: "https://api.example/v1", headers: {}, model: "m", dimensions: 1024 },
      errorPrefix: "fail",
    });

    await provider.embedQuery("hello");

    expect(fetchVectorsMock).toHaveBeenCalledTimes(1);
    expect(fetchVectorsMock.mock.calls[0][0].body).toEqual({
      model: "m",
      input: ["hello"],
      dimensions: 1024,
    });
  });

  it("sub-batches inputs above the per-request cap, preserving order", async () => {
    // Distinct vectors so we can prove concat order.
    fetchVectorsMock.mockImplementation(async (params: { body: { input: string[] } }) =>
      params.body.input.map((text) => [Number(text)]),
    );
    const provider = createRemoteEmbeddingProvider({
      id: "openai",
      client: {
        baseUrl: "https://api.example/v1",
        headers: {},
        model: "m",
        dimensions: 1024,
        maxInputsPerRequest: 10,
      },
      errorPrefix: "fail",
    });

    const inputs = Array.from({ length: 23 }, (_, i) => String(i));
    const vectors = await provider.embedBatch(inputs);

    // 23 inputs / 10 = 3 requests (10, 10, 3).
    expect(fetchVectorsMock).toHaveBeenCalledTimes(3);
    expect(fetchVectorsMock.mock.calls[0][0].body.input).toHaveLength(10);
    expect(fetchVectorsMock.mock.calls[1][0].body.input).toHaveLength(10);
    expect(fetchVectorsMock.mock.calls[2][0].body.input).toHaveLength(3);
    // Every sub-request carries dimensions.
    for (const call of fetchVectorsMock.mock.calls) {
      expect(call[0].body.dimensions).toBe(1024);
    }
    // Concatenated in original order.
    expect(vectors).toEqual(inputs.map((t) => [Number(t)]));
  });

  it("tags a sub-batch failure with the failing input range", async () => {
    let call = 0;
    fetchVectorsMock.mockImplementation(async (params: { body: { input: string[] } }) => {
      call += 1;
      if (call === 2) {
        throw new Error("429 rate limited");
      }
      return params.body.input.map((_, i) => [i]);
    });
    const provider = createRemoteEmbeddingProvider({
      id: "openai",
      client: {
        baseUrl: "https://api.example/v1",
        headers: {},
        model: "m",
        maxInputsPerRequest: 10,
      },
      errorPrefix: "openai embeddings failed",
    });

    await expect(
      provider.embedBatch(Array.from({ length: 23 }, (_, i) => String(i))),
    ).rejects.toThrow("openai embeddings failed (inputs 10..20): 429 rate limited");
  });

  it("fails fast when a sub-batch returns fewer vectors than inputs", async () => {
    fetchVectorsMock.mockImplementation(async (params: { body: { input: string[] } }) =>
      // Drop one vector to simulate a short/misaligned response.
      params.body.input.slice(1).map((_, i) => [i]),
    );
    const provider = createRemoteEmbeddingProvider({
      id: "openai",
      client: {
        baseUrl: "https://api.example/v1",
        headers: {},
        model: "m",
        maxInputsPerRequest: 10,
      },
      errorPrefix: "openai embeddings failed",
    });

    await expect(
      provider.embedBatch(Array.from({ length: 12 }, (_, i) => String(i))),
    ).rejects.toThrow("expected 10 vectors for inputs 0..10, received 9");
  });

  it("returns empty without calling the endpoint for empty input", async () => {
    const provider = createRemoteEmbeddingProvider({
      id: "openai",
      client: { baseUrl: "https://api.example/v1", headers: {}, model: "m" },
      errorPrefix: "fail",
    });

    await expect(provider.embedBatch([])).resolves.toEqual([]);
    expect(fetchVectorsMock).not.toHaveBeenCalled();
  });
});

describe("resolveRemoteEmbeddingClient", () => {
  beforeAll(async () => {
    ({ resolveRemoteEmbeddingClient } = await import("./embeddings-remote-provider.js"));
  });

  beforeEach(() => {
    resolveBearerMock.mockReset();
    resolveBearerMock.mockResolvedValue({
      baseUrl: "https://dashscope.example/compatible-mode/v1",
      headers: { Authorization: "Bearer k" },
      ssrfPolicy: undefined,
    });
  });

  it("sets dimensions and the DashScope input cap when outputDimensionality is provided", async () => {
    const client = await resolveRemoteEmbeddingClient({
      provider: "openai",
      // Only the fields read by this function are needed here.
      options: { config: {}, model: "text-embedding-v4", outputDimensionality: 1024 } as never,
      defaultBaseUrl: "https://api.openai.com/v1",
      normalizeModel: (m) => m,
    });

    expect(client.dimensions).toBe(1024);
    expect(client.maxInputsPerRequest).toBe(10);
    expect(client.model).toBe("text-embedding-v4");
  });

  it("leaves dimensions and cap unset when outputDimensionality is absent", async () => {
    const client = await resolveRemoteEmbeddingClient({
      provider: "openai",
      options: { config: {}, model: "text-embedding-3-small" } as never,
      defaultBaseUrl: "https://api.openai.com/v1",
      normalizeModel: (m) => m,
    });

    expect(client.dimensions).toBeUndefined();
    expect(client.maxInputsPerRequest).toBeUndefined();
  });
});
