import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as authModule from "../../agents/model-auth.js";
import {
  createEmbeddingDataFetchMock,
  createJsonResponseFetchMock,
  installFetchMock,
  mockResolvedProviderKey,
  type JsonFetchMock,
} from "./embeddings-provider.test-support.js";
import { mockPublicPinnedHostname } from "./test-helpers/ssrf.js";

vi.mock("../../agents/model-auth.js", async () => {
  const { createModelAuthMockModule } = await import("../../test-utils/model-auth-mock.js");
  return createModelAuthMockModule();
});

let createZeroentropyEmbeddingProvider: typeof import("./embeddings-zeroentropy.js").createZeroentropyEmbeddingProvider;
let normalizeZeroentropyModel: typeof import("./embeddings-zeroentropy.js").normalizeZeroentropyModel;

beforeAll(async () => {
  ({ createZeroentropyEmbeddingProvider, normalizeZeroentropyModel } =
    await import("./embeddings-zeroentropy.js"));
});

beforeEach(() => {
  vi.useRealTimers();
  vi.doUnmock("undici");
});

async function createDefaultZeroentropyProvider(
  model: string,
  fetchMock: JsonFetchMock,
  options?: {
    dimensions?: number;
    encodingFormat?: "float" | "base64";
    latency?: "fast" | "slow";
  },
) {
  installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
  mockPublicPinnedHostname();
  mockResolvedProviderKey(authModule.resolveApiKeyForProvider, "zeroentropy-key-123");
  return createZeroentropyEmbeddingProvider({
    config: {} as never,
    provider: "zeroentropy",
    model,
    fallback: "none",
    zeroentropy: options,
  });
}

describe("zeroentropy embedding provider", () => {
  const encodeFloat32VectorToBase64 = (values: number[]) => {
    const bytes = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => {
      bytes.writeFloatLE(value, index * 4);
    });
    return bytes.toString("base64");
  };

  afterEach(() => {
    vi.doUnmock("undici");
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("configures client with correct defaults and headers", async () => {
    const fetchMock = createEmbeddingDataFetchMock();
    const result = await createDefaultZeroentropyProvider("zembed-1", fetchMock);

    await result.provider.embedQuery("test query");

    expect(authModule.resolveApiKeyForProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "zeroentropy" }),
    );

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [RequestInfo | URL, RequestInit | undefined];
    expect(url).toBe("https://api.zeroentropy.dev/v1/models/embed");

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer zeroentropy-key-123");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      model: "zembed-1",
      input_type: "query",
      input: ["test query"],
    });
  });

  it("includes optional dimensions, encoding_format, and latency", async () => {
    const fetchMock = createEmbeddingDataFetchMock();
    const result = await createDefaultZeroentropyProvider("zembed-1", fetchMock, {
      dimensions: 640,
      encodingFormat: "base64",
      latency: "slow",
    });

    await result.provider.embedBatch(["doc1", "doc2"]);

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [, init] = call as [RequestInfo | URL, RequestInit | undefined];
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      model: "zembed-1",
      input_type: "document",
      input: ["doc1", "doc2"],
      dimensions: 640,
      encoding_format: "base64",
      latency: "slow",
    });
  });

  it("includes dimensions when value is zero", async () => {
    const fetchMock = createEmbeddingDataFetchMock();
    const result = await createDefaultZeroentropyProvider("zembed-1", fetchMock, {
      dimensions: 0,
    });

    await result.provider.embedBatch(["doc"]);

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body).toEqual({
      model: "zembed-1",
      input_type: "document",
      input: ["doc"],
      dimensions: 0,
    });
  });

  it("decodes base64 embeddings to numeric vectors", async () => {
    const expected = [0.25, -0.5, 1.5];
    const fetchMock = createJsonResponseFetchMock({
      results: [{ embedding: encodeFloat32VectorToBase64(expected) }],
    });
    const result = await createDefaultZeroentropyProvider("zembed-1", fetchMock, {
      encodingFormat: "base64",
    });

    const vector = await result.provider.embedQuery("base64 query");

    expect(vector).toHaveLength(expected.length);
    expected.forEach((value, index) => {
      expect(vector[index]).toBeCloseTo(value, 6);
    });
  });

  it("respects remote overrides for baseUrl and apiKey", async () => {
    const fetchMock = createEmbeddingDataFetchMock();
    installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
    mockPublicPinnedHostname();

    const result = await createZeroentropyEmbeddingProvider({
      config: {} as never,
      provider: "zeroentropy",
      model: "zembed-1",
      fallback: "none",
      remote: {
        baseUrl: "https://example.com/v1",
        apiKey: "remote-override-key",
        headers: { "X-Custom": "123" },
      },
    });

    await result.provider.embedQuery("test");

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [RequestInfo | URL, RequestInit | undefined];
    expect(url).toBe("https://example.com/v1/models/embed");

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer remote-override-key");
    expect(headers["X-Custom"]).toBe("123");
  });

  it("normalizes model names", async () => {
    expect(normalizeZeroentropyModel("zeroentropy/zembed-1")).toBe("zembed-1");
    expect(normalizeZeroentropyModel("zembed/custom-model")).toBe("zembed/custom-model");
    expect(normalizeZeroentropyModel("  zembed-1  ")).toBe("zembed-1");
    expect(normalizeZeroentropyModel("")).toBe("zembed-1");
  });
});
