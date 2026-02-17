import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudruSimpleClient } from "./cloudru-client-simple.js";
import { CloudruApiError } from "./cloudru-client.js";

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

const BASE_CONFIG = {
  projectId: "proj-123",
  auth: { keyId: "test-key-id", secret: "test-secret" },
  baseUrl: "https://test-api.example.com/api/v1",
  iamUrl: "https://iam.test/token",
};

describe("CloudruSimpleClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exchanges IAM credentials and makes GET requests with Bearer token", async () => {
    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 200, body: { items: [], total: 0 } },
    ]);

    const client = new CloudruSimpleClient({
      ...BASE_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.get<{ items: unknown[]; total: number }>("/mcpServers");

    expect(result).toEqual({ items: [], total: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // First call: IAM token exchange
    const [iamUrl, iamInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(iamUrl).toBe("https://iam.test/token");
    expect(JSON.parse(iamInit.body as string)).toEqual({
      keyId: "test-key-id",
      secret: "test-secret",
    });

    // Second call: API request with IAM token
    const [apiUrl, apiInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(apiUrl).toBe("https://test-api.example.com/api/v1/proj-123/mcpServers");
    expect((apiInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer iam-jwt-token-abc",
    );
  });

  it("caches IAM token across requests", async () => {
    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 200, body: { items: [], total: 0 } },
      { status: 200, body: { items: [], total: 0 } },
    ]);

    const client = new CloudruSimpleClient({
      ...BASE_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.get("/mcpServers");
    await client.get("/mcpServers");

    // IAM exchange should happen only once, but 2 API calls
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://iam.test/token");
    expect(fetchImpl.mock.calls[1][0]).toContain("/mcpServers");
    expect(fetchImpl.mock.calls[2][0]).toContain("/mcpServers");
  });

  it("appends query parameters", async () => {
    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 200, body: { items: [], total: 0 } },
    ]);

    const client = new CloudruSimpleClient({
      ...BASE_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.get("/mcpServers", { search: "test", limit: 10, offset: 0 });

    const [url] = fetchImpl.mock.calls[1] as [string];
    expect(url).toContain("search=test");
    expect(url).toContain("limit=10");
  });

  it("throws CloudruApiError on error responses", async () => {
    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 403, body: { message: "forbidden", code: "FORBIDDEN" } },
    ]);

    const client = new CloudruSimpleClient({
      ...BASE_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    try {
      await client.get("/mcpServers");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CloudruApiError);
      expect((err as CloudruApiError).status).toBe(403);
      expect((err as CloudruApiError).code).toBe("FORBIDDEN");
    }
  });

  it("retries on 429 and 5xx", async () => {
    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 503, body: { message: "service unavailable" } },
      { status: 200, body: { items: [], total: 0 } },
    ]);

    const client = new CloudruSimpleClient({
      ...BASE_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.get<{ items: unknown[]; total: number }>("/mcpServers");

    expect(result).toEqual({ items: [], total: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry on 4xx (except 429)", async () => {
    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 401, body: { message: "unauthorized" } },
    ]);

    const client = new CloudruSimpleClient({
      ...BASE_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.get("/mcpServers")).rejects.toThrow(CloudruApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("listMcpServers returns paginated result", async () => {
    const mcpServers = [
      {
        id: "mcp-1",
        name: "web-search",
        status: "RUNNING",
        tools: [{ name: "search", description: "Search" }],
        createdAt: "2026-01-01",
      },
      { id: "mcp-2", name: "code-exec", status: "AVAILABLE", tools: [], createdAt: "2026-01-02" },
    ];
    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 200, body: { items: mcpServers, total: 2 } },
    ]);

    const client = new CloudruSimpleClient({
      ...BASE_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.listMcpServers();

    expect(result.items).toHaveLength(2);
    expect(result.items[0].name).toBe("web-search");
    expect(result.total).toBe(2);
  });

  it("listAgents returns paginated result with status filter", async () => {
    const agents = [
      {
        id: "agent-1",
        name: "code-assistant",
        status: "RUNNING",
        endpoint: "https://agent-1.example.com",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
      {
        id: "agent-2",
        name: "search-agent",
        status: "RUNNING",
        endpoint: "https://agent-2.example.com",
        createdAt: "2026-01-02",
        updatedAt: "2026-01-02",
      },
    ];
    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 200, body: { items: agents, total: 2 } },
    ]);

    const client = new CloudruSimpleClient({
      ...BASE_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.listAgents({ status: "RUNNING" });

    expect(result.items).toHaveLength(2);
    expect(result.items[0].name).toBe("code-assistant");
    expect(result.items[0].endpoint).toBe("https://agent-1.example.com");
    expect(result.total).toBe(2);

    const [url] = fetchImpl.mock.calls[1] as [string];
    expect(url).toContain("/proj-123/agents");
    expect(url).toContain("status=RUNNING");
  });

  it("omits undefined query values", async () => {
    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 200, body: { items: [], total: 0 } },
    ]);

    const client = new CloudruSimpleClient({
      ...BASE_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.get("/mcpServers", { search: undefined, limit: 20 });

    const [url] = fetchImpl.mock.calls[1] as [string];
    expect(url).not.toContain("search");
    expect(url).toContain("limit=20");
  });

  it("clearAuthCache forces fresh IAM exchange", async () => {
    const fetchImpl = createMockFetch([
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 200, body: { items: [], total: 0 } },
      { status: 200, body: IAM_TOKEN_RESPONSE },
      { status: 200, body: { items: [], total: 0 } },
    ]);

    const client = new CloudruSimpleClient({
      ...BASE_CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.get("/mcpServers");
    client.clearAuthCache();
    await client.get("/mcpServers");

    // Two IAM exchanges + two API calls = 4 total
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
