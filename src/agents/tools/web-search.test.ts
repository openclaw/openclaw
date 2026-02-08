import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testing } from "./web-search.js";

const {
  inferPerplexityBaseUrlFromApiKey,
  resolvePerplexityBaseUrl,
  resolveBraveBaseUrl,
  normalizeFreshness,
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

describe("web_search brave baseUrl resolution", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.BRAVE_API_URL;
    delete process.env.BRAVE_API_URL;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.BRAVE_API_URL;
    } else {
      process.env.BRAVE_API_URL = savedEnv;
    }
  });

  it("returns undefined when no config or env var", () => {
    expect(resolveBraveBaseUrl(undefined)).toBeUndefined();
    expect(resolveBraveBaseUrl({})).toBeUndefined();
  });

  it("uses config baseUrl when set", () => {
    expect(resolveBraveBaseUrl({ baseUrl: "http://localhost:3015" })).toBe("http://localhost:3015");
  });

  it("strips trailing slashes from config baseUrl", () => {
    expect(resolveBraveBaseUrl({ baseUrl: "http://localhost:3015/" })).toBe(
      "http://localhost:3015",
    );
  });

  it("falls back to BRAVE_API_URL env var", () => {
    process.env.BRAVE_API_URL = "http://my-proxy:8080";
    expect(resolveBraveBaseUrl(undefined)).toBe("http://my-proxy:8080");
  });

  it("ignores non-string config values", () => {
    expect(resolveBraveBaseUrl({ baseUrl: true as unknown as string })).toBeUndefined();
    expect(resolveBraveBaseUrl({ baseUrl: 123 as unknown as string })).toBeUndefined();
  });

  it("config takes precedence over env var", () => {
    process.env.BRAVE_API_URL = "http://env-proxy:8080";
    expect(resolveBraveBaseUrl({ baseUrl: "http://config-proxy:3015" })).toBe(
      "http://config-proxy:3015",
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
