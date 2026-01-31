import { afterEach, describe, expect, it } from "vitest";

import { __testing } from "./web-search.js";

const {
  inferPerplexityBaseUrlFromApiKey,
  resolvePerplexityBaseUrl,
  normalizeFreshness,
  resolveRateLimitMs,
  throttleRequest,
  resetLastSearchRequestTime,
} = __testing;

describe("web_search perplexity baseUrl defaults", () => {
  it("detects a Perplexity key prefix", () => {
    expect(inferPerplexityBaseUrlFromApiKey("pplx-123")).toBe("direct");
  });

  it("detects an OpenRouter key prefix", () => {
    expect(inferPerplexityBaseUrlFromApiKey("sk-or-v1-123")).toBe("openrouter");
  });

  it("returns undefined for unknown key formats", () => {
    expect(inferPerplexityBaseUrlFromApiKey("unknown-key")).toBeUndefined();
  });

  it("prefers explicit baseUrl over key-based defaults", () => {
    expect(resolvePerplexityBaseUrl({ baseUrl: "https://example.com" }, "config", "pplx-123")).toBe(
      "https://example.com",
    );
  });

  it("defaults to direct when using PERPLEXITY_API_KEY", () => {
    expect(resolvePerplexityBaseUrl(undefined, "perplexity_env")).toBe("https://api.perplexity.ai");
  });

  it("defaults to OpenRouter when using OPENROUTER_API_KEY", () => {
    expect(resolvePerplexityBaseUrl(undefined, "openrouter_env")).toBe(
      "https://openrouter.ai/api/v1",
    );
  });

  it("defaults to direct when config key looks like Perplexity", () => {
    expect(resolvePerplexityBaseUrl(undefined, "config", "pplx-123")).toBe(
      "https://api.perplexity.ai",
    );
  });

  it("defaults to OpenRouter when config key looks like OpenRouter", () => {
    expect(resolvePerplexityBaseUrl(undefined, "config", "sk-or-v1-123")).toBe(
      "https://openrouter.ai/api/v1",
    );
  });

  it("defaults to OpenRouter for unknown config key formats", () => {
    expect(resolvePerplexityBaseUrl(undefined, "config", "weird-key")).toBe(
      "https://openrouter.ai/api/v1",
    );
  });
});

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

describe("web_search rate limiting", () => {
  afterEach(() => {
    resetLastSearchRequestTime();
  });

  it("resolves rateLimitMs from config", () => {
    expect(resolveRateLimitMs({ rateLimitMs: 1000 })).toBe(1000);
    expect(resolveRateLimitMs({ rateLimitMs: 500 })).toBe(500);
  });

  it("returns 0 when rateLimitMs is not configured", () => {
    expect(resolveRateLimitMs(undefined)).toBe(0);
    expect(resolveRateLimitMs({})).toBe(0);
  });

  it("returns 0 for invalid rateLimitMs values", () => {
    expect(resolveRateLimitMs({ rateLimitMs: -100 })).toBe(0);
    expect(resolveRateLimitMs({ rateLimitMs: NaN })).toBe(0);
  });

  it("floors fractional rateLimitMs values", () => {
    expect(resolveRateLimitMs({ rateLimitMs: 1500.7 })).toBe(1500);
  });

  it("does not delay when rateLimitMs is 0", async () => {
    const start = Date.now();
    await throttleRequest(0);
    await throttleRequest(0);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it("enforces delay between consecutive requests", async () => {
    const rateLimitMs = 100;
    await throttleRequest(rateLimitMs);
    const start = Date.now();
    await throttleRequest(rateLimitMs);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90); // Allow small timing variance
  });

  it("does not delay if enough time has passed", async () => {
    await throttleRequest(50);
    await new Promise((r) => setTimeout(r, 60));
    const start = Date.now();
    await throttleRequest(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(20);
  });
});
