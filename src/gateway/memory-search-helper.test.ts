import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMemorySearch } from "./memory-search-helper.js";

const { loadConfigMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(() => ({
    gateway: {
      mode: "local",
      port: 19001,
      tls: { enabled: false },
      auth: { mode: "none" },
    },
    session: { mainKey: "main" },
    agents: { list: [{ id: "main", default: true }] },
  })),
}));

const { resolveGatewayProbeAuthMock } = vi.hoisted(() => ({
  resolveGatewayProbeAuthMock: vi.fn(() => ({})),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("./probe-auth.js", () => ({
  resolveGatewayProbeAuth: resolveGatewayProbeAuthMock,
}));

describe("fetchMemorySearch", () => {
  beforeEach(() => {
    loadConfigMock.mockClear();
    resolveGatewayProbeAuthMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("posts memory_search to the gateway tools.invoke endpoint and returns raw details", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          result: {
            details: {
              results: [
                {
                  path: "memory/project.md",
                  startLine: 4,
                  endLine: 8,
                  score: 0.72,
                  snippet: "Q3 review notes",
                  source: "memory",
                  citation: "memory/project.md#L4-L8",
                },
              ],
              provider: "openai",
              model: "text-embedding-3-small",
              fallback: { from: "openai" },
            },
          },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchMemorySearch({
        query: "Q3 review",
        agentId: "main",
        url: "ws://127.0.0.1:18789",
        timeoutMs: 8000,
        maxResults: 5,
        minScore: 0.4,
      }),
    ).resolves.toEqual({
      results: [
        {
          path: "memory/project.md",
          startLine: 4,
          endLine: 8,
          score: 0.72,
          snippet: "Q3 review notes",
          source: "memory",
          citation: "memory/project.md#L4-L8",
        },
      ],
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: { from: "openai" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18789/tools/invoke",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      tool: "memory_search",
      args: {
        query: "Q3 review",
        maxResults: 5,
        minScore: 0.4,
      },
      sessionKey: "agent:main:main",
    });
  });

  it("resolves bearer auth for remote gateway requests", async () => {
    resolveGatewayProbeAuthMock.mockReturnValue({ token: "remote-token" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: { details: { results: [] } } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchMemorySearch({
      query: "planning",
      url: "wss://gateway.example.com",
    });

    expect(resolveGatewayProbeAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "remote",
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example.com/tools/invoke",
      expect.objectContaining({
        headers: {
          "content-type": "application/json",
          authorization: "Bearer remote-token",
        },
      }),
    );
  });

  it("propagates auth failures from tools.invoke", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({
          ok: false,
          error: {
            type: "auth_failed",
            message: "missing memory_search permission",
          },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchMemorySearch({
        query: "security",
      }),
    ).rejects.toMatchObject({
      code: "auth_failed",
      message: "missing memory_search permission",
    });
  });

  it("returns unavailable payloads without rewriting them", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          result: {
            details: {
              results: [],
              disabled: true,
              unavailable: true,
              error: "embedding provider timeout",
              warning: "Memory search is unavailable due to an embedding/provider error.",
              action: "Check embedding provider configuration and retry memory_search.",
            },
          },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchMemorySearch({ query: "retry" })).resolves.toEqual({
      results: [],
      disabled: true,
      unavailable: true,
      error: "embedding provider timeout",
      warning: "Memory search is unavailable due to an embedding/provider error.",
      action: "Check embedding provider configuration and retry memory_search.",
    });
  });
});
