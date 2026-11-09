import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRemoteEmbeddingVectors } from "../../packages/memory-host-sdk/src/host/embeddings-remote-fetch.js";
import { openAICompatibleEmbeddingProviderAdapter } from "./openai-compatible-embedding-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const cases = [
  { host: "tenant.openai.azure.com", query: "", version: "2024-10-21", azure: true },
  {
    host: "tenant.services.ai.azure.com",
    query: "?api-version=",
    version: "2024-10-21",
    azure: true,
  },
  {
    host: "tenant.cognitiveservices.azure.com",
    query: "?api-version=2023-05-15&tenant=fixture",
    version: "2023-05-15",
    azure: true,
  },
  { host: "api.openai.com", query: "", version: null, azure: false },
  { host: "openai.azure.com.example.test", query: "", version: null, azure: false },
];

describe.each(["memory-host", "plugin"] as const)("%s Azure embedding HTTP target", (caller) => {
  it.each(cases)(
    "preserves the request contract for $host",
    async ({ host, query, version, azure }) => {
      // Only external HTTP is replaced: both owners, JSON serialization, and the guarded
      // remote response lifecycle run normally. No Azure credentials or DNS are needed.
      vi.stubEnv("NO_PROXY", "*");
      vi.stubEnv("no_proxy", "*");
      const requests: Array<{ url: URL; headers: Headers; body: unknown }> = [];
      const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
        if (typeof input !== "string" || typeof init?.body !== "string") {
          throw new Error("expected a URL string and serialized JSON body");
        }
        const url = new URL(input);
        const headers = new Headers(init?.headers);
        requests.push({ url, headers, body: JSON.parse(init.body) });
        const accepted =
          !azure ||
          (url.searchParams.get("api-version") === version && !headers.has("api-version"));
        return new Response(
          JSON.stringify(
            accepted
              ? { data: [{ index: 0, embedding: [0.25, 0.5] }], usage: { prompt_tokens: 2 } }
              : { error: { message: "Azure requires api-version in the query" } },
          ),
          {
            status: accepted ? 200 : 400,
            headers: { "content-type": "application/json" },
          },
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      const headers = Object.freeze({
        "API-Version": "2024-10-21",
        "api-key": "synthetic-azure-key",
      });
      const onUsage = vi.fn();
      if (caller === "memory-host") {
        await expect(
          fetchRemoteEmbeddingVectors({
            url: "https://" + host + "/openai/deployments/fixture/embeddings" + query,
            headers,
            body: { model: "fixture", input: ["hello"] },
            onUsage,
            errorPrefix: "fixture embeddings",
          }),
        ).resolves.toEqual([[0.25, 0.5]]);
      } else {
        const result = await openAICompatibleEmbeddingProviderAdapter.create({
          config: {},
          provider: "openai-compatible",
          model: "fixture",
          remote: { baseUrl: "https://" + host + "/openai/deployments/fixture" + query, headers },
        });
        expect(result.provider).toBeDefined();
        await expect(result.provider!.embed("hello", { onUsage })).resolves.toEqual([0.25, 0.5]);
        expect(result.runtime?.cacheKeyData).toMatchObject({
          headers: { "api-version": "2024-10-21" },
        });
      }
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.url.searchParams.get("tenant")).toBe(
        query.includes("tenant=") ? "fixture" : null,
      );
      expect(request.url.hostname).toBe(host);
      expect(request.url.pathname).toBe("/openai/deployments/fixture/embeddings");
      expect(request.url.searchParams.getAll("api-version")).toEqual(version ? [version] : []);
      expect(request.headers.get("api-version")).toBe(azure ? null : "2024-10-21");
      expect(request.headers.get("api-key")).toBe("synthetic-azure-key");
      expect(request.body).toEqual({ model: "fixture", input: ["hello"] });
      expect(headers["API-Version"]).toBe("2024-10-21");
      expect(onUsage).toHaveBeenCalledExactlyOnceWith({ promptTokens: 2, totalTokens: 2 });
    },
  );
});
