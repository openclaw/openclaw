import { describe, expect, it, vi } from "vitest";
import * as logger from "../../logger.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import {
  createBaseWebFetchToolConfig,
  installWebFetchSsrfHarness,
  makeFetchHeaders,
} from "./web-fetch.test-harness.js";
import "./web-fetch.test-mocks.js";
import { createWebFetchTool } from "./web-tools.js";

const baseToolConfig = createBaseWebFetchToolConfig();
installWebFetchSsrfHarness();

function markdownResponse(body: string, extraHeaders: Record<string, string> = {}): Response {
  return {
    ok: true,
    status: 200,
    headers: makeFetchHeaders({
      "content-type": "text/markdown; charset=utf-8",
      ...extraHeaders,
    }),
    text: async () => body,
  } as Response;
}

function htmlResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    headers: makeFetchHeaders({ "content-type": "text/html; charset=utf-8" }),
    text: async () => body,
  } as Response;
}

describe("web_fetch Cloudflare Markdown for Agents", () => {
  it("sends Accept header preferring text/markdown", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Test Page\n\nHello world."));
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createWebFetchTool(baseToolConfig);

    await tool?.execute?.("call", { url: "https://example.com/page" });

    expect(fetchSpy).toHaveBeenCalled();
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers.Accept).toBe("text/markdown, text/html;q=0.9, */*;q=0.1");
  });

  it("uses cf-markdown extractor for text/markdown responses", async () => {
    const md = "# CF Markdown\n\nThis is server-rendered markdown.";
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse(md));
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createWebFetchTool(baseToolConfig);

    const result = await tool?.execute?.("call", { url: "https://example.com/cf" });
    const details = result?.details as
      | { status?: number; extractor?: string; contentType?: string; text?: string }
      | undefined;
    expect(details).toMatchObject({
      status: 200,
      extractor: "cf-markdown",
      contentType: "text/markdown",
    });
    // The body should contain the original markdown (wrapped with security markers)
    expect(details?.text).toContain("CF Markdown");
    expect(details?.text).toContain("server-rendered markdown");
  });

  it("falls back to readability for text/html responses", async () => {
    const html =
      "<html><body><article><h1>HTML Page</h1><p>Content here.</p></article></body></html>";
    const fetchSpy = vi.fn().mockResolvedValue(htmlResponse(html));
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createWebFetchTool(baseToolConfig);

    const result = await tool?.execute?.("call", { url: "https://example.com/html" });
    const details = result?.details as { extractor?: string; contentType?: string } | undefined;
    expect(details?.extractor).toBe("readability");
    expect(details?.contentType).toBe("text/html");
  });

  it("bypasses Firecrawl when runtime metadata marks Firecrawl inactive", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        htmlResponse(
          "<html><body><article><h1>Runtime Off</h1><p>Use direct fetch.</p></article></body></html>",
        ),
      );
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createWebFetchTool({
      config: {
        tools: {
          web: {
            fetch: {
              firecrawl: {
                enabled: true,
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "MISSING_FIRECRAWL_KEY_REF",
                },
              },
            },
          },
        },
      },
      sandboxed: false,
      runtimeFirecrawl: {
        active: false,
        apiKeySource: "secretRef", // pragma: allowlist secret
        diagnostics: [],
      },
    });

    await tool?.execute?.("call", { url: "https://example.com/runtime-firecrawl-off" });

    expect(fetchSpy).toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://example.com/runtime-firecrawl-off");
  });

  it("logs x-markdown-tokens when header is present", async () => {
    const logSpy = vi.spyOn(logger, "logDebug").mockImplementation(() => {});
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(markdownResponse("# Tokens Test", { "x-markdown-tokens": "1500" }));
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createWebFetchTool(baseToolConfig);

    await tool?.execute?.("call", { url: "https://example.com/tokens/private?token=secret" });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("x-markdown-tokens: 1500 (https://example.com/...)"),
    );
    const tokenLogs = logSpy.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("x-markdown-tokens"));
    expect(tokenLogs).toHaveLength(1);
    expect(tokenLogs[0]).not.toContain("token=secret");
    expect(tokenLogs[0]).not.toContain("/tokens/private");
  });

  it("converts markdown to text when extractMode is text", async () => {
    const md = "# Heading\n\n**Bold text** and [a link](https://example.com).";
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse(md));
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createWebFetchTool(baseToolConfig);

    const result = await tool?.execute?.("call", {
      url: "https://example.com/text-mode",
      extractMode: "text",
    });
    const details = result?.details as
      | { extractor?: string; extractMode?: string; text?: string }
      | undefined;
    expect(details).toMatchObject({
      extractor: "cf-markdown",
      extractMode: "text",
    });
    // Text mode strips header markers (#) and link syntax
    expect(details?.text).not.toContain("# Heading");
    expect(details?.text).toContain("Heading");
    expect(details?.text).not.toContain("[a link](https://example.com)");
  });

  it("does not log x-markdown-tokens when header is absent", async () => {
    const logSpy = vi.spyOn(logger, "logDebug").mockImplementation(() => {});
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# No tokens"));
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createWebFetchTool(baseToolConfig);

    await tool?.execute?.("call", { url: "https://example.com/no-tokens" });

    const tokenLogs = logSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("x-markdown-tokens"),
    );
    expect(tokenLogs).toHaveLength(0);
  });
});
