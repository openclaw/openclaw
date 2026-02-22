import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";

vi.mock("../../infra/net/fetch-guard.js", () => {
  return {
    fetchWithSsrFGuard: vi.fn(async () => {
      throw new Error("network down");
    }),
  };
});

describe("web_fetch firecrawl apiKey normalization", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    global.fetch = priorFetch;
    vi.restoreAllMocks();
  });

  it("strips embedded CR/LF before sending Authorization header", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : "";
      expect(url).toContain("/v2/scrape");

      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      expect(auth).toBe("Bearer firecrawl-test-key");

      return new Response(
        JSON.stringify({
          success: true,
          data: { markdown: "ok", metadata: { title: "t" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    global.fetch = withFetchPreconnect(fetchSpy);

    const { createWebFetchTool } = await import("./web-tools.js");
    const tool = createWebFetchTool({
      config: {
        tools: {
          web: {
            fetch: {
              cacheTtlMinutes: 0,
              firecrawl: { apiKey: "firecrawl-test-\r\nkey" },
              readability: false,
            },
          },
        },
      },
    });

    const result = await tool?.execute?.("call", {
      url: "https://example.com",
      extractMode: "text",
    });
    expect(result?.details).toMatchObject({ extractor: "firecrawl" });
    expect(fetchSpy).toHaveBeenCalled();
  });
});
