import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyQverisError, createQverisTools, inferJsonAnalysis } from "./qveris-tools.js";

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

  it("includes default workflow note when no opts supplied", () => {
    const result = classifyQverisError(new Error("fetch failed: ECONNREFUSED"));
    expect(result.note).toContain("Stay inside the QVeris tool workflow");
    expect(result.note).toContain("Never call /search");
    expect(result.note).toContain("QVERIS_API_KEY");
  });

  it("uses caller-provided workflow note when supplied", () => {
    const result = classifyQverisError(new Error("fetch failed: ECONNREFUSED"), {
      note: "custom recovery note",
    });
    expect(result.note).toBe("custom recovery note");
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
    expect(names).toContain("qveris_call");
    expect(names).toContain("qveris_inspect");
  });

  it("qveris_discover description includes negative boundaries", () => {
    const tools = createQverisTools({ config: makeConfig() });
    const discover = tools.find((t) => t.name === "qveris_discover");
    expect(discover?.description).toContain("NOT for");
    expect(discover?.description).toContain("local file operations");
    expect(discover?.description).toContain("documentation");
    expect(discover?.description).toContain("historical sequence data");
    expect(discover?.description).toContain("web extraction/crawling");
  });

  it("qveris_call schema has tool_id and params_to_tool but not discovery_id", () => {
    const tools = createQverisTools({ config: makeConfig() });
    const invoke = tools.find((t) => t.name === "qveris_call");
    const schema = invoke?.parameters as { properties?: Record<string, unknown> } | undefined;

    expect(schema?.properties?.tool_id).toBeDefined();
    expect(schema?.properties?.params_to_tool).toBeDefined();
    expect(schema?.properties?.discovery_id).toBeUndefined();
    expect(schema?.properties?.search_id).toBeUndefined();
  });

  it("qveris_discover query schema includes bilingual rewrite guidance", () => {
    const tools = createQverisTools({ config: makeConfig() });
    const discover = tools.find((t) => t.name === "qveris_discover");
    const schema = discover?.parameters as {
      properties?: Record<string, { description?: string }>;
    };

    const queryDescription = schema.properties?.query?.description ?? "";
    // Schema description should contain bilingual guidance (concise)
    expect(queryDescription).toContain("腾讯最新股价");
    expect(queryDescription).toContain("stock quote real-time API");
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

  it("qveris_inspect returns tool info and no discovery_id after discover+call", async () => {
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
      if (typeof url === "string" && url.includes("/tools/by-ids")) {
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
    const invoke = tools.find((t) => t.name === "qveris_call")!;
    const inspect = tools.find((t) => t.name === "qveris_inspect")!;

    await discover.execute("discover-1", { query: "weather forecast API" });
    await invoke.execute("invoke-1", {
      tool_id: "openweathermap.weather.execute.v1",
      params_to_tool: '{"city": "London"}',
    });
    const result = await inspect.execute("inspect-1", {
      tool_ids: "openweathermap.weather.execute.v1",
    });

    const parsed = parseToolResult(result);
    expect(parsed.discovery_id).toBeUndefined();
    const toolsList = parsed.tools as Array<Record<string, unknown>>;
    expect(toolsList[0].tool_id).toBe("openweathermap.weather.execute.v1");
    expect(toolsList[0].discovery_id).toBeUndefined();
  });

  it("qveris_inspect returns error for empty tool_ids", async () => {
    const tools = createQverisTools({ config: makeConfig() });
    const inspect = tools.find((t) => t.name === "qveris_inspect")!;

    const result = await inspect.execute("call-1", { tool_ids: "  ,  , " });
    const parsed = parseToolResult(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error_type).toBe("json_parse_error");
    expect(String(parsed.note)).toContain("Stay inside the QVeris tool workflow");
  });

  it("qveris_call auto-resolves search_id from discover tracker on repeated calls", async () => {
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
    const invoke = tools.find((t) => t.name === "qveris_call")!;

    await discover.execute("discover-1", { query: "weather forecast API" });
    // First call — search_id auto-resolved from discover tracker
    await invoke.execute("call-0", {
      tool_id: "openweathermap.weather.execute.v1",
      params_to_tool: '{"city": "London"}',
    });

    // Second call — search_id auto-resolved from rolodex
    const result = await invoke.execute("call-1", {
      tool_id: "openweathermap.weather.execute.v1",
      params_to_tool: '{"city": "London"}',
    });

    const parsed = parseToolResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.execution_id).toBe("exec-123");
  });

  it("qveris_call proceeds with null search_id when tool was not discovered", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ execution_id: "exec-1", success: true, result: { data: "ok" } }),
      text: () => Promise.resolve(""),
      headers: new Headers(),
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    const tools = createQverisTools({ config: makeConfig() });
    const invoke = tools.find((t) => t.name === "qveris_call")!;

    await invoke.execute("call-1", {
      tool_id: "unknown-tool-xyz",
      params_to_tool: '{"city": "London"}',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/tools/execute");
    const body = JSON.parse(init.body);
    expect(body.search_id).toBeNull();
  });

  it("qveris_call returns recovery_step on body-level failure", async () => {
    const failResponse = {
      execution_id: "exec-fail",
      result: null,
      success: false,
      error_message: "Invalid parameter: city not found",
      elapsed_time_ms: 100,
      cost: 0,
    };
    const discoverResponse = {
      query: "tool x API",
      total: 1,
      search_id: "s1",
      results: [{ tool_id: "tool-x", name: "ToolX", description: "test" }],
    };
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/search")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(discoverResponse),
          text: () => Promise.resolve(""),
          headers: new Headers(),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(failResponse),
        text: () => Promise.resolve(""),
        headers: new Headers(),
      });
    });
    const tools = createQverisTools({ config: makeConfig() });
    const discover = tools.find((t) => t.name === "qveris_discover")!;
    const invoke = tools.find((t) => t.name === "qveris_call")!;

    await discover.execute("d1", { query: "tool x API" });
    const result1 = await invoke.execute("call-1", {
      tool_id: "tool-x",
      params_to_tool: '{"city": "Atlantis"}',
    });
    const parsed1 = parseToolResult(result1);
    expect(parsed1.success).toBe(false);
    expect(parsed1.recovery_step).toBe("fix_params");
    expect(parsed1.attempt_number).toBe(1);
    expect(String(parsed1.note)).toContain("Stay inside the QVeris tool workflow");

    const result2 = await invoke.execute("call-2", {
      tool_id: "tool-x",
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
    const invoke = tools.find((t) => t.name === "qveris_call")!;

    // First discover — no session_known_tools yet
    const discoverResult1 = await discover.execute("s1", { query: "weather forecast API" });
    const parsed1 = parseToolResult(discoverResult1);
    expect(parsed1.session_known_tools).toBeUndefined();
    const results1 = parsed1.results as Array<Record<string, unknown>>;
    expect(results1[0].previously_used).toBeUndefined();

    // Invoke the tool successfully — search_id auto-resolved from discover tracker
    await invoke.execute("e1", {
      tool_id: "openweathermap.weather.execute.v1",
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
    expect(knownTools[0].discovery_id).toBeUndefined();

    // The tool in results should be annotated as previously_used
    const results2 = parsed2.results as Array<Record<string, unknown>>;
    expect(results2[0].previously_used).toBe(true);
    expect(results2[0].session_uses).toBe(1);
    expect(results2[0].discovery_id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// inferJsonAnalysis — unit tests
// ---------------------------------------------------------------------------

describe("inferJsonAnalysis", () => {
  it("infers JSON array schema from first record", () => {
    const data = JSON.stringify([
      { user_id: "abc", nickname: "test", fans_count: 123, tags: ["a", "b"] },
      { user_id: "def", nickname: "test2", fans_count: 456, tags: ["c"] },
    ]);
    const result = inferJsonAnalysis(data, 800);
    expect(result.root_type).toBe("array");
    expect(result.record_count).toBe(2);
    expect(result.fields).toBeDefined();
    expect(result.fields!.user_id).toBe("string");
    expect(result.fields!.fans_count).toBe("number");
    expect(result.fields!.tags).toBe("string[]");
    expect(result.preview_records).toBe(2);
    expect(result.preview).toBeDefined();
  });

  it("infers JSON object schema", () => {
    const data = JSON.stringify({ items: [1, 2, 3], total: 3, name: "test" });
    const result = inferJsonAnalysis(data, 800);
    expect(result.root_type).toBe("object");
    expect(result.fields).toBeDefined();
    expect(result.fields!.items).toBe("array[3]");
    expect(result.fields!.total).toBe("number");
    expect(result.fields!.name).toBe("string");
  });

  it("returns empty analysis for invalid JSON", () => {
    const result = inferJsonAnalysis("not json", 800);
    expect(result.root_type).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Full-content materialization — integration tests
// ---------------------------------------------------------------------------

describe("qveris_call materialization", () => {
  let originalFetch: typeof globalThis.fetch;
  let tmpDir: string;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "qveris-materialize-test-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  const TRUNCATED_INVOKE_RESPONSE = {
    execution_id: "exec-trunc-1",
    result: {
      status_code: 200,
      message: "Result content is too long (132707 bytes)",
      truncated_content: '[{"user_id":"abc","nickname":"partial..."}]',
      full_content_file_url: "https://oss.qveris.ai/full-content/exec-trunc-1.json",
      content_schema: { type: "array" },
    },
    success: true,
    error_message: null,
    elapsed_time_ms: 500,
    cost: 0.05,
  };

  const FULL_CONTENT_JSON = JSON.stringify([
    { user_id: "abc", nickname: "KOL_A", fans_count: 52000, tags: ["beauty"] },
    { user_id: "def", nickname: "KOL_B", fans_count: 31000, tags: ["fashion"] },
  ]);

  // Builds a discover response that registers a given tool_id in the session tracker
  function makeDiscoverResponse(toolId: string, searchId = "search-mat") {
    return {
      query: "materialize test",
      total: 1,
      search_id: searchId,
      results: [{ tool_id: toolId, name: toolId, description: "test tool" }],
    };
  }

  // Helper: run discover to register a tool so qveris_call can auto-resolve search_id
  async function registerToolViaDiscover(
    tools: Array<{
      name: string;
      execute: (id: string, args: Record<string, unknown>) => Promise<unknown>;
    }>,
    toolId: string,
  ) {
    const discover = tools.find((t) => t.name === "qveris_discover")!;
    await discover.execute("pre-discover", { query: `find ${toolId}` });
  }

  function makeMaterializeFetchMock(opts?: {
    toolId?: string;
    invokeResponse?: typeof TRUNCATED_INVOKE_RESPONSE;
    ossHandler?: (url: string) => Promise<unknown>;
  }) {
    const toolId = opts?.toolId ?? "test-tool";
    const invokeResponse = opts?.invokeResponse ?? TRUNCATED_INVOKE_RESPONSE;
    return vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/search")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makeDiscoverResponse(toolId)),
          text: () => Promise.resolve(""),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("/tools/execute")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(invokeResponse),
          text: () => Promise.resolve(JSON.stringify(invokeResponse)),
          headers: new Headers(),
        });
      }
      if (opts?.ossHandler && typeof url === "string" && url.includes("oss.qveris.ai")) {
        return opts.ossHandler(url);
      }
      if (typeof url === "string" && url.includes("oss.qveris.ai")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(FULL_CONTENT_JSON),
          headers: new Headers({ "content-type": "application/json" }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve("not found"),
        headers: new Headers(),
      });
    });
  }

  it("materializes full content when full_content_file_url is present", async () => {
    globalThis.fetch = makeMaterializeFetchMock({ toolId: "xiaohongshu.kol_search.v1" });
    const tools = createQverisTools({
      config: makeConfig({ autoMaterializeFullContent: true }),
      workspaceDir: tmpDir,
    });
    await registerToolViaDiscover(tools, "xiaohongshu.kol_search.v1");
    const invoke = tools.find((t) => t.name === "qveris_call")!;

    const result = await invoke.execute("call-1", {
      tool_id: "xiaohongshu.kol_search.v1",
      params_to_tool: '{"keyword": "beauty"}',
    });

    const parsed = parseToolResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.materialized_content).toBeDefined();
    const mc = parsed.materialized_content as Record<string, unknown>;
    expect(mc.status).toBe("ready");
    expect(mc.content_category).toBe("json");
    expect(typeof mc.path).toBe("string");
    expect(mc.consumption_contract).toContain("read or exec");

    // File should exist on disk
    const filePath = path.join(tmpDir, mc.path as string);
    const content = await fsp.readFile(filePath, "utf-8");
    expect(JSON.parse(content)).toHaveLength(2);
  });

  it("strips truncated transport fields on successful materialization", async () => {
    globalThis.fetch = makeMaterializeFetchMock({ toolId: "xiaohongshu.kol_search.v1" });
    const tools = createQverisTools({
      config: makeConfig({ autoMaterializeFullContent: true }),
      workspaceDir: tmpDir,
    });
    await registerToolViaDiscover(tools, "xiaohongshu.kol_search.v1");
    const invoke = tools.find((t) => t.name === "qveris_call")!;

    const result = await invoke.execute("call-1", {
      tool_id: "xiaohongshu.kol_search.v1",
      params_to_tool: '{"keyword": "beauty"}',
    });

    const parsed = parseToolResult(result);
    const resultObj = parsed.result as Record<string, unknown>;
    expect(resultObj.truncated_content).toBeUndefined();
    expect(resultObj.full_content_file_url).toBeUndefined();
    // Non-transport fields should be preserved
    expect(resultObj.status_code).toBe(200);
    expect(resultObj.message).toBeDefined();
    expect(resultObj.content_schema).toBeDefined();
  });

  it("degrades gracefully when full content download times out", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/search")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makeDiscoverResponse("tool-x")),
          text: () => Promise.resolve(""),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("/tools/execute")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(TRUNCATED_INVOKE_RESPONSE),
          text: () => Promise.resolve(JSON.stringify(TRUNCATED_INVOKE_RESPONSE)),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("oss.qveris.ai")) {
        const err = new DOMException("The operation was aborted", "AbortError");
        return Promise.reject(err);
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve("not found"),
        headers: new Headers(),
      });
    });
    globalThis.fetch = fetchMock;
    const tools = createQverisTools({
      config: makeConfig({ autoMaterializeFullContent: true }),
      workspaceDir: tmpDir,
    });
    await registerToolViaDiscover(tools, "tool-x");
    const invoke = tools.find((t) => t.name === "qveris_call")!;

    const result = await invoke.execute("call-1", {
      tool_id: "tool-x",
      params_to_tool: '{"q": "test"}',
    });

    const parsed = parseToolResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.truncated).toBe(true);
    const mc = parsed.materialized_content as Record<string, unknown>;
    expect(mc.status).toBe("failed");
    expect(mc.reason).toBe("download_timeout");
    // Transport fields should be preserved on failure
    const resultObj = parsed.result as Record<string, unknown>;
    expect(resultObj.truncated_content).toBeDefined();
    expect(resultObj.full_content_file_url).toBeDefined();
  });

  it("degrades gracefully when full content URL is not HTTPS", async () => {
    const httpResponse = {
      ...TRUNCATED_INVOKE_RESPONSE,
      result: {
        ...TRUNCATED_INVOKE_RESPONSE.result,
        full_content_file_url: "http://insecure.example.com/data.json",
      },
    };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/search")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makeDiscoverResponse("tool-x")),
          text: () => Promise.resolve(""),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("/tools/execute")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(httpResponse),
          text: () => Promise.resolve(JSON.stringify(httpResponse)),
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
    const tools = createQverisTools({
      config: makeConfig({ autoMaterializeFullContent: true }),
      workspaceDir: tmpDir,
    });
    await registerToolViaDiscover(tools, "tool-x");
    const invoke = tools.find((t) => t.name === "qveris_call")!;

    const result = await invoke.execute("call-1", {
      tool_id: "tool-x",
      params_to_tool: '{"q": "test"}',
    });

    const parsed = parseToolResult(result);
    const mc = parsed.materialized_content as Record<string, unknown>;
    expect(mc.status).toBe("failed");
    expect(mc.reason).toBe("download_error");
    expect(String(mc.detail)).toContain("HTTPS");
  });

  it("degrades gracefully when full content URL domain is not whitelisted", async () => {
    const blockedResponse = {
      ...TRUNCATED_INVOKE_RESPONSE,
      result: {
        ...TRUNCATED_INVOKE_RESPONSE.result,
        full_content_file_url: "https://evil-bucket.s3.amazonaws.com/data.json",
      },
    };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/search")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makeDiscoverResponse("tool-x")),
          text: () => Promise.resolve(""),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("/tools/execute")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(blockedResponse),
          text: () => Promise.resolve(JSON.stringify(blockedResponse)),
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
    const tools = createQverisTools({
      config: makeConfig({ autoMaterializeFullContent: true }),
      workspaceDir: tmpDir,
    });
    await registerToolViaDiscover(tools, "tool-x");
    const invoke = tools.find((t) => t.name === "qveris_call")!;

    const result = await invoke.execute("call-1", {
      tool_id: "tool-x",
      params_to_tool: '{"q": "test"}',
    });

    const parsed = parseToolResult(result);
    const mc = parsed.materialized_content as Record<string, unknown>;
    expect(mc.status).toBe("failed");
    expect(mc.reason).toBe("download_error");
    expect(String(mc.detail)).toContain("not in the allowed list");
    // Transport fields preserved on failure
    const resultObj = parsed.result as Record<string, unknown>;
    expect(resultObj.full_content_file_url).toBeDefined();
  });

  it("skips materialization when autoMaterializeFullContent is false", async () => {
    globalThis.fetch = makeMaterializeFetchMock({ toolId: "tool-x" });
    const tools = createQverisTools({
      config: makeConfig({ autoMaterializeFullContent: false }),
      workspaceDir: tmpDir,
    });
    await registerToolViaDiscover(tools, "tool-x");
    const invoke = tools.find((t) => t.name === "qveris_call")!;

    const result = await invoke.execute("call-1", {
      tool_id: "tool-x",
      params_to_tool: '{"q": "test"}',
    });

    const parsed = parseToolResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.truncated).toBe(true);
    expect(parsed.materialized_content).toBeUndefined();
    expect(parsed.truncation_hint).toContain("full_content_file_url");
  });

  it("skips materialization when no workspaceDir", async () => {
    globalThis.fetch = makeMaterializeFetchMock({ toolId: "tool-x" });
    const tools = createQverisTools({ config: makeConfig() });
    await registerToolViaDiscover(tools, "tool-x");
    const invoke = tools.find((t) => t.name === "qveris_call")!;

    const result = await invoke.execute("call-1", {
      tool_id: "tool-x",
      params_to_tool: '{"q": "test"}',
    });

    const parsed = parseToolResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.truncated).toBe(true);
    expect(parsed.materialized_content).toBeUndefined();
  });

  it("materializes binary content (image/png) via raw byte path", async () => {
    // Simulate a small PNG-like binary payload with non-UTF-8 bytes
    const pngSignature = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01,
    ]);
    const binaryResponse = {
      ...TRUNCATED_INVOKE_RESPONSE,
      result: {
        ...TRUNCATED_INVOKE_RESPONSE.result,
        full_content_file_url: "https://oss.qveris.ai/images/chart.png",
      },
    };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/search")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makeDiscoverResponse("img-tool")),
          text: () => Promise.resolve(""),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("/tools/execute")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(binaryResponse),
          text: () => Promise.resolve(JSON.stringify(binaryResponse)),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("oss.qveris.ai")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.resolve(pngSignature.buffer.slice(0)),
          headers: new Headers({ "content-type": "image/png" }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(""),
        headers: new Headers(),
      });
    });
    globalThis.fetch = fetchMock;
    const tools = createQverisTools({
      config: makeConfig({ autoMaterializeFullContent: true }),
      workspaceDir: tmpDir,
    });
    await registerToolViaDiscover(tools, "img-tool");
    const invoke = tools.find((t) => t.name === "qveris_call")!;

    const result = await invoke.execute("call-1", {
      tool_id: "img-tool",
      params_to_tool: '{"q": "chart"}',
    });

    const parsed = parseToolResult(result);
    const mc = parsed.materialized_content as Record<string, unknown>;
    expect(mc.status).toBe("ready");
    expect(mc.content_category).toBe("image");
    expect(mc.mime_type).toBe("image/png");
    expect(typeof mc.path).toBe("string");
    expect(String(mc.path)).toContain(".png");
    expect(mc.consumption_contract).toContain("Binary file saved");
    // No text analysis for binary
    expect(mc.analysis).toBeUndefined();
    expect(mc.preview).toBeUndefined();

    // Verify the binary is byte-for-byte intact on disk
    const filePath = path.join(tmpDir, mc.path as string);
    const written = await fsp.readFile(filePath);
    expect(new Uint8Array(written)).toEqual(pngSignature);
  });

  it("rejects download when content is truncated by byte limit", async () => {
    const largeContent = "x".repeat(200);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/search")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makeDiscoverResponse("big-tool")),
          text: () => Promise.resolve(""),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("/tools/execute")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(TRUNCATED_INVOKE_RESPONSE),
          text: () => Promise.resolve(JSON.stringify(TRUNCATED_INVOKE_RESPONSE)),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("oss.qveris.ai")) {
        const encoder = new TextEncoder();
        const fullBytes = encoder.encode(largeContent);
        return Promise.resolve({
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(fullBytes);
              controller.close();
            },
          }),
          headers: new Headers({ "content-type": "application/json" }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(""),
        headers: new Headers(),
      });
    });
    globalThis.fetch = fetchMock;
    const tools = createQverisTools({
      config: makeConfig({ autoMaterializeFullContent: true, fullContentMaxBytes: 50 }),
      workspaceDir: tmpDir,
    });
    await registerToolViaDiscover(tools, "big-tool");
    const invoke = tools.find((t) => t.name === "qveris_call")!;

    const result = await invoke.execute("call-1", {
      tool_id: "big-tool",
      params_to_tool: '{"q": "test"}',
    });

    const parsed = parseToolResult(result);
    const mc = parsed.materialized_content as Record<string, unknown>;
    expect(mc.status).toBe("failed");
    expect(mc.reason).toBe("download_truncated");
    expect(String(mc.detail)).toContain("truncated");
  });

  it("whitelist includes baseUrl domain when it differs from region", async () => {
    const cnUrlResponse = {
      ...TRUNCATED_INVOKE_RESPONSE,
      result: {
        ...TRUNCATED_INVOKE_RESPONSE.result,
        full_content_file_url: "https://oss.qveris.cn/full-content/exec-trunc-1.json",
      },
    };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/search")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makeDiscoverResponse("cn-tool")),
          text: () => Promise.resolve(""),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("/tools/execute")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(cnUrlResponse),
          text: () => Promise.resolve(JSON.stringify(cnUrlResponse)),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("oss.qveris.cn")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(FULL_CONTENT_JSON),
          headers: new Headers({ "content-type": "application/json" }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(""),
        headers: new Headers(),
      });
    });
    globalThis.fetch = fetchMock;
    // region=global but baseUrl points to qveris.cn → whitelist should include both
    const tools = createQverisTools({
      config: makeConfig({
        autoMaterializeFullContent: true,
        baseUrl: "https://qveris.cn/api/v1",
        region: "global",
      }),
      workspaceDir: tmpDir,
    });
    await registerToolViaDiscover(tools, "cn-tool");
    const invoke = tools.find((t) => t.name === "qveris_call")!;

    const result = await invoke.execute("call-1", {
      tool_id: "cn-tool",
      params_to_tool: '{"q": "test"}',
    });

    const parsed = parseToolResult(result);
    const mc = parsed.materialized_content as Record<string, unknown>;
    expect(mc.status).toBe("ready");
    expect(mc.content_category).toBe("json");
  });

  it("reclassifies application/octet-stream as JSON when content looks like JSON", async () => {
    const octetStreamResponse = {
      ...TRUNCATED_INVOKE_RESPONSE,
      result: {
        ...TRUNCATED_INVOKE_RESPONSE.result,
        full_content_file_url: "https://oss.qveris.ai/data/result.bin",
      },
    };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/search")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makeDiscoverResponse("generic-tool")),
          text: () => Promise.resolve(""),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("/tools/execute")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(octetStreamResponse),
          text: () => Promise.resolve(JSON.stringify(octetStreamResponse)),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("oss.qveris.ai")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(FULL_CONTENT_JSON),
          headers: new Headers({ "content-type": "application/octet-stream" }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(""),
        headers: new Headers(),
      });
    });
    globalThis.fetch = fetchMock;
    const tools = createQverisTools({
      config: makeConfig({ autoMaterializeFullContent: true }),
      workspaceDir: tmpDir,
    });
    await registerToolViaDiscover(tools, "generic-tool");
    const invoke = tools.find((t) => t.name === "qveris_call")!;

    const result = await invoke.execute("call-1", {
      tool_id: "generic-tool",
      params_to_tool: '{"q": "test"}',
    });

    const parsed = parseToolResult(result);
    const mc = parsed.materialized_content as Record<string, unknown>;
    expect(mc.status).toBe("ready");
    expect(mc.content_category).toBe("json");
    expect(mc.mime_type).toBe("application/json");
    expect(mc.analysis).toBeDefined();
    expect(typeof mc.path).toBe("string");
    expect(String(mc.path)).toContain(".json");
  });

  it("keeps application/octet-stream binary payloads byte-for-byte intact", async () => {
    const binaryPayload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]);
    const octetStreamResponse = {
      ...TRUNCATED_INVOKE_RESPONSE,
      result: {
        ...TRUNCATED_INVOKE_RESPONSE.result,
        full_content_file_url: "https://oss.qveris.ai/data/raw.bin",
      },
    };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/search")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makeDiscoverResponse("binary-tool")),
          text: () => Promise.resolve(""),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("/tools/execute")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(octetStreamResponse),
          text: () => Promise.resolve(JSON.stringify(octetStreamResponse)),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("oss.qveris.ai")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(binaryPayload);
              controller.close();
            },
          }),
          headers: new Headers({ "content-type": "application/octet-stream" }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(""),
        headers: new Headers(),
      });
    });
    globalThis.fetch = fetchMock;
    const tools = createQverisTools({
      config: makeConfig({ autoMaterializeFullContent: true }),
      workspaceDir: tmpDir,
    });
    await registerToolViaDiscover(tools, "binary-tool");
    const invoke = tools.find((t) => t.name === "qveris_call")!;

    const result = await invoke.execute("call-1", {
      tool_id: "binary-tool",
      params_to_tool: '{"q": "test"}',
    });

    const parsed = parseToolResult(result);
    const mc = parsed.materialized_content as Record<string, unknown>;
    expect(mc.status).toBe("ready");
    expect(mc.content_category).toBe("binary");
    expect(mc.mime_type).toBe("application/octet-stream");
    expect(mc.analysis).toBeUndefined();
    expect(mc.preview).toBeUndefined();

    const filePath = path.join(tmpDir, mc.path as string);
    const written = await fsp.readFile(filePath);
    expect(new Uint8Array(written)).toEqual(binaryPayload);
  });

  it("does not truncate when file size exactly equals maxBytes", async () => {
    const exactContent = "x".repeat(100);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/search")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makeDiscoverResponse("exact-tool")),
          text: () => Promise.resolve(""),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("/tools/execute")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(TRUNCATED_INVOKE_RESPONSE),
          text: () => Promise.resolve(JSON.stringify(TRUNCATED_INVOKE_RESPONSE)),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("oss.qveris.ai")) {
        const encoder = new TextEncoder();
        const fullBytes = encoder.encode(exactContent);
        return Promise.resolve({
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(fullBytes);
              controller.close();
            },
          }),
          headers: new Headers({ "content-type": "text/plain" }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(""),
        headers: new Headers(),
      });
    });
    globalThis.fetch = fetchMock;
    const tools = createQverisTools({
      config: makeConfig({ autoMaterializeFullContent: true, fullContentMaxBytes: 100 }),
      workspaceDir: tmpDir,
    });
    await registerToolViaDiscover(tools, "exact-tool");
    const invoke = tools.find((t) => t.name === "qveris_call")!;

    const result = await invoke.execute("call-1", {
      tool_id: "exact-tool",
      params_to_tool: '{"q": "test"}',
    });

    const parsed = parseToolResult(result);
    const mc = parsed.materialized_content as Record<string, unknown>;
    expect(mc.status).toBe("ready");
    expect(mc.content_category).toBe("text");
    expect(mc.file_bytes).toBe(100);
  });

  it("materializes binary via ReadableStream (getReader path)", async () => {
    const binaryPayload = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const binaryResponse = {
      ...TRUNCATED_INVOKE_RESPONSE,
      result: {
        ...TRUNCATED_INVOKE_RESPONSE.result,
        full_content_file_url: "https://oss.qveris.ai/images/photo.jpg",
      },
    };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/search")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makeDiscoverResponse("jpeg-tool")),
          text: () => Promise.resolve(""),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("/tools/execute")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(binaryResponse),
          text: () => Promise.resolve(JSON.stringify(binaryResponse)),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("oss.qveris.ai")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(binaryPayload);
              controller.close();
            },
          }),
          headers: new Headers({ "content-type": "image/jpeg" }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(""),
        headers: new Headers(),
      });
    });
    globalThis.fetch = fetchMock;
    const tools = createQverisTools({
      config: makeConfig({ autoMaterializeFullContent: true }),
      workspaceDir: tmpDir,
    });
    await registerToolViaDiscover(tools, "jpeg-tool");
    const invoke = tools.find((t) => t.name === "qveris_call")!;

    const result = await invoke.execute("call-1", {
      tool_id: "jpeg-tool",
      params_to_tool: '{"q": "photo"}',
    });

    const parsed = parseToolResult(result);
    const mc = parsed.materialized_content as Record<string, unknown>;
    expect(mc.status).toBe("ready");
    expect(mc.content_category).toBe("image");
    expect(String(mc.path)).toContain(".jpg");

    const filePath = path.join(tmpDir, mc.path as string);
    const written = await fsp.readFile(filePath);
    expect(new Uint8Array(written)).toEqual(binaryPayload);
  });

  it("handles non-JSON full content (text/csv)", async () => {
    const csvContent = "name,age,city\nAlice,30,NYC\nBob,25,LA\nCharlie,35,SF";
    const csvResponse = {
      ...TRUNCATED_INVOKE_RESPONSE,
      result: {
        ...TRUNCATED_INVOKE_RESPONSE.result,
        full_content_file_url: "https://oss.qveris.ai/data.csv",
      },
    };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/search")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makeDiscoverResponse("csv-tool")),
          text: () => Promise.resolve(""),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("/tools/execute")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(csvResponse),
          text: () => Promise.resolve(JSON.stringify(csvResponse)),
          headers: new Headers(),
        });
      }
      if (typeof url === "string" && url.includes("oss.qveris.ai")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(csvContent),
          headers: new Headers({ "content-type": "text/csv" }),
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
    const tools = createQverisTools({
      config: makeConfig({ autoMaterializeFullContent: true }),
      workspaceDir: tmpDir,
    });
    await registerToolViaDiscover(tools, "csv-tool");
    const invoke = tools.find((t) => t.name === "qveris_call")!;

    const result = await invoke.execute("call-1", {
      tool_id: "csv-tool",
      params_to_tool: '{"q": "test"}',
    });

    const parsed = parseToolResult(result);
    const mc = parsed.materialized_content as Record<string, unknown>;
    expect(mc.status).toBe("ready");
    expect(mc.content_category).toBe("csv");
    expect(mc.mime_type).toContain("csv");
    const analysis = (mc as { analysis?: Record<string, unknown> }).analysis;
    expect(analysis?.line_count).toBe(4);
    expect(analysis?.column_names).toEqual(["name", "age", "city"]);
  });
});
