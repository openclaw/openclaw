import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyQverisError, createQverisTools } from "./qveris-tools.js";

describe("classifyQverisError", () => {
  it("classifies AbortError (DOMException) as timeout", () => {
    const err = new DOMException("The operation was aborted", "AbortError");
    const result = classifyQverisError(err);
    expect(result.success).toBe(false);
    expect(result.error_type).toBe("timeout");
    expect(result.detail).toContain("timed out");
    expect(result.retry_hint).toBeDefined();
  });

  it("classifies plain Error with name AbortError as timeout", () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    const result = classifyQverisError(err);
    expect(result.success).toBe(false);
    expect(result.error_type).toBe("timeout");
  });

  it("classifies HTTP 4xx errors correctly", () => {
    const err = new Error("QVeris execute failed (422): unprocessable entity");
    const result = classifyQverisError(err);
    expect(result.success).toBe(false);
    expect(result.error_type).toBe("http_error");
    expect(result.status).toBe(422);
    expect(result.retry_hint).toContain("tool_id");
  });

  it("classifies HTTP 5xx errors correctly", () => {
    const err = new Error("QVeris search failed (503): service unavailable");
    const result = classifyQverisError(err);
    expect(result.success).toBe(false);
    expect(result.error_type).toBe("http_error");
    expect(result.status).toBe(503);
    expect(result.retry_hint).toContain("retry");
  });

  it("classifies network errors (plain Error)", () => {
    const err = new Error("fetch failed: ECONNREFUSED");
    const result = classifyQverisError(err);
    expect(result.success).toBe(false);
    expect(result.error_type).toBe("network_error");
    expect(result.detail).toContain("ECONNREFUSED");
  });

  it("classifies unknown thrown values", () => {
    const result = classifyQverisError("something weird");
    expect(result.success).toBe(false);
    expect(result.error_type).toBe("network_error");
    expect(result.detail).toBe("something weird");
  });
});

// ---------------------------------------------------------------------------
// createQverisTools — tool creation, get-by-ids, rolodex
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    tools: {
      qveris: {
        enabled: true,
        apiKey: "qv_test_key",
        ...overrides,
      },
    },
  } as never;
}

function mockFetchJson(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

/** Extract the JSON payload from an AgentToolResult */
function parseToolResult(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object" && "details" in result) {
    return (result as { details: Record<string, unknown> }).details;
  }
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content: Array<{ text: string }> }).content;
    return JSON.parse(content[0].text) as Record<string, unknown>;
  }
  return JSON.parse(String(result)) as Record<string, unknown>;
}

const SAMPLE_SEARCH_RESPONSE = {
  query: "weather forecast API",
  total: 1,
  search_id: "search-abc",
  elapsed_time_ms: 42,
  results: [
    {
      tool_id: "openweathermap.weather.execute.v1",
      name: "OpenWeatherMap",
      description: "Weather forecast API",
      provider_description: "Weather data provider",
      params: [{ name: "city", type: "string", required: true, description: { en: "City name" } }],
      examples: { sample_parameters: { city: "London" } },
      stats: { success_rate: 0.95, avg_execution_time_ms: 800 },
    },
  ],
};

const SAMPLE_EXECUTE_RESPONSE = {
  execution_id: "exec-123",
  result: { data: { temp: 20, condition: "sunny" } },
  success: true,
  error_message: null,
  elapsed_time_ms: 300,
  cost: 0.01,
};

const SAMPLE_GET_BY_IDS_RESPONSE = {
  tools: [
    {
      tool_id: "openweathermap.weather.execute.v1",
      name: "OpenWeatherMap",
      description: "Weather forecast API",
      params: [{ name: "city", type: "string", required: true, description: { en: "City name" } }],
      examples: { sample_parameters: { city: "London" } },
      stats: { success_rate: 0.95, avg_execution_time_ms: 800 },
    },
  ],
};

describe("createQverisTools", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns empty array when disabled", () => {
    const tools = createQverisTools({
      config: { tools: { qveris: { enabled: false } } } as never,
    });
    expect(tools).toHaveLength(0);
  });

  it("returns empty array when no API key", () => {
    const savedKey = process.env.QVERIS_API_KEY;
    delete process.env.QVERIS_API_KEY;
    try {
      const tools = createQverisTools({
        config: { tools: { qveris: { enabled: true } } } as never,
      });
      expect(tools).toHaveLength(0);
    } finally {
      if (savedKey !== undefined) {
        process.env.QVERIS_API_KEY = savedKey;
      }
    }
  });

  it("creates three tools when enabled with API key", () => {
    const tools = createQverisTools({ config: makeConfig() });
    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.name);
    expect(names).toContain("qveris_search");
    expect(names).toContain("qveris_execute");
    expect(names).toContain("qveris_get_by_ids");
  });

  it("qveris_search description includes negative boundaries", () => {
    const tools = createQverisTools({ config: makeConfig() });
    const search = tools.find((t) => t.name === "qveris_search");
    expect(search?.description).toContain("NOT for");
    expect(search?.description).toContain("local operations");
    expect(search?.description).toContain("documentation");
  });

  it("qveris_get_by_ids executes and returns tool details", async () => {
    globalThis.fetch = mockFetchJson(SAMPLE_GET_BY_IDS_RESPONSE);
    const tools = createQverisTools({ config: makeConfig() });
    const getByIds = tools.find((t) => t.name === "qveris_get_by_ids")!;

    const result = await getByIds.execute("call-1", {
      tool_ids: "openweathermap.weather.execute.v1",
    });

    const parsed = parseToolResult(result);
    expect(parsed.tools_found).toBe(1);
    const toolsList = parsed.tools as Array<Record<string, unknown>>;
    expect(toolsList[0].tool_id).toBe("openweathermap.weather.execute.v1");
  });

  it("qveris_get_by_ids returns error for empty tool_ids", async () => {
    const tools = createQverisTools({ config: makeConfig() });
    const getByIds = tools.find((t) => t.name === "qveris_get_by_ids")!;

    const result = await getByIds.execute("call-1", { tool_ids: "  ,  , " });
    const parsed = parseToolResult(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error_type).toBe("json_parse_error");
  });

  it("rolodex records successful executions and annotates search results", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/search")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(SAMPLE_SEARCH_RESPONSE),
          text: () => Promise.resolve(""),
        });
      }
      if (typeof url === "string" && url.includes("/tools/execute")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(SAMPLE_EXECUTE_RESPONSE),
          text: () => Promise.resolve(""),
        });
      }
      return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("not found") });
    });

    const tools = createQverisTools({ config: makeConfig() });
    const search = tools.find((t) => t.name === "qveris_search")!;
    const execute = tools.find((t) => t.name === "qveris_execute")!;

    // First search — no session_known_tools yet
    const searchResult1 = await search.execute("s1", { query: "weather forecast API" });
    const parsed1 = parseToolResult(searchResult1);
    expect(parsed1.session_known_tools).toBeUndefined();
    const results1 = parsed1.results as Array<Record<string, unknown>>;
    expect(results1[0].previously_used).toBeUndefined();

    // Execute the tool successfully
    await execute.execute("e1", {
      tool_id: "openweathermap.weather.execute.v1",
      search_id: "search-abc",
      params_to_tool: '{"city": "London"}',
    });

    // Second search (different query to bypass cache) — should have session_known_tools
    const searchResult2 = await search.execute("s2", { query: "weather data API", limit: 5 });
    const parsed2 = parseToolResult(searchResult2);
    const knownTools = parsed2.session_known_tools as Array<Record<string, unknown>>;
    expect(knownTools).toBeDefined();
    expect(knownTools).toHaveLength(1);
    expect(knownTools[0].tool_id).toBe("openweathermap.weather.execute.v1");
    expect(knownTools[0].uses).toBe(1);

    // The tool in results should be annotated as previously_used
    const results2 = parsed2.results as Array<Record<string, unknown>>;
    expect(results2[0].previously_used).toBe(true);
    expect(results2[0].session_uses).toBe(1);
  });
});
