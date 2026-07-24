// Covers Azure-specific OpenAI-compatible embedding request normalization.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingProviderCreateOptions } from "./embedding-providers.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/net/fetch-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/net/fetch-guard.js")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

let openAICompatibleEmbeddingProviderAdapter: typeof import("./openai-compatible-embedding-provider.js").openAICompatibleEmbeddingProviderAdapter;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ openAICompatibleEmbeddingProviderAdapter } =
    await import("./openai-compatible-embedding-provider.js"));
  fetchWithSsrFGuardMock.mockResolvedValue({
    response: new Response(
      JSON.stringify({
        object: "list",
        data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    release: vi.fn(),
  });
});

function createAzureOptions(params?: {
  baseUrl?: string;
  headers?: Record<string, string>;
}): EmbeddingProviderCreateOptions {
  return {
    config: {
      models: {
        providers: {
          "azure-embedding": {
            api: "openai-completions",
            baseUrl:
              params?.baseUrl ??
              "https://example.openai.azure.com/openai/deployments/text-embedding-3-small",
            apiKey: "test-api-key",
            authHeader: false,
            headers: params?.headers ?? {
              "api-key": "test-api-key",
              "api-version": "2024-10-21",
              "x-tenant": "acme",
            },
            models: [],
          },
        },
      },
    } as EmbeddingProviderCreateOptions["config"],
    provider: "azure-embedding",
    model: "text-embedding-3-small",
  };
}

async function captureEmbeddingRequest(options: EmbeddingProviderCreateOptions) {
  const result = await openAICompatibleEmbeddingProviderAdapter.create(options);
  await expect(result.provider?.embed("hello")).resolves.toEqual([0.1, 0.2]);
  const call = fetchWithSsrFGuardMock.mock.calls[0]?.[0] as
    | { url?: string; init?: RequestInit }
    | undefined;
  if (!call) {
    throw new Error("expected guarded embedding request");
  }
  return call;
}

describe("Azure OpenAI-compatible embeddings", () => {
  it.each([
    "example.openai.azure.com",
    "example.services.ai.azure.com",
    "example.cognitiveservices.azure.com",
  ])("moves the api-version header into the request URL for %s", async (hostname) => {
    const request = await captureEmbeddingRequest(
      createAzureOptions({
        baseUrl: `https://${hostname}/openai/deployments/text-embedding-3-small?tenant=acme`,
      }),
    );

    expect(request.url).toBe(
      `https://${hostname}/openai/deployments/text-embedding-3-small/embeddings?tenant=acme&api-version=2024-10-21`,
    );
    expect(new Headers(request.init?.headers).get("api-version")).toBeNull();
    expect(new Headers(request.init?.headers).get("api-key")).toBe("test-api-key");
  });

  it("keeps an api-version already configured in the URL", async () => {
    const request = await captureEmbeddingRequest(
      createAzureOptions({
        baseUrl:
          "https://example.openai.azure.com/openai/deployments/text-embedding-3-small?api-version=2024-06-01",
        headers: {
          "api-key": "test-api-key",
          "API-Version": "2024-10-21",
        },
      }),
    );

    expect(request.url).toBe(
      "https://example.openai.azure.com/openai/deployments/text-embedding-3-small/embeddings?api-version=2024-06-01",
    );
    expect(new Headers(request.init?.headers).get("api-version")).toBeNull();
  });

  it("leaves api-version as a header for non-Azure-compatible endpoints", async () => {
    const request = await captureEmbeddingRequest(
      createAzureOptions({
        baseUrl: "https://proxy.example.com/v1",
      }),
    );

    expect(request.url).toBe("https://proxy.example.com/v1/embeddings");
    expect(new Headers(request.init?.headers).get("api-version")).toBe("2024-10-21");
  });
});
