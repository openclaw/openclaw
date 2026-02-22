import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBedrockEmbeddingProvider,
  DEFAULT_BEDROCK_EMBEDDING_MODEL,
  normalizeBedrockModel,
} from "./embeddings-bedrock.js";

const createFetchMock = (embedding = [0.1, 0.2, 0.3]) =>
  vi.fn<(input: string | Request, init?: RequestInit) => Promise<Response>>(
    async () =>
      new Response(JSON.stringify({ embeddings: [{ embeddingType: "TEXT", embedding }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("normalizeBedrockModel", () => {
  it("returns default for empty string", () => {
    expect(normalizeBedrockModel("")).toBe(DEFAULT_BEDROCK_EMBEDDING_MODEL);
    expect(normalizeBedrockModel("  ")).toBe(DEFAULT_BEDROCK_EMBEDDING_MODEL);
  });

  it("strips bedrock/ prefix", () => {
    expect(normalizeBedrockModel("bedrock/amazon.nova-2-multimodal-embeddings-v1:0")).toBe(
      "amazon.nova-2-multimodal-embeddings-v1:0",
    );
  });

  it("passes through bare model id", () => {
    expect(normalizeBedrockModel("amazon.nova-2-multimodal-embeddings-v1:0")).toBe(
      "amazon.nova-2-multimodal-embeddings-v1:0",
    );
  });
});

describe("createBedrockEmbeddingProvider", () => {
  it("builds correct invoke URL with default region", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { provider } = await createBedrockEmbeddingProvider({
      config: {} as never,
      provider: "bedrock",
      model: "",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(DEFAULT_BEDROCK_EMBEDDING_MODEL)}/invoke`,
    );
  });

  it("uses AWS_REGION env var for region", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    vi.stubEnv("AWS_REGION", "ap-southeast-1");
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { provider } = await createBedrockEmbeddingProvider({
      config: {} as never,
      provider: "bedrock",
      model: "",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("bedrock-runtime.ap-southeast-1.amazonaws.com");
  });

  it("sets Authorization Bearer header from env token", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "my-bearer-token");
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { provider } = await createBedrockEmbeddingProvider({
      config: {} as never,
      provider: "bedrock",
      model: "",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer my-bearer-token");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("prefers remote.apiKey over env token", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "env-token");
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { provider } = await createBedrockEmbeddingProvider({
      config: {} as never,
      provider: "bedrock",
      model: "",
      fallback: "none",
      remote: { apiKey: "override-token" },
    });

    await provider.embedQuery("hello");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer override-token");
  });

  it("uses remote.baseUrl when provided", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { provider } = await createBedrockEmbeddingProvider({
      config: {} as never,
      provider: "bedrock",
      model: "",
      fallback: "none",
      remote: { baseUrl: "https://proxy.example.com" },
    });

    await provider.embedQuery("hello");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://proxy.example.com/model/");
  });

  it("sends correct Nova 2 request body", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { provider } = await createBedrockEmbeddingProvider({
      config: {} as never,
      provider: "bedrock",
      model: "",
      fallback: "none",
    });

    await provider.embedQuery("test input");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      schemaVersion: "nova-multimodal-embed-v1",
      taskType: "SINGLE_EMBEDDING",
      singleEmbeddingParams: {
        embeddingPurpose: "GENERIC_INDEX",
        embeddingDimension: 1024,
        text: {
          truncationMode: "END",
          value: "test input",
        },
      },
    });
  });

  it("parses Nova 2 response correctly", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    vi.stubGlobal("fetch", createFetchMock([0.1, 0.2, 0.3]));

    const { provider } = await createBedrockEmbeddingProvider({
      config: {} as never,
      provider: "bedrock",
      model: "",
      fallback: "none",
    });

    const result = await provider.embedQuery("hello");
    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  it("embedBatch calls invoke once per text", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    const fetchMock = createFetchMock([0.5, 0.6]);
    vi.stubGlobal("fetch", fetchMock);

    const { provider } = await createBedrockEmbeddingProvider({
      config: {} as never,
      provider: "bedrock",
      model: "",
      fallback: "none",
    });

    const results = await provider.embedBatch(["a", "b", "c"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(3);
  });

  it("throws helpful error when AWS_BEARER_TOKEN_BEDROCK is missing", async () => {
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;

    await expect(
      createBedrockEmbeddingProvider({
        config: {} as never,
        provider: "bedrock",
        model: "",
        fallback: "none",
      }),
    ).rejects.toThrow('No API key found for provider "bedrock"');
  });

  it("throws for unsupported model", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");

    await expect(
      createBedrockEmbeddingProvider({
        config: {} as never,
        provider: "bedrock",
        model: "amazon.titan-embed-text-v2:0",
        fallback: "none",
      }),
    ).rejects.toThrow("Unsupported Bedrock embedding model");
  });

  it("exposes provider id and model", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    vi.stubGlobal("fetch", createFetchMock());

    const { provider, client } = await createBedrockEmbeddingProvider({
      config: {} as never,
      provider: "bedrock",
      model: "",
      fallback: "none",
    });

    expect(provider.id).toBe("bedrock");
    expect(provider.model).toBe(DEFAULT_BEDROCK_EMBEDDING_MODEL);
    expect(client.modelId).toBe(DEFAULT_BEDROCK_EMBEDDING_MODEL);
  });
});
