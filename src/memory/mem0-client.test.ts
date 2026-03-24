import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Mem0Client } from "./mem0-client.js";

describe("Mem0Client", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // ─── addMemory ───────────────────────────────────────────────────────────────

  it("adds a memory successfully — uses localhost default URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "123" }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const client = new Mem0Client("test-api-key");
    await client.addMemory("I love TypeScript for agent development", "user-1", "agent-1");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/v1/memories/",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Token test-api-key",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "I love TypeScript for agent development" }],
          user_id: "user-1",
          agent_id: "agent-1",
          output_format: "v1.1",
        }),
      }),
    );
  });

  it("strips trailing slash from custom baseUrl", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    global.fetch = mockFetch as unknown as typeof fetch;

    const client = new Mem0Client("key", "http://my-server:9000/v1/");
    await client.addMemory("test", "u", "a");

    expect(mockFetch).toHaveBeenCalledWith("http://my-server:9000/v1/memories/", expect.anything());
  });

  it("throws on addMemory API failure", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const client = new Mem0Client("key");
    await expect(client.addMemory("data", "u", "a")).rejects.toThrowError(
      "Mem0 API Error [500]: Internal Server Error",
    );
  });

  // ─── searchMemories ───────────────────────────────────────────────────────────

  it("searches memory and formats OpenClaw MemorySearchResult correctly", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "mem-abc", memory: "User has a strong preference for TS.", score: 0.92 },
      ],
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const client = new Mem0Client("test-api-key", "http://localhost:8080/v1/");
    const results = await client.searchMemories("preferred lang", "user-1", "agent-1", 5);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      path: "mem0://mem-abc",
      snippet: "User has a strong preference for TS.",
      score: 0.92,
      source: "memory",
      citation: "[Mem0 Semantic Knowledge]",
      startLine: 1,
      endLine: 1,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/v1/memories/search/",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          query: "preferred lang",
          user_id: "user-1",
          agent_id: "agent-1",
          limit: 5,
          output_format: "v1.1",
        }),
      }),
    );
  });

  it("returns empty array when search yields no results", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const client = new Mem0Client("key");
    const results = await client.searchMemories("unknown topic", "u", "a");

    expect(results).toEqual([]);
  });

  it("throws standard error on search API failure", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const client = new Mem0Client("bad-key");
    await expect(client.searchMemories("query", "u", "a")).rejects.toThrowError(
      "Mem0 API Error [401]: Unauthorized",
    );
  });

  it("uses cloud API URL when explicitly set in config", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    global.fetch = mockFetch as unknown as typeof fetch;

    const client = new Mem0Client("cloud-key", "https://api.mem0.ai/v1");
    await client.searchMemories("test", "u", "a");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.mem0.ai/v1/memories/search/",
      expect.anything(),
    );
  });
});
