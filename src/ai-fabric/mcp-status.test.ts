import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpStatusParams } from "./mcp-status.js";
import type { McpServer, McpServerStatus } from "./types.js";
import { getMcpServerStatus, mapMcpServerHealth } from "./mcp-status.js";

// ---------------------------------------------------------------------------
// Mock fetch helper (same pattern as agent-status.test.ts)
// ---------------------------------------------------------------------------

const IAM_TOKEN_RESPONSE = {
  token: "iam-jwt-token-abc",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

function createMockFetch(
  responses: Array<{ status: number; body?: unknown }>,
): ReturnType<typeof vi.fn> {
  const impl = vi.fn();
  for (const response of responses) {
    impl.mockResolvedValueOnce({
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: () => Promise.resolve(response.body),
      text: () => Promise.resolve(JSON.stringify(response.body ?? {})),
      headers: new Headers(),
    });
  }
  return impl;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMcpServer(overrides: Partial<McpServer> & { id: string; name: string }): McpServer {
  return {
    status: "RUNNING",
    tools: [],
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const BASE_PARAMS: Omit<McpStatusParams, "fetchImpl"> = {
  projectId: "proj-123",
  auth: { keyId: "test-key-id", secret: "test-secret" },
  baseUrl: "https://test-api.example.com/api/v1",
  iamUrl: "https://iam.test/token",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mapMcpServerHealth", () => {
  it("maps RUNNING to healthy", () => {
    expect(mapMcpServerHealth("RUNNING")).toBe("healthy");
  });

  it("maps AVAILABLE to healthy", () => {
    expect(mapMcpServerHealth("AVAILABLE")).toBe("healthy");
  });

  it("maps degraded statuses correctly", () => {
    const degraded: McpServerStatus[] = [
      "COOLED",
      "SUSPENDED",
      "ON_SUSPENDING",
      "ON_RESOURCE_ALLOCATION",
      "WAITING_FOR_SCRAPPING",
    ];
    for (const status of degraded) {
      expect(mapMcpServerHealth(status)).toBe("degraded");
    }
  });

  it("maps failed statuses correctly", () => {
    const failed: McpServerStatus[] = ["FAILED", "DELETED", "IMAGE_UNAVAILABLE"];
    for (const status of failed) {
      expect(mapMcpServerHealth(status)).toBe("failed");
    }
  });

  it("maps unknown statuses correctly", () => {
    const unknown: McpServerStatus[] = ["UNKNOWN", "ON_DELETION"];
    for (const status of unknown) {
      expect(mapMcpServerHealth(status)).toBe("unknown");
    }
  });
});

describe("getMcpServerStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns healthy MCP servers with correct health mapping", async () => {
    const liveServers: McpServer[] = [
      makeMcpServer({
        id: "mcp-1",
        name: "weather-mcp",
        status: "RUNNING",
        tools: [
          { name: "get_weather", description: "Get weather" },
          { name: "get_forecast", description: "Get forecast" },
        ],
      }),
      makeMcpServer({
        id: "mcp-2",
        name: "search-mcp",
        status: "AVAILABLE",
        tools: [{ name: "search_web", description: "Search the web" }],
      }),
    ];

    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 200, body: { data: liveServers, total: 2 } },
    ]);

    const result = await getMcpServerStatus({
      ...BASE_PARAMS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].health).toBe("healthy");
    expect(result.entries[0].tools).toHaveLength(2);
    expect(result.entries[1].health).toBe("healthy");
    expect(result.summary).toEqual({ total: 2, healthy: 2, degraded: 0, failed: 0, unknown: 0 });
  });

  it("filters out deleted and on-deletion servers", async () => {
    const liveServers: McpServer[] = [
      makeMcpServer({ id: "mcp-1", name: "active-mcp", status: "RUNNING" }),
      makeMcpServer({ id: "mcp-2", name: "deleted-mcp", status: "DELETED" }),
      makeMcpServer({ id: "mcp-3", name: "deleting-mcp", status: "ON_DELETION" }),
    ];

    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 200, body: { data: liveServers, total: 3 } },
    ]);

    const result = await getMcpServerStatus({
      ...BASE_PARAMS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe("active-mcp");
  });

  it("filters servers by name (case-insensitive)", async () => {
    const liveServers: McpServer[] = [
      makeMcpServer({ id: "mcp-1", name: "weather-mcp", status: "RUNNING" }),
      makeMcpServer({ id: "mcp-2", name: "search-mcp", status: "RUNNING" }),
    ];

    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 200, body: { data: liveServers, total: 2 } },
    ]);

    const result = await getMcpServerStatus({
      ...BASE_PARAMS,
      nameFilter: "Weather",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe("weather-mcp");
  });

  it("returns empty entries when filter matches nothing", async () => {
    const liveServers: McpServer[] = [
      makeMcpServer({ id: "mcp-1", name: "weather-mcp", status: "RUNNING" }),
    ];

    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 200, body: { data: liveServers, total: 1 } },
    ]);

    const result = await getMcpServerStatus({
      ...BASE_PARAMS,
      nameFilter: "nonexistent",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.entries).toHaveLength(0);
    expect(result.summary.total).toBe(0);
  });

  it("returns auth error for IAM failure", async () => {
    const fetchImpl = createMockFetch([{ status: 401, body: { message: "invalid credentials" } }]);

    const result = await getMcpServerStatus({
      ...BASE_PARAMS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errorType).toBe("auth");
    expect(result.error).toContain("IAM auth failed");
  });

  it("returns API error for non-auth HTTP errors", async () => {
    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 404, body: { message: "project not found" } },
    ]);

    const result = await getMcpServerStatus({
      ...BASE_PARAMS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errorType).toBe("api");
    expect(result.error).toContain("404");
  });

  it("returns network error for connection failures", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.example.com"), {
      code: "ENOTFOUND",
    });
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(IAM_TOKEN_RESPONSE),
      text: () => Promise.resolve(JSON.stringify(IAM_TOKEN_RESPONSE)),
      headers: new Headers(),
    });
    fetchImpl.mockRejectedValueOnce(new TypeError("fetch failed", { cause }));

    const result = await getMcpServerStatus({
      ...BASE_PARAMS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errorType).toBe("network");
    expect(result.error).toContain("ENOTFOUND");
  });

  it("returns config error when projectId is missing", async () => {
    const result = await getMcpServerStatus({
      ...BASE_PARAMS,
      projectId: "",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errorType).toBe("config");
    expect(result.error).toContain("projectId");
  });

  it("returns config error when credentials are missing", async () => {
    const result = await getMcpServerStatus({
      ...BASE_PARAMS,
      auth: { keyId: "", secret: "" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errorType).toBe("config");
    expect(result.error).toContain("credentials");
  });

  it("computes summary rollup correctly across health states", async () => {
    const liveServers: McpServer[] = [
      makeMcpServer({ id: "mcp-1", name: "running-mcp", status: "RUNNING" }),
      makeMcpServer({ id: "mcp-2", name: "cooled-mcp", status: "COOLED" }),
      makeMcpServer({ id: "mcp-3", name: "failed-mcp", status: "FAILED" }),
      makeMcpServer({ id: "mcp-4", name: "unknown-mcp", status: "UNKNOWN" }),
    ];

    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 200, body: { data: liveServers, total: 4 } },
    ]);

    const result = await getMcpServerStatus({
      ...BASE_PARAMS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.summary).toEqual({
      total: 4,
      healthy: 1,
      degraded: 1,
      failed: 1,
      unknown: 1,
    });
  });

  it("preserves tools metadata on entries", async () => {
    const tools = [
      { name: "get_weather", description: "Get current weather" },
      { name: "get_forecast", description: "Get 5-day forecast" },
      { name: "get_alerts", description: "Get weather alerts" },
    ];

    const liveServers: McpServer[] = [
      makeMcpServer({ id: "mcp-1", name: "weather-mcp", status: "RUNNING", tools }),
    ];

    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 200, body: { data: liveServers, total: 1 } },
    ]);

    const result = await getMcpServerStatus({
      ...BASE_PARAMS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.entries[0].tools).toEqual(tools);
  });
});
