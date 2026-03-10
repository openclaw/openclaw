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
    const err = new Error("QVeris invoke failed (422): unprocessable entity");
    const result = classifyQverisError(err);
    expect(result.success).toBe(false);
    expect(result.error_type).toBe("http_error");
    expect(result.status).toBe(422);
    expect(result.retry_hint).toContain("tool_id");
  });

  it("classifies HTTP 5xx errors correctly", () => {
    const err = new Error("QVeris discover failed (503): service unavailable");
    const result = classifyQverisError(err);
    expect(result.success).toBe(false);
    expect(result.error_type).toBe("http_error");
    expect(result.status).toBe(503);
    expect(result.retry_hint).toContain("retry");
  });

  it("classifies 429 rate-limit errors", () => {
    const err = new Error("QVeris discover failed (429): too many requests [retry-after:30]");
    const result = classifyQverisError(err);
    expect(result.success).toBe(false);
    expect(result.error_type).toBe("rate_limited");
    expect(result.status).toBe(429);
    expect(result.retry_after_seconds).toBe(30);
    expect(result.retry_hint).toContain("30s");
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
// createQverisTools — tool creation, inspect, rolodex
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
    headers: new Headers(),
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

function parseRequestBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body === "string") {
    return JSON.parse(body) as Record<string, unknown>;
  }
  if (body == null) {
    return {};
  }
  throw new Error(`Unsupported mocked request body type: ${typeof body}`);
}

const SAMPLE_DISCOVER_RESPONSE = {
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

const SAMPLE_INVOKE_RESPONSE = {
  execution_id: "exec-123",
  result: { data: { temp: 20, condition: "sunny" } },
  success: true,
  error_message: null,
  elapsed_time_ms: 300,
  cost: 0.01,
};

const SAMPLE_INSPECT_RESPONSE = {
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
    expect(names).toContain("qveris_discover");
    expect(names).toContain("qveris_invoke");
    expect(names).toContain("qveris_inspect");
  });

  it("qveris_discover description includes negative boundaries", () => {
    const tools = createQverisTools({ config: makeConfig() });
    const discover = tools.find((t) => t.name === "qveris_discover");
    expect(discover?.description).toContain("NOT for");
    expect(discover?.description).toContain("local operations");
    expect(discover?.description).toContain("documentation");
  });

  it("qveris_inspect executes and returns tool details", async () => {
    globalThis.fetch = mockFetchJson(SAMPLE_INSPECT_RESPONSE);
    const tools = createQverisTools({ config: makeConfig() });
    const inspect = tools.find((t) => t.name === "qveris_inspect")!;

    const result = await inspect.execute("call-1", {
      tool_ids: "openweathermap.weather.execute.v1",
    });

    const parsed = parseToolResult(result);
    expect(parsed.tools_found).toBe(1);
    const toolsList = parsed.tools as Array<Record<string, unknown>>;
    expect(toolsList[0].tool_id).toBe("openweathermap.weather.execute.v1");
  });

  it("qveris_inspect returns rolodex discovery_id after a prior successful invoke", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/search")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(SAMPLE_DISCOVER_RESPONSE),
          text: () => Promise.resolve(""),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("/tools/execute")) {
        const body = parseRequestBody(init?.body);
        expect(body.search_id).toBe("search-abc");
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(SAMPLE_INVOKE_RESPONSE),
          text: () => Promise.resolve(""),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("/tools/get-by-ids")) {
        const body = parseRequestBody(init?.body);
        expect(body.search_id).toBeUndefined();
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(SAMPLE_INSPECT_RESPONSE),
          text: () => Promise.resolve(""),
          headers: new Headers(),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve("not found"),
        headers: new Headers(),
      });
    });
    globalThis.fetch = fetchMock;
    const tools = createQverisTools({ config: makeConfig() });
    const discover = tools.find((t) => t.name === "qveris_discover")!;
    const invoke = tools.find((t) => t.name === "qveris_invoke")!;
    const inspect = tools.find((t) => t.name === "qveris_inspect")!;

    await discover.execute("discover-1", { query: "weather forecast API" });
    await invoke.execute("invoke-1", {
      tool_id: "openweathermap.weather.execute.v1",
      discovery_id: "search-abc",
      params_to_tool: '{"city": "London"}',
    });
    const result = await inspect.execute("inspect-1", {
      tool_ids: "openweathermap.weather.execute.v1",
    });

    const parsed = parseToolResult(result);
    expect(parsed.discovery_id).toBe("search-abc");
    const toolsList = parsed.tools as Array<Record<string, unknown>>;
    expect(toolsList[0].discovery_id).toBe("search-abc");
  });

  it("qveris_inspect returns error for empty tool_ids", async () => {
    const tools = createQverisTools({ config: makeConfig() });
    const inspect = tools.find((t) => t.name === "qveris_inspect")!;

    const result = await inspect.execute("call-1", { tool_ids: "  ,  , " });
    const parsed = parseToolResult(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error_type).toBe("json_parse_error");
  });

  it("qveris_invoke reuses a rolodex discovery_id from a prior successful invoke", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/search")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(SAMPLE_DISCOVER_RESPONSE),
          text: () => Promise.resolve(""),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("/tools/execute")) {
        const body = parseRequestBody(init?.body);
        expect(body.search_id).toBe("search-abc");
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(SAMPLE_INVOKE_RESPONSE),
          text: () => Promise.resolve(""),
          headers: new Headers(),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve("not found"),
        headers: new Headers(),
      });
    });
    globalThis.fetch = fetchMock;
    const tools = createQverisTools({ config: makeConfig() });
    const discover = tools.find((t) => t.name === "qveris_discover")!;
    const invoke = tools.find((t) => t.name === "qveris_invoke")!;

    await discover.execute("discover-1", { query: "weather forecast API" });
    await invoke.execute("call-0", {
      tool_id: "openweathermap.weather.execute.v1",
      discovery_id: "search-abc",
      params_to_tool: '{"city": "London"}',
    });

    const result = await invoke.execute("call-1", {
      tool_id: "openweathermap.weather.execute.v1",
      params_to_tool: '{"city": "London"}',
    });

    const parsed = parseToolResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.execution_id).toBe("exec-123");
  });

  it("qveris_invoke returns a structured error when discovery_id is unknown", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    const tools = createQverisTools({ config: makeConfig() });
    const invoke = tools.find((t) => t.name === "qveris_invoke")!;

    const result = await invoke.execute("call-1", {
      tool_id: "openweathermap.weather.execute.v1",
      params_to_tool: '{"city": "London"}',
    });

    const parsed = parseToolResult(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error_type).toBe("json_parse_error");
    expect(String(parsed.detail)).toContain("Missing discovery_id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("qveris_invoke accepts legacy search_id parameter", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/tools/execute")) {
        const body = parseRequestBody(init?.body);
        expect(body.search_id).toBe("search-abc");
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(SAMPLE_INVOKE_RESPONSE),
          text: () => Promise.resolve(""),
          headers: new Headers(),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve("not found"),
        headers: new Headers(),
      });
    });
    globalThis.fetch = fetchMock;
    const tools = createQverisTools({ config: makeConfig() });
    const invoke = tools.find((t) => t.name === "qveris_invoke")!;

    const result = await invoke.execute("call-1", {
      tool_id: "openweathermap.weather.execute.v1",
      search_id: "search-abc",
      params_to_tool: '{"city": "London"}',
    });

    const parsed = parseToolResult(result);
    expect(parsed.success).toBe(true);
  });

  it("qveris_invoke returns recovery_step on body-level failure", async () => {
    const failResponse = {
      execution_id: "exec-fail",
      result: null,
      success: false,
      error_message: "Invalid parameter: city not found",
      elapsed_time_ms: 100,
      cost: 0,
    };
    globalThis.fetch = mockFetchJson(failResponse);
    const tools = createQverisTools({ config: makeConfig() });
    const invoke = tools.find((t) => t.name === "qveris_invoke")!;

    const result1 = await invoke.execute("call-1", {
      tool_id: "tool-x",
      discovery_id: "s1",
      params_to_tool: '{"city": "Atlantis"}',
    });
    const parsed1 = parseToolResult(result1);
    expect(parsed1.success).toBe(false);
    expect(parsed1.recovery_step).toBe("fix_params");
    expect(parsed1.attempt_number).toBe(1);

    const result2 = await invoke.execute("call-2", {
      tool_id: "tool-x",
      discovery_id: "s1",
      params_to_tool: '{"city": "London"}',
    });
    const parsed2 = parseToolResult(result2);
    expect(parsed2.recovery_step).toBe("simplify");
    expect(parsed2.attempt_number).toBe(2);
  });

  it("rolodex records successful invocations and annotates discover results", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/search")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(SAMPLE_DISCOVER_RESPONSE),
          text: () => Promise.resolve(""),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("/tools/execute")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(SAMPLE_INVOKE_RESPONSE),
          text: () => Promise.resolve(""),
          headers: new Headers(),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve("not found"),
        headers: new Headers(),
      });
    });

    const tools = createQverisTools({ config: makeConfig() });
    const discover = tools.find((t) => t.name === "qveris_discover")!;
    const invoke = tools.find((t) => t.name === "qveris_invoke")!;

    // First discover — no session_known_tools yet
    const discoverResult1 = await discover.execute("s1", { query: "weather forecast API" });
    const parsed1 = parseToolResult(discoverResult1);
    expect(parsed1.session_known_tools).toBeUndefined();
    const results1 = parsed1.results as Array<Record<string, unknown>>;
    expect(results1[0].previously_used).toBeUndefined();

    // Invoke the tool successfully
    await invoke.execute("e1", {
      tool_id: "openweathermap.weather.execute.v1",
      discovery_id: "search-abc",
      params_to_tool: '{"city": "London"}',
    });

    // Second discover (different query to bypass cache) — should have session_known_tools
    const discoverResult2 = await discover.execute("s2", { query: "weather data API", limit: 5 });
    const parsed2 = parseToolResult(discoverResult2);
    const knownTools = parsed2.session_known_tools as Array<Record<string, unknown>>;
    expect(knownTools).toBeDefined();
    expect(knownTools).toHaveLength(1);
    expect(knownTools[0].tool_id).toBe("openweathermap.weather.execute.v1");
    expect(knownTools[0].uses).toBe(1);
    expect(knownTools[0].discovery_id).toBe("search-abc");

    // The tool in results should be annotated as previously_used
    const results2 = parsed2.results as Array<Record<string, unknown>>;
    expect(results2[0].previously_used).toBe(true);
    expect(results2[0].session_uses).toBe(1);
    expect(results2[0].discovery_id).toBe("search-abc");
  });
});
