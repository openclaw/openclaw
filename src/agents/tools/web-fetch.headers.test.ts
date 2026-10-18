import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as logger from "../../logger.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import "./web-fetch.test-mocks.js";
import { createWebFetchTool } from "./web-fetch.js";
import * as webGuardedFetch from "./web-guarded-fetch.js";

const lookupMock = vi.fn();

function setResponse(body: string, contentType = "text/markdown; charset=utf-8") {
  const fetchSpy = vi
    .fn()
    .mockResolvedValue(new Response(body, { headers: { "content-type": contentType } }));
  global.fetch = withFetchPreconnect(fetchSpy);
  return fetchSpy;
}

function createToolWithHeaders(
  headers: Record<string, string> = {},
  cacheTtlMinutes = 0,
): ReturnType<typeof createWebFetchTool> {
  return createWebFetchTool({
    lookupFn: lookupMock,
    config: { tools: { web: { fetch: { cacheTtlMinutes, headers } } } },
  });
}

function fetchHeaders(headers: Record<string, string>, path: string, cacheTtlMinutes = 0) {
  return createToolWithHeaders(headers, cacheTtlMinutes)?.execute?.("call", {
    url: `https://example.com/${path}`,
  });
}

function getRequestHeaders(
  fetchSpy: ReturnType<typeof vi.fn>,
  callIndex = 0,
): Record<string, string> {
  const call = fetchSpy.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected fetch call at index ${callIndex}`);
  }
  return (call[1] as { headers?: Record<string, string> } | undefined)?.headers ?? {};
}

describe("web_fetch headers and response extraction", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    global.fetch = priorFetch;
    lookupMock.mockReset();
    vi.restoreAllMocks();
  });

  it("sends configured headers with the direct fetch request", async () => {
    const fetchSpy = setResponse("# Routed");
    const fetchWithRealGuard = webGuardedFetch.fetchWithWebToolsNetworkGuard;
    const guardedFetchSpy = vi
      .spyOn(webGuardedFetch, "fetchWithWebToolsNetworkGuard")
      .mockImplementation((params) => fetchWithRealGuard(params));

    const headers = {
      "ATL-SG-SERVICE-INJECTION-URL": "http://host.docker.internal:9999",
      Authorization: "Bearer deployment-token",
      Cookie: "session=deployment-session",
      "X-Api-Key": "deployment-api-key",
      "X-Tokenizer-Version": "v2",
      "X-Trace-Token": "trace-context",
    };
    await fetchHeaders(headers, "routed");

    expect(getRequestHeaders(fetchSpy)).toMatchObject(headers);
    const captureMeta = guardedFetchSpy.mock.calls[0]?.[0].capture;
    expect(captureMeta === false ? undefined : captureMeta?.sensitiveRequestHeaderNames).toEqual([
      "ATL-SG-SERVICE-INJECTION-URL",
      "Authorization",
      "Cookie",
      "X-Api-Key",
      "X-Tokenizer-Version",
      "X-Trace-Token",
    ]);
  });

  it("refuses fetch-owned and framing headers", async () => {
    const fetchSpy = setResponse("# Connection");
    const result = await fetchHeaders(
      {
        accept: "text/plain",
        "user-agent": "operator-agent/1.0",
        "Accept-Language": "de-DE",
        "Sec-Fetch-Mode": "same-origin",
        Upgrade: "h2c",
        Expect: "100-continue",
        "Keep-Alive": "timeout=5",
        "Transfer-Encoding": "chunked",
        Host: "elsewhere.example",
        Connection: "close",
        "Content-Length": "0",
        "X-Routing-Target": "staging",
      },
      "connection",
    );

    expect((result?.details as { status?: number } | undefined)?.status).toBe(200);
    expect(Object.keys(getRequestHeaders(fetchSpy))).toEqual([
      "Accept",
      "User-Agent",
      "Accept-Language",
      "X-Routing-Target",
    ]);
  });

  it("normalizes empty values without retaining a stale case-colliding value", async () => {
    const fetchSpy = setResponse("# Normalized");

    await fetchHeaders(
      {
        "X-Presence-Flag": " \t ",
        "X-Routing-Target": "staging",
        "x-routing-target": "東京",
      },
      "normalized",
    );

    const headers = getRequestHeaders(fetchSpy);
    expect(headers["X-Presence-Flag"]).toBe("");
    expect(headers["X-Routing-Target"]).toBeUndefined();
    expect(headers["x-routing-target"]).toBeUndefined();
  });

  it("still fetches when every configured header is unusable, naming it in a warning", async () => {
    const fetchSpy = setResponse("# Survives");
    const warnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});

    const invalidName = "X-Bad\n[forged]\u001b[31m";
    const result = await fetchHeaders(
      {
        "X-Survives-Unicode": "東京",
        [invalidName]: "ignored",
      },
      "survives",
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((result?.details as { status?: number } | undefined)?.status).toBe(200);
    const warned = warnSpy.mock.calls
      .map(([message]) => message)
      .filter((message) => message.includes("X-Survives-Unicode"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).not.toContain("東京");
    const invalidNameWarning = warnSpy.mock.calls
      .map(([message]) => message)
      .find((message) => message.includes("X-Bad"));
    expect(invalidNameWarning).toContain(JSON.stringify(invalidName));
    expect(invalidNameWarning).not.toContain("\n");
    expect(invalidNameWarning).not.toContain("\u001b");
  });

  it("partitions the fetch cache by configured headers", async () => {
    const fetchSpy = setResponse("# Cached");
    const fetchPort = (port: number) =>
      fetchHeaders(
        { "ATL-SG-SERVICE-INJECTION-URL": `http://host.docker.internal:${port}` },
        "cache-partition",
        15,
      );
    await fetchPort(9999);
    await fetchPort(8888);
    await fetchPort(9999);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(getRequestHeaders(fetchSpy, 1)["ATL-SG-SERVICE-INJECTION-URL"]).toBe(
      "http://host.docker.internal:8888",
    );
  });

  it("does not partition the cache for headers the request never carries", async () => {
    const fetchSpy = setResponse("# Unpartitioned");
    const fetchCached = (headers: Record<string, string>) =>
      fetchHeaders(headers, "cache-unpartitioned", 15);
    await fetchCached({});
    await fetchCached({ accept: "text/plain" });
    await fetchCached({ "X Invalid Name": "dropped", "Transfer-Encoding": "chunked" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("handles structured +json subtypes as JSON", async () => {
    setResponse('{"patch":true}', "Application/JSON-Patch+JSON");

    const result = await fetchHeaders({}, "json-patch");
    const details = result?.details as
      | { extractor?: string; contentType?: string; text?: string }
      | undefined;
    expect(details).toMatchObject({
      extractor: "json",
      contentType: "application/json-patch+json",
    });
    expect(details?.text).toContain('"patch": true');
  });

  it("bypasses Firecrawl when runtime metadata marks Firecrawl inactive", async () => {
    const fetchSpy = setResponse(
      "<html><body><article><h1>Runtime Off</h1><p>Use direct fetch.</p></article></body></html>",
      "text/html; charset=utf-8",
    );
    const webFetch = {
      apiKey: { source: "env" as const, provider: "default", id: "MISSING_FIRECRAWL_KEY_REF" },
    };
    const tool = createWebFetchTool({
      lookupFn: lookupMock,
      config: {
        plugins: { entries: { firecrawl: { config: { webFetch } } } },
        tools: { web: { fetch: { provider: "firecrawl" } } },
      },
      sandboxed: false,
      runtimeWebFetch: {
        providerConfigured: "firecrawl",
        providerSource: "configured",
        diagnostics: [],
      },
    });

    await tool?.execute?.("call", { url: "https://example.com/runtime-firecrawl-off" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://example.com/runtime-firecrawl-off");
  });

  it("converts markdown to text when extractMode is text", async () => {
    setResponse("# Heading\n\n**Bold text** and [a link](https://example.com).");
    const result = await createToolWithHeaders()?.execute?.("call", {
      url: "https://example.com/text-mode",
      extractMode: "text",
    });
    const details = result?.details as
      | { extractor?: string; extractMode?: string; text?: string }
      | undefined;
    expect(details).toMatchObject({ extractor: "cf-markdown", extractMode: "text" });
    expect(details?.text).not.toContain("# Heading");
    expect(details?.text).toContain("Heading");
    expect(details?.text).not.toContain("[a link](https://example.com)");
  });
});
