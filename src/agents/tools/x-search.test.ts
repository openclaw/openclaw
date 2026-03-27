import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { createXSearchTool } from "./x-search.js";

function installXSearchFetch(payload?: Record<string, unknown>) {
  const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve(
          payload ?? {
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "Found X posts",
                    annotations: [{ type: "url_citation", url: "https://x.com/openclaw/status/1" }],
                  },
                ],
              },
            ],
            citations: ["https://x.com/openclaw/status/1"],
          },
        ),
    } as Response),
  );
  global.fetch = withFetchPreconnect(mockFetch);
  return mockFetch;
}

function parseFirstRequestBody(mockFetch: ReturnType<typeof installXSearchFetch>) {
  const request = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
  const requestBody = request?.body;
  return JSON.parse(typeof requestBody === "string" ? requestBody : "{}") as Record<
    string,
    unknown
  >;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("x_search tool", () => {
  it("enables x_search when runtime metadata marks an xAI key active", () => {
    const tool = createXSearchTool({
      config: {},
      runtimeXSearch: {
        active: true,
        apiKeySource: "env",
        diagnostics: [],
      },
    });

    expect(tool?.name).toBe("x_search");
  });

  it("uses the xAI Responses x_search tool with structured filters", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        tools: {
          web: {
            x_search: {
              apiKey: "xai-config-test", // pragma: allowlist secret
              model: "grok-4-1-fast-non-reasoning",
              maxTurns: 2,
            },
          },
        },
      },
    });

    const result = await tool?.execute?.("x-search:1", {
      query: "dinner recipes",
      allowed_x_handles: ["openclaw"],
      excluded_x_handles: ["spam"],
      from_date: "2026-03-01",
      to_date: "2026-03-20",
      enable_image_understanding: true,
    });

    expect(mockFetch).toHaveBeenCalled();
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("api.x.ai/v1/responses");
    const body = parseFirstRequestBody(mockFetch);
    expect(body.model).toBe("grok-4-1-fast-non-reasoning");
    expect(body.max_turns).toBe(2);
    expect(body.tools).toEqual([
      {
        type: "x_search",
        allowed_x_handles: ["openclaw"],
        excluded_x_handles: ["spam"],
        from_date: "2026-03-01",
        to_date: "2026-03-20",
        enable_image_understanding: true,
      },
    ]);
    expect((result?.details as { citations?: string[] } | undefined)?.citations).toEqual([
      "https://x.com/openclaw/status/1",
    ]);
  });

  it("rejects invalid date ordering before calling xAI", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        tools: {
          web: {
            x_search: {
              apiKey: "xai-config-test", // pragma: allowlist secret
            },
          },
        },
      },
    });

    await expect(
      tool?.execute?.("x-search:bad-dates", {
        query: "dinner recipes",
        from_date: "2026-03-20",
        to_date: "2026-03-01",
      }),
    ).rejects.toThrow(/from_date must be on or before to_date/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
