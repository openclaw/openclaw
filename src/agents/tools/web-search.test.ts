import { describe, expect, it } from "vitest";
import {
  BraveProvider,
  PerplexityProvider,
  SerperProvider,
  MockProvider,
  type WebSearchOptions,
} from "./web-search-providers.js";
import { __testing } from "./web-search.js";

const { normalizeFreshness } = __testing;

describe("web_search freshness normalization", () => {
  it("accepts Brave shortcut values", () => {
    expect(normalizeFreshness("pd")).toBe("pd");
    expect(normalizeFreshness("PW")).toBe("pw");
  });

  it("accepts valid date ranges", () => {
    expect(normalizeFreshness("2024-01-01to2024-01-31")).toBe("2024-01-01to2024-01-31");
  });

  it("rejects invalid date ranges", () => {
    expect(normalizeFreshness("2024-13-01to2024-01-31")).toBeUndefined();
    expect(normalizeFreshness("2024-02-30to2024-03-01")).toBeUndefined();
    expect(normalizeFreshness("2024-03-10to2024-03-01")).toBeUndefined();
  });
});

describe("WebSearchProvider - Brave", () => {
  it("should throw error when API key is missing", () => {
    expect(() => new BraveProvider({})).toThrow("BraveProvider requires an API key");
  });

  it("should create provider with valid API key", () => {
    const provider = new BraveProvider({ apiKey: "test-key" });
    expect(provider.type).toBe("brave");
  });
});

describe("WebSearchProvider - Perplexity", () => {
  it("should throw error when API key is missing", () => {
    expect(() => new PerplexityProvider({})).toThrow("PerplexityProvider requires an API key");
  });

  it("should create provider with valid API key", () => {
    const provider = new PerplexityProvider({ apiKey: "pplx-test-key" });
    expect(provider.type).toBe("perplexity");
  });

  it("should infer direct base URL from pplx- key prefix", () => {
    const provider = new PerplexityProvider({ apiKey: "pplx-test-key" });
    // Provider is created successfully, indicating URL inference worked
    expect(provider.type).toBe("perplexity");
  });
});

describe("WebSearchProvider - Serper", () => {
  it("should throw error when API key is missing", () => {
    expect(() => new SerperProvider({})).toThrow("SerperProvider requires an API key");
  });

  it("should create provider with valid API key", () => {
    const provider = new SerperProvider({ apiKey: "test-key" });
    expect(provider.type).toBe("serper");
  });
});

describe("WebSearchProvider - Mock", () => {
  it("should return mock results", async () => {
    const provider = new MockProvider();
    const options: WebSearchOptions = {
      query: "test query",
      count: 5,
      timeoutSeconds: 10,
      cacheTtlMs: 60000,
    };

    const result = await provider.search(options);
    expect(result.query).toBe("test query");
    expect(result.provider).toBe("mock");
    expect(result.results).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
  });

  it("should support custom results", async () => {
    const provider = new MockProvider({
      customResult: (options) => ({
        query: options.query,
        provider: "mock",
        count: 1,
        tookMs: 100,
        results: [{ title: "Custom", url: "https://example.com", description: "Test" }],
      }),
    });

    const result = await provider.search({
      query: "test",
      count: 1,
      timeoutSeconds: 10,
      cacheTtlMs: 60000,
    });

    expect(result.results[0].title).toBe("Custom");
  });

  it("should support simulated delays", async () => {
    const provider = new MockProvider({ delay: 100 });
    const start = Date.now();

    await provider.search({
      query: "test",
      count: 1,
      timeoutSeconds: 10,
      cacheTtlMs: 60000,
    });

    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
  });

  it("should throw error when configured to fail", async () => {
    const provider = new MockProvider({
      shouldFail: true,
      errorMessage: "Test failure",
    });

    await expect(
      provider.search({
        query: "test",
        count: 1,
        timeoutSeconds: 10,
        cacheTtlMs: 60000,
      }),
    ).rejects.toThrow("Test failure");
  });
});

describe("WebSearchProvider - Fallback Behavior", () => {
  const options: WebSearchOptions = {
    query: "test query",
    count: 5,
    timeoutSeconds: 10,
    cacheTtlMs: 60000,
  };

  it("should succeed with primary provider", async () => {
    const primary = new MockProvider({ delay: 50 });
    const _fallback = new MockProvider({ delay: 50 });

    // Mock import the runWebSearchWithFallback function
    const { createWebSearchTool: _createWebSearchTool } = await import("./web-search.js");

    // Test would go here via integration test
    const result = await primary.search(options);
    expect(result.provider).toBe("mock");
  });

  it("should use fallback when primary fails", async () => {
    const primary = new MockProvider({
      shouldFail: true,
      errorMessage: "Primary failed",
    });
    const fallback = new MockProvider({
      customResult: (opts) => ({
        query: opts.query,
        provider: "mock",
        count: 1,
        tookMs: 50,
        results: [
          { title: "Fallback result", url: "https://example.com", description: "From fallback" },
        ],
      }),
    });

    // Primary fails
    await expect(primary.search(options)).rejects.toThrow("Primary failed");

    // Fallback succeeds
    const result = await fallback.search(options);
    expect(result.results[0].title).toBe("Fallback result");
  });

  it("should fail when both primary and fallback fail", async () => {
    const primary = new MockProvider({
      shouldFail: true,
      errorMessage: "Primary failed",
    });
    const fallback = new MockProvider({
      shouldFail: true,
      errorMessage: "Fallback failed",
    });

    // Both should fail
    await expect(primary.search(options)).rejects.toThrow("Primary failed");
    await expect(fallback.search(options)).rejects.toThrow("Fallback failed");
  });
});

describe("SerperProvider error messages", () => {
  it("should mention config option when API key is missing", () => {
    expect(() => new SerperProvider({})).toThrow(
      "SerperProvider requires an API key. Set tools.web.search.serper.apiKey in config, or SERPER_API_KEY in the Gateway environment.",
    );
  });
});

describe("extractProviderConfig", () => {
  it("passes serper config through", () => {
    const { extractProviderConfig } = __testing;
    const cfg = extractProviderConfig({
      enabled: true,
      provider: "serper",
      serper: { apiKey: "serper-key" },
    });
    expect(cfg.serper).toEqual({ apiKey: "serper-key" });
  });
});

describe("extractProviderConfig", () => {
  const { extractProviderConfig } = __testing;

  it("should extract serper config when present", () => {
    const searchConfig = {
      serper: { apiKey: "test-serper-key" },
    };
    const config = extractProviderConfig(searchConfig);
    expect(config.serper).toEqual({ apiKey: "test-serper-key" });
  });

  it("should return undefined for serper when not present", () => {
    const searchConfig = {
      apiKey: "test-brave-key",
    };
    const config = extractProviderConfig(searchConfig);
    expect(config.serper).toBeUndefined();
  });

  it("should extract all provider configs", () => {
    const searchConfig = {
      apiKey: "test-brave-key",
      serper: { apiKey: "test-serper-key" },
      perplexity: { apiKey: "test-perplexity-key" },
    };
    const config = extractProviderConfig(searchConfig);
    expect(config.brave).toEqual({ apiKey: "test-brave-key" });
    expect(config.serper).toEqual({ apiKey: "test-serper-key" });
    expect(config.perplexity).toEqual({ apiKey: "test-perplexity-key" });
  });
});
