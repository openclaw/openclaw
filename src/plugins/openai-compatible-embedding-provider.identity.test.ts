// Covers OpenAI-compatible embedding provider index-identity behavior.
import { describe, expect, it } from "vitest";
import type { EmbeddingProviderCreateOptions } from "./embedding-providers.js";
import { openAICompatibleEmbeddingProviderAdapter } from "./openai-compatible-embedding-provider.js";

function createOptions(
  overrides: Partial<EmbeddingProviderCreateOptions> = {},
): EmbeddingProviderCreateOptions {
  return {
    config: {} as EmbeddingProviderCreateOptions["config"],
    provider: "openai-compatible",
    model: "text-embedding-bge-m3",
    ...overrides,
  };
}

function resolveIndexIdentity(options: EmbeddingProviderCreateOptions) {
  const resolve = openAICompatibleEmbeddingProviderAdapter.resolveIndexIdentity;
  if (!resolve) {
    throw new Error("expected the openai-compatible adapter to expose resolveIndexIdentity");
  }
  return resolve.call(openAICompatibleEmbeddingProviderAdapter, options);
}

describe("resolveIndexIdentity", () => {
  it("mirrors the runtime cache key slice without reading auth", () => {
    const identity = resolveIndexIdentity(
      createOptions({
        config: {
          models: {
            providers: {
              "openai-compatible": {
                api: "openai-responses",
                baseUrl: "http://127.0.0.1:9001/v1",
                apiKey: "sk-secret-value",
              },
            },
          },
        } as unknown as EmbeddingProviderCreateOptions["config"],
      }),
    );

    expect(identity).toEqual({
      model: "text-embedding-bge-m3",
      cacheKeyData: {
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:9001/v1",
        model: "text-embedding-bge-m3",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
      },
    });
    expect(JSON.stringify(identity)).not.toContain("sk-secret-value");
  });

  it("matches the runtime cache key slice so existing indexes are not flagged stale", async () => {
    const options = createOptions({
      config: {
        models: {
          providers: {
            "openai-compatible": {
              api: "openai-responses",
              baseUrl: "http://127.0.0.1:9001/v1",
              apiKey: "sk-secret-value",
            },
          },
        },
      } as unknown as EmbeddingProviderCreateOptions["config"],
    });

    const identity = resolveIndexIdentity(options);
    const created = await openAICompatibleEmbeddingProviderAdapter.create(options);

    // Plain status resolves the index identity through the synchronous mirror
    // while the writer persists the runtime slice; if the two disagree, an
    // unchanged configuration is reported as a provider_settings mismatch.
    expect(identity?.cacheKeyData).not.toBeUndefined();
    expect(identity?.cacheKeyData).toEqual(created.runtime?.cacheKeyData);
  });

  it("prefers the remote endpoint over the configured provider endpoint", () => {
    const identity = resolveIndexIdentity(
      createOptions({
        config: {
          models: {
            providers: {
              "openai-compatible": {
                api: "openai-responses",
                baseUrl: "http://127.0.0.1:9001/v1",
              },
            },
          },
        } as unknown as EmbeddingProviderCreateOptions["config"],
        remote: { baseUrl: "http://127.0.0.1:9101/v1" },
      }),
    );

    expect(identity?.cacheKeyData).toMatchObject({ baseUrl: "http://127.0.0.1:9101/v1" });
  });

  it("reacts to configured endpoint changes so cached state can rebuild", () => {
    const identityFor = (baseUrl: string) =>
      resolveIndexIdentity(
        createOptions({
          config: {
            models: {
              providers: {
                "openai-compatible": { api: "openai-responses", baseUrl },
              },
            },
          } as unknown as EmbeddingProviderCreateOptions["config"],
        }),
      );

    expect(identityFor("http://127.0.0.1:9001/v1")?.cacheKeyData).not.toEqual(
      identityFor("http://127.0.0.1:9002/v1")?.cacheKeyData,
    );
  });
});
