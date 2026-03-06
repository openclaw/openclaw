import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testing } from "./web-search.js";

const {
  inferPerplexityBaseUrlFromApiKey,
  resolvePerplexityBaseUrl,
  isDirectPerplexityBaseUrl,
  resolvePerplexityRequestModel,
  normalizeFreshness,
  resolveGrokApiKey,
  resolveGrokModel,
  runGrokSearch,
  resolveTavilyApiKey,
  resolveTavilySearchDepth,
  runTavilySearch,
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

describe("web_search perplexity model normalization", () => {
  it("detects direct Perplexity host", () => {
    expect(isDirectPerplexityBaseUrl("https://api.perplexity.ai")).toBe(true);
    expect(isDirectPerplexityBaseUrl("https://api.perplexity.ai/")).toBe(true);
    expect(isDirectPerplexityBaseUrl("https://openrouter.ai/api/v1")).toBe(false);
  });

  it("strips provider prefix for direct Perplexity", () => {
    expect(resolvePerplexityRequestModel("https://api.perplexity.ai", "perplexity/sonar-pro")).toBe(
      "sonar-pro",
    );
  });

  it("keeps prefixed model for OpenRouter", () => {
    expect(
      resolvePerplexityRequestModel("https://openrouter.ai/api/v1", "perplexity/sonar-pro"),
    ).toBe("perplexity/sonar-pro");
  });

  it("keeps model unchanged when URL is invalid", () => {
    expect(resolvePerplexityRequestModel("not-a-url", "perplexity/sonar-pro")).toBe(
      "perplexity/sonar-pro",
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

describe("web_search grok config resolution", () => {
  it("uses config apiKey when provided", () => {
    expect(resolveGrokApiKey({ apiKey: "xai-test-key" })).toBe("xai-test-key");
  });

  it("returns undefined when no apiKey is available", () => {
    const previous = process.env.XAI_API_KEY;
    try {
      delete process.env.XAI_API_KEY;
      expect(resolveGrokApiKey({})).toBeUndefined();
      expect(resolveGrokApiKey(undefined)).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = previous;
      }
    }
  });

  it("uses default model when not specified", () => {
    expect(resolveGrokModel({})).toBe("grok-4-1-fast-reasoning");
    expect(resolveGrokModel(undefined)).toBe("grok-4-1-fast-reasoning");
  });

  it("uses config model when provided", () => {
    expect(resolveGrokModel({ model: "grok-3" })).toBe("grok-3");
  });
});

type GrokFixture = {
  description: string;
  response: Record<string, unknown>;
  expect: {
    contentsLength: number;
    contentsContains?: string[];
    citationsLength: number;
    citationUrls?: string[];
  };
};

const FIXTURES_DIR = path.resolve(import.meta.dirname, "__fixtures__/grok");

function loadGrokFixtures(): { name: string; fixture: GrokFixture }[] {
  const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  return files.map((file) => {
    const raw = fs.readFileSync(path.join(FIXTURES_DIR, file), "utf-8");
    return { name: file.replace(/\.json$/, ""), fixture: JSON.parse(raw) as GrokFixture };
  });
}

describe("running grok web searches (fixtures)", () => {
  const mockFetch = vi.fn();
  const defaultParams = {
    query: "test query",
    apiKey: "xai-test-key",
    model: "grok-4-1-fast-reasoning",
    timeoutSeconds: 30,
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const fixtures = loadGrokFixtures();

  for (const { name, fixture } of fixtures) {
    describe(`fixture: ${name}`, () => {
      it(fixture.description, async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => fixture.response,
        });

        const result = await runGrokSearch(defaultParams);

        expect(result.contents).toHaveLength(fixture.expect.contentsLength);
        expect(result.citations).toHaveLength(fixture.expect.citationsLength);

        if (fixture.expect.contentsContains) {
          for (const substring of fixture.expect.contentsContains) {
            const found = result.contents.some((c) => c.includes(substring));
            expect(found, `expected some content to contain "${substring}"`).toBe(true);
          }
        }

        if (fixture.expect.citationUrls) {
          for (const expectedUrl of fixture.expect.citationUrls) {
            const found = result.citations.some((c) => c.url.includes(expectedUrl));
            expect(found, `expected some citation url to contain "${expectedUrl}"`).toBe(true);
          }
        }
      });
    });
  }
});

describe("runGrokSearch (error handling)", () => {
  const mockFetch = vi.fn();
  const defaultParams = {
    query: "test query",
    apiKey: "xai-test-key",
    model: "grok-4-1-fast-reasoning",
    timeoutSeconds: 30,
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: async () => "rate limited",
    });

    await expect(runGrokSearch(defaultParams)).rejects.toThrow("xAI API error (429)");
  });
});

describe("web_search tavily config resolution", () => {
  it("reads apiKey from config", () => {
    expect(resolveTavilyApiKey({ apiKey: "tvly-test-key" })).toBe("tvly-test-key");
  });

  it("falls back to TAVILY_API_KEY env var", () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-from-env");
    expect(resolveTavilyApiKey({})).toBe("tvly-from-env");
    vi.unstubAllEnvs();
  });

  it("returns undefined when no key is set", () => {
    vi.stubEnv("TAVILY_API_KEY", "");
    expect(resolveTavilyApiKey({})).toBeUndefined();
    expect(resolveTavilyApiKey(undefined)).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it("defaults searchDepth to basic", () => {
    expect(resolveTavilySearchDepth({})).toBe("basic");
    expect(resolveTavilySearchDepth(undefined)).toBe("basic");
  });

  it("reads searchDepth from config", () => {
    expect(resolveTavilySearchDepth({ searchDepth: "advanced" })).toBe("advanced");
    expect(resolveTavilySearchDepth({ searchDepth: "ultra-fast" })).toBe("ultra-fast");
  });
});

type TavilyFixture = {
  description: string;
  response: Record<string, unknown>;
  expect: {
    resultsLength: number;
    firstTitle?: string;
    firstUrl?: string;
    firstScore?: number;
  };
};

const TAVILY_FIXTURES_DIR = path.resolve(import.meta.dirname, "__fixtures__/tavily");

function loadTavilyFixtures(): { name: string; fixture: TavilyFixture }[] {
  const files = fs.readdirSync(TAVILY_FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  return files.map((file) => {
    const raw = fs.readFileSync(path.join(TAVILY_FIXTURES_DIR, file), "utf-8");
    return { name: file.replace(/\.json$/, ""), fixture: JSON.parse(raw) as TavilyFixture };
  });
}

describe("running tavily web searches (fixtures)", () => {
  const mockFetch = vi.fn();
  const defaultParams = {
    query: "test query",
    apiKey: "tvly-test-key",
    count: 5,
    searchDepth: "basic" as const,
    timeoutSeconds: 30,
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const fixtures = loadTavilyFixtures();

  for (const { name, fixture } of fixtures) {
    describe(`fixture: ${name}`, () => {
      it(fixture.description, async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => fixture.response,
        });

        const results = await runTavilySearch(defaultParams);

        expect(results).toHaveLength(fixture.expect.resultsLength);

        if (fixture.expect.firstTitle !== undefined) {
          expect(results[0]?.title).toContain(fixture.expect.firstTitle);
        }
        if (fixture.expect.firstUrl !== undefined) {
          expect(results[0]?.url).toBe(fixture.expect.firstUrl);
        }
        if (fixture.expect.firstScore !== undefined) {
          expect(results[0]?.score).toBe(fixture.expect.firstScore);
        }
      });
    });
  }
});

describe("runTavilySearch (error handling)", () => {
  const mockFetch = vi.fn();
  const defaultParams = {
    query: "test query",
    apiKey: "tvly-test-key",
    count: 5,
    searchDepth: "basic" as const,
    timeoutSeconds: 30,
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "invalid api key",
    });

    await expect(runTavilySearch(defaultParams)).rejects.toThrow("Tavily API error (401)");
  });

  it("returns empty array for empty results", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [] }),
    });

    const results = await runTavilySearch(defaultParams);
    expect(results).toHaveLength(0);
  });

  it("sends correct request body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [] }),
    });

    await runTavilySearch({ ...defaultParams, count: 7, searchDepth: "advanced" });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.tavily.com/search");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.query).toBe("test query");
    expect(body.max_results).toBe(7);
    expect(body.search_depth).toBe("advanced");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tvly-test-key");
  });
});
