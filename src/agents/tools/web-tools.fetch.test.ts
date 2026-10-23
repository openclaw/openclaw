import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { EnvHttpProxyAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../../test/helpers/gateway-integration-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { LookupFn } from "../../infra/net/ssrf.js";
import * as ssrf from "../../infra/net/ssrf.js";
import * as logger from "../../logger.js";
import type { WebFetchProviderToolDefinition } from "../../plugin-sdk/provider-web-fetch.js";
import { resolveRequestUrl } from "../../plugin-sdk/request-url.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import * as webGuardedFetch from "./web-guarded-fetch.js";
const { extractReadableContentMock, resolveWebFetchDefinitionMock } = vi.hoisted(() => ({
  extractReadableContentMock: vi.fn(),
  resolveWebFetchDefinitionMock: vi.fn(),
}));

vi.mock("../../web-fetch/content-extractors.runtime.js", () => ({
  extractReadableContent: extractReadableContentMock,
}));
vi.mock("../../web-fetch/runtime.js", () => ({
  resolveWebFetchDefinition: resolveWebFetchDefinitionMock,
}));
import { createWebFetchTool } from "./web-fetch.js";

const WEB_FETCH_SPILL_MAX_CHARS = 2_000_000;
const EMPTY_HTML = "<!doctype html><html><head></head><body></body></html>";

it("declares the exact web_fetch schema and promotes its complete compact hint", () => {
  expect(compactToolOutputHint(createFetchTool()?.outputSchema)).toBe(
    '{ externalContent: { source: "web_fetch"; untrusted: true; wrapped: true; provider?: string }; extractMode: "markdown" | "text"; extractor: string; fetchedAt: string; finalUrl: string; length: number; rawLength: number; status: number; text: string; tookMs: number; truncated: boolean; url: string; cached?: true; contentType?: string; spill?: { chars: number; path: string; truncated?: true }; title?: string; warning?: string }',
  );
});

const lookupMock = vi.fn();

function textResponse(
  text: BodyInit,
  contentType: string | null = "text/plain; charset=utf-8",
  status = 200,
): Response {
  return new Response(text, {
    status,
    headers: contentType ? { "content-type": contentType } : undefined,
  });
}
function installMockFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  const mockFetch = vi.fn(impl);
  global.fetch = withFetchPreconnect(mockFetch);
  return mockFetch;
}

function createFetchTool(
  fetchOverrides: Record<string, unknown> = {},
  hostnameAllowlist?: string[],
) {
  return createWebFetchTool({
    config: { tools: { web: { fetch: { cacheTtlMinutes: 0, ...fetchOverrides } } } },
    sandboxed: false,
    lookupFn: lookupMock as unknown as LookupFn,
    hostnameAllowlistRef: { value: hostnameAllowlist },
  });
}

function installResponse(
  body: BodyInit,
  contentType: string | null = "text/plain; charset=utf-8",
  status = 200,
) {
  return installMockFetch(async () => textResponse(body, contentType, status));
}

function installHtml(html: string) {
  return installResponse(html, "text/html; charset=utf-8");
}

function mockProvider(
  execute: () => Promise<unknown>,
  provider: { id: string; label?: string } = { id: "test-fetch", label: "Test Fetch" },
) {
  resolveWebFetchDefinitionMock.mockReturnValue({
    provider,
    definition: { description: provider.id, parameters: {}, execute },
  });
}

type FetchDetails = {
  text: string;
  title?: string;
  truncated: boolean;
  rawLength: number;
  length: number;
  extractor: string;
  contentType?: string;
  warning?: string;
  spill?: { path: string; chars: number; truncated?: true };
  externalContent: { untrusted: boolean; source: string; wrapped: boolean };
};

async function fetchPage(
  path: string,
  overrides: Record<string, unknown> = { firecrawl: { enabled: false } },
  args: { extractMode?: "text" | "markdown"; maxChars?: number } = {},
) {
  const result = await createFetchTool(overrides)?.execute("call", {
    url: `https://example.com/${path}`,
    ...args,
  });
  return { result, details: result?.details as FetchDetails };
}

async function captureToolErrorMessage(
  path: string,
  overrides: Record<string, unknown> = { firecrawl: { enabled: false } },
) {
  try {
    await fetchPage(path, overrides);
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}

async function abortPendingFetch(reason?: Error) {
  const updates = vi.fn();
  const controller = new AbortController();
  const result = createFetchTool({ firecrawl: { enabled: false } })
    ?.execute("call", { url: "https://example.com/" }, controller.signal, updates)
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  controller.abort(reason);
  await vi.advanceTimersByTimeAsync(5000);
  expect(updates).not.toHaveBeenCalled();
  return await result;
}

const priorFetch = global.fetch;

beforeEach(() => {
  vi.stubEnv("FIRECRAWL_API_KEY", "");
  extractReadableContentMock.mockReset();
  extractReadableContentMock.mockResolvedValue(null);
  resolveWebFetchDefinitionMock.mockReset();
  resolveWebFetchDefinitionMock.mockReturnValue(null);
  lookupMock.mockResolvedValue([
    { address: "93.184.216.34", family: 4 },
    { address: "93.184.216.35", family: 4 },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
  global.fetch = priorFetch;
  lookupMock.mockReset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("web_fetch extraction fallbacks", () => {
  it("disables web_fetch when explicitly disabled", () => {
    expect(createFetchTool({ enabled: false })).toBeNull();
  });

  it("cancels typed progress when fetches finish before the progress threshold", async () => {
    vi.useFakeTimers();
    installResponse("Loaded quickly");
    const updates = vi.fn();
    const tool = createFetchTool({ firecrawl: { enabled: false } });
    expect(tool).toMatchObject({ name: "web_fetch", resultContentSource: "network" });
    await tool?.execute("call", { url: "https://example.com/" }, undefined, updates);
    await vi.advanceTimersByTimeAsync(5000);
    expect(updates).not.toHaveBeenCalled();
  });

  it("cancels typed progress when fetches are aborted", async () => {
    // Abort must stop both the primary fetch and provider fallback; otherwise a
    // cancelled agent turn can keep doing network work in the background.
    vi.useFakeTimers();
    const providerExecute = vi.fn(async () => ({ text: "provider fallback" }));
    mockProvider(providerExecute, { id: "firecrawl" });
    installMockFetch(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return await new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        setTimeout(() => resolve(textResponse("Loaded page")), 6000);
      });
    });
    const error = await abortPendingFetch();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("aborted");
    expect(resolveWebFetchDefinitionMock).not.toHaveBeenCalled();
    expect(providerExecute).not.toHaveBeenCalled();
  });

  it("cancels typed progress when fetch body reads are aborted", async () => {
    vi.useFakeTimers();
    const providerExecute = vi.fn(async () => ({ text: "provider fallback" }));
    mockProvider(providerExecute, { id: "firecrawl" });
    installMockFetch(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial body"));
          const lateTimer = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode("late body"));
            controller.close();
          }, 6000);
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(lateTimer);
              controller.error(new Error("body aborted"));
            },
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
    });
    const error = await abortPendingFetch(new Error("cancelled"));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("cancelled");
    expect(providerExecute).not.toHaveBeenCalled();
  });

  it("keeps fetch execution alive when progress subscribers throw", async () => {
    vi.useFakeTimers();
    installMockFetch(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 6000);
      });
      return textResponse("Loaded page");
    });
    const tool = createFetchTool({ firecrawl: { enabled: false } });
    const onUpdate = vi.fn(() => {
      throw new Error("subscriber failed");
    });
    const resultPromise = tool?.execute(
      "call",
      { url: "https://example.com/" },
      undefined,
      onUpdate,
    );
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(resultPromise).resolves.toBeTruthy();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("honors maxChars even when wrapper overhead exceeds limit", async () => {
    const fullText = "short text";
    installResponse(fullText);

    const { details } = await fetchPage("short", {
      firecrawl: { enabled: false },
      maxChars: 100,
    });

    expect(
      details.text.split("\n\n[Showing truncated web_fetch content.")[0]!.length,
    ).toBeLessThanOrEqual(100);
    expect(details.truncated).toBe(true);
    expect(details.rawLength).toBe(fullText.length);
    expect(details.length).toBe(details.text?.length);
    if (details.spill) {
      await rm(details.spill.path, { force: true });
    }
  });

  it("does not split an emoji at the web_fetch spill file cap", async () => {
    const prefix = "x".repeat(WEB_FETCH_SPILL_MAX_CHARS - 1);
    const fullText = `${prefix}${String.fromCodePoint(0x1f600)}tail`;
    installResponse(fullText);

    const { details } = await fetchPage("spill-utf16", {
      firecrawl: { enabled: false },
      maxChars: 500,
      maxResponseBytes: WEB_FETCH_SPILL_MAX_CHARS + 1_000,
    });

    if (!details.spill) {
      throw new Error("expected spill");
    }

    expect(details.spill.chars).toBe(WEB_FETCH_SPILL_MAX_CHARS - 1);
    expect(details.text).toContain(`Spilled first ${WEB_FETCH_SPILL_MAX_CHARS - 1} chars.`);
    expect(details.spill.truncated).toBe(true);
    const spilledText = await readFile(details.spill.path, "utf8");
    expect(spilledText).toContain(prefix);
    expect(spilledText).not.toContain(String.fromCodePoint(0x1f600));
    expect(spilledText).not.toContain(String.fromCharCode(0xd83d));
    await rm(details.spill.path, { force: true });
  });

  it("marks byte-capped web_fetch spills as partial", async () => {
    const fullText = "z".repeat(40_000);
    installResponse(fullText);

    const { details } = await fetchPage("byte-cap", {
      firecrawl: { enabled: false },
      maxChars: 500,
      maxResponseBytes: 32_000,
    });

    if (!details.spill) {
      throw new Error("expected spill");
    }

    expect(details.text).toContain("Spilled available content from truncated response.");
    expect(details.spill.chars).toBe(32_000);
    expect(details.spill.truncated).toBe(true);
    const spilledText = await readFile(details.spill.path, "utf8");
    expect(spilledText).toMatch(/<<<EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>/);
    expect(spilledText).not.toContain(fullText);
    await rm(details.spill.path, { force: true });
  });

  it("decodes HTML using a meta http-equiv charset before extraction", async () => {
    const encoder = new TextEncoder();
    const japanese = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);
    const responseBytes = new Uint8Array([
      ...encoder.encode(
        '<!doctype html><html><head><meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"><title>',
      ),
      ...japanese,
      ...encoder.encode("</title></head><body><p>"),
      ...japanese,
      ...encoder.encode("</p></body></html>"),
    ]);
    installResponse(responseBytes, "text/html");

    const { details } = await fetchPage("shift-jis", undefined, { extractMode: "text" });
    const output = `${details.title ?? ""}\n${details.text ?? ""}`;

    expect(output).toContain("日本語");
    expect(output).not.toContain("�");
  });

  it("ignores charset text in unrelated meta content", async () => {
    const body =
      '<!doctype html><html><head><meta name="description" content="charset=Shift_JIS"><title>日本語</title></head><body>日本語</body></html>';
    installResponse(new TextEncoder().encode(body), "text/html");

    const { details } = await fetchPage("content-only-charset", undefined, { extractMode: "text" });
    const output = `${details.title ?? ""}\n${details.text ?? ""}`;

    expect(output).toContain("日本語");
  });

  it("caps response bytes and does not hang on endless streams", async () => {
    const chunk = new TextEncoder().encode("<html><body><div>hi</div></body></html>");
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    installResponse(stream, "text/html; charset=utf-8");

    const { details } = await fetchPage("stream", {
      maxResponseBytes: 128,
      firecrawl: { enabled: false },
    });
    expect(details.warning).toContain("Response body incomplete after 32000 bytes");
  });

  it.each([false, true])(
    "uses env proxy dispatch only with explicit trust (%s)",
    async (trusted) => {
      vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
      const mockFetch = installResponse("proxy body");
      const tool = createFetchTool({
        firecrawl: { enabled: false },
        ...(trusted ? { useTrustedEnvProxy: true } : {}),
      });

      await tool?.execute?.("call", { url: "https://example.com/proxy" });

      const dispatcher = (
        mockFetch.mock.calls[0]?.[1] as (RequestInit & { dispatcher?: unknown }) | undefined
      )?.dispatcher;
      if (!dispatcher) {
        throw new Error("expected SSRF dispatcher");
      }
      expect(dispatcher instanceof EnvHttpProxyAgent).toBe(trusted);
    },
  );

  it("falls back to a configured provider when readability returns no content", async () => {
    installHtml(EMPTY_HTML);
    mockProvider(async () => ({ extractor: "test-fetch", text: "provider content" }));

    const { details } = await fetchPage("empty", {});
    expect(details.extractor).toBe("test-fetch");
    expect(details.text).toContain("provider content");
    expect(extractReadableContentMock).toHaveBeenCalledWith({
      html: EMPTY_HTML,
      url: "https://example.com/empty",
      extractMode: "markdown",
      config: expect.any(Object),
    });
  });

  it("throws when readability is disabled and firecrawl is unavailable", async () => {
    installHtml("<html><body>hi</body></html>");

    await expect(
      fetchPage("readability-off", { readability: false, firecrawl: { enabled: false } }),
    ).rejects.toThrow("Readability disabled");
  });

  it("throws when readability is empty and the provider fallback yields no content", async () => {
    installHtml(EMPTY_HTML);
    mockProvider(async () => {
      throw new Error("provider returned no content");
    });

    await expect(fetchPage("readability-empty", {})).rejects.toThrow(
      "Readability, Test Fetch, and basic HTML cleanup returned no content",
    );
  });

  it("uses the provider fallback when direct fetch fails", async () => {
    installResponse("blocked", "text/html", 403);
    mockProvider(async () => ({ extractor: "test-fetch", text: "provider fallback" }));

    const { details } = await fetchPage("blocked", {});
    expect(details.extractor).toBe("test-fetch");
    expect(details.text).toContain("provider fallback");
  });

  it("bounds oversized Readability titles alongside body content", async () => {
    const title = "Page title ".repeat(6_000);
    const body = "Useful page content.";
    installHtml(`<html><head><title>${title}</title></head><body><p>${body}</p></body></html>`);
    extractReadableContentMock.mockResolvedValue({ title, text: body, extractor: "readability" });

    const { result, details } = await fetchPage("title-budget", {}, { maxChars: 1_000 });
    try {
      expect(details.extractor).toBe("readability");
      expect(details.text).toContain(body);
      expect(details.title).toContain("Page title");
      expect(details.title?.length).toBeLessThanOrEqual(400);
      expect(details.text.length + (details.title?.length ?? 0)).toBeLessThanOrEqual(1_000);
      expect(details.truncated).toBe(true);
      expect(details.spill).toBeUndefined();
      const serialized = result?.content.find((block) => block.type === "text");
      expect(serialized?.text.length).toBeLessThan(2_000);
    } finally {
      if (details.spill) {
        await rm(details.spill.path, { force: true });
      }
    }
  });

  it("omits an empty HTML title", async () => {
    installHtml("<html><head><title></title></head><body><p>Useful body.</p></body></html>");
    const { details } = await fetchPage("ordinary-title", {});

    expect(details).not.toHaveProperty("title");
    expect(details.text).toContain("Useful body.");
    expect(details.truncated).toBe(false);
  });

  it("bounds page titles through a real guarded HTTP fetch", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<html><head><title>${"title ".repeat(12_000)}</title></head><body><p>Live HTTP body.</p></body></html>`,
      );
    });
    try {
      const baseUrl = await listenLoopback(server);
      const tool = createWebFetchTool({
        config: {
          tools: {
            web: {
              fetch: { cacheTtlMinutes: 0, ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } },
            },
          },
        },
      });
      const result = await tool?.execute("live-title-budget", {
        url: `${baseUrl}/title`,
        maxChars: 1_000,
      });
      const details = result?.details as FetchDetails;
      expect(details.extractor).toBe("raw-html");
      expect(details.text).toContain("Live HTTP body.");
      expect(details.title).toContain("title");
      expect(details.spill).toBeUndefined();
      const serialized = result?.content.find((block) => block.type === "text");
      expect(serialized?.text.length).toBeLessThan(2_000);
      expect(details.title?.length).toBeLessThanOrEqual(400);
      expect(details.text.length + (details.title?.length ?? 0)).toBeLessThanOrEqual(1_000);
      expect(details.truncated).toBe(true);
    } finally {
      await closeHttpServer(server);
    }
  });

  it.each([
    {
      status: 404,
      title: "Not Found",
      contentType: "Text/HTML; charset=utf-8",
      body: "x".repeat(12_000),
    },
    { status: 500, title: "Oops", contentType: null, body: "" },
  ])(
    "strips HTML errors with content-type $contentType",
    async ({ status, title, contentType, body }) => {
      const html = `<!DOCTYPE HTML><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
      installResponse(contentType ? html : new TextEncoder().encode(html), contentType, status);
      const message = await captureToolErrorMessage(`missing-${status}`);
      expect(message).toContain(`Web fetch failed (${status}):`);
      expect(message).toMatch(/<<<EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>/);
      expect(message).toContain(title);
      expect(message).not.toContain("<html");
      expect(message.length).toBeLessThan(5_000);
    },
  );

  it("extracts HTML bodies when content-type is missing", async () => {
    const html =
      "<!DOCTYPE html><html><head><title>Docs</title><script>track()</script></head><body><p>Visible docs</p><div hidden>secret instructions</div></body></html>";
    installResponse(new TextEncoder().encode(html), null);

    const { details } = await fetchPage("untyped", undefined, { extractMode: "text" });

    expect(details.extractor).toBe("raw-html");
    expect(details.contentType).toBe("text/html");
    expect(details.text).toContain("Visible docs");
    expect(details.text).not.toContain("<html");
    expect(details.text).not.toContain("track()");
    expect(details.text).not.toContain("secret instructions");
  });

  it("keeps untyped non-HTML bodies raw", async () => {
    installResponse(new TextEncoder().encode("plain <b>notes</b>"), null);

    const { details } = await fetchPage("untyped-text");

    expect(details.extractor).toBe("raw");
    expect(details.contentType).toBe("application/octet-stream");
    expect(details.text).toContain("plain <b>notes</b>");
  });

  it("surfaces provider fallback errors when direct fetch throws", async () => {
    installMockFetch(() => Promise.reject(new Error("network down")));
    mockProvider(async () => {
      throw new Error("provider fallback failed");
    });

    await expect(captureToolErrorMessage("provider-error", {})).resolves.toContain(
      "provider fallback failed",
    );
  });
});

const setResponse = (body: string, contentType = "text/markdown; charset=utf-8") =>
  installResponse(body, contentType);

function fetchHeaders(headers: Record<string, string>, path: string, cacheTtlMinutes = 0) {
  const tool = createWebFetchTool({
    lookupFn: lookupMock,
    config: { tools: { web: { fetch: { cacheTtlMinutes, headers } } } },
  });
  return tool?.execute("call", {
    url: `https://example.com/${path}`,
  });
}

function getRequestHeaders(
  fetchSpy: ReturnType<typeof vi.fn>,
  callIndex = 0,
): Record<string, string> {
  const call = fetchSpy.mock.calls[callIndex];
  assert(call, `expected fetch call at index ${callIndex}`);
  return (call[1] as { headers?: Record<string, string> } | undefined)?.headers ?? {};
}

describe("web_fetch headers and response extraction", () => {
  beforeEach(() => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    extractReadableContentMock.mockResolvedValue({
      extractor: "readability",
      title: "HTML Page",
      text: "HTML Page\n\nContent here.",
    });
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
    expect(captureMeta === false ? undefined : captureMeta?.sensitiveRequestHeaderNames).toEqual(
      Object.keys(headers),
    );
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
    expect(result?.details).toMatchObject({
      extractor: "json",
      contentType: "application/json-patch+json",
      text: expect.stringContaining('"patch": true'),
    });
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
});

describe("web_fetch cancellation", () => {
  function fixture(name: string, fallback?: string) {
    const fetch = vi.fn(async () => {
      if (fallback === "network-error") {
        throw new Error("network failed");
      }
      const body = fallback ? "<p>Upstream</p>" : "fresh direct body";
      return new Response(body, {
        status: fallback === "http-error" ? 503 : 200,
        headers: { "content-type": fallback ? "text/html" : "text/plain" },
      });
    });
    vi.stubGlobal("fetch", withFetchPreconnect(fetch));
    const execute = vi
      .fn<WebFetchProviderToolDefinition["execute"]>()
      .mockResolvedValue({ text: "fresh provider body" });
    resolveWebFetchDefinitionMock.mockReturnValue({
      provider: { id: "test-fetch" },
      definition: { execute },
    });
    const options = { cacheTtlMinutes: 1, readability: fallback !== "disabled-readability" };
    const tool = createWebFetchTool({ config: { tools: { web: { fetch: options } } } })!;
    return { fetch, execute, tool, args: { url: `https://example.com/${name}` } };
  }

  it.each([
    { fallback: "network-error", completion: "success" },
    { fallback: "http-error", completion: "failure" },
    { fallback: "empty-readability", completion: "failure" },
    { fallback: "disabled-readability", completion: "failure" },
  ])(
    "rejects late provider $completion without caching after $fallback",
    async ({ fallback, completion }) => {
      const { execute, tool, args } = fixture(
        `cancel-provider-${fallback}-${completion}`,
        fallback,
      );
      const controller = new AbortController();
      const reason = new Error("parent run cancelled");
      const started = createDeferred();
      const pending = createDeferred<Record<string, unknown>>();
      execute.mockImplementationOnce(async () => {
        started.resolve();
        return pending.promise;
      });
      const outcome = Promise.allSettled([tool.execute("cancelled", args, controller.signal)]);
      await started.promise;
      controller.abort(reason);
      if (completion === "success") {
        pending.resolve({ text: "stale provider body" });
      } else {
        pending.reject(new Error("provider cleanup failed"));
      }
      const [cancelled] = await outcome;
      const fresh = await tool.execute("fresh", args);
      const cached = await tool.execute("cached", args);
      const text = expect.stringContaining("fresh provider body");

      // Soft assertions retain both the late-success and cache-poisoning evidence.
      expect.soft(cancelled).toEqual({ status: "rejected", reason });
      expect.soft(fresh.details).not.toHaveProperty("cached");
      expect.soft(fresh.details).toMatchObject({ text });
      expect.soft(execute).toHaveBeenCalledTimes(2);
      expect
        .soft(execute)
        .toHaveBeenNthCalledWith(
          1,
          { ...args, extractMode: "markdown", maxChars: 20_000 },
          { signal: controller.signal },
        );
      expect(cached.details).toMatchObject({ cached: true, text });
    },
  );

  it("rejects a pre-aborted cache hit without invalidating it", async () => {
    const { fetch, execute, tool, args } = fixture("pre-aborted-cache-direct");
    const fresh = await tool.execute("seed", args);
    const reason = new Error("parent already cancelled");
    const outcome = await Promise.allSettled([
      tool.execute("cancelled", args, AbortSignal.abort(reason)),
    ]);
    const cached = await tool.execute("cached", args);

    expect.soft(outcome).toEqual([{ status: "rejected", reason }]);
    assert(isRecord(fresh.details));
    expect(cached.details).toEqual({ ...fresh.details, cached: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(0);
  });

  it("does not publish content if cancelled during guard release", async () => {
    const { fetch, execute, tool, args } = fixture("cancel-during-release-direct");
    const started = createDeferred();
    const released = createDeferred();
    const realGuard = webGuardedFetch.fetchWithWebToolsNetworkGuard;
    vi.spyOn(webGuardedFetch, "fetchWithWebToolsNetworkGuard").mockImplementationOnce(
      async (params) => {
        const result = await realGuard(params);
        return {
          ...result,
          release: async () => {
            await result.release();
            started.resolve();
            await released.promise;
          },
        };
      },
    );
    const controller = new AbortController();
    const reason = new Error("cancelled during release");
    const outcome = Promise.allSettled([tool.execute("cancelled", args, controller.signal)]);
    await started.promise;
    controller.abort(reason);
    released.resolve();
    const [cancelled] = await outcome;
    const fresh = await tool.execute("fresh", args);
    const cached = await tool.execute("cached", args);

    expect.soft(cancelled).toEqual({ status: "rejected", reason });
    expect.soft(fresh.details).not.toHaveProperty("cached");
    expect.soft(fetch).toHaveBeenCalledTimes(2);
    expect.soft(execute).toHaveBeenCalledTimes(0);
    assert(isRecord(fresh.details));
    expect(cached.details).toEqual({ ...fresh.details, cached: true });
  });
});

const setMockFetch = (
  impl: Parameters<typeof installMockFetch>[0] = async () => textResponse(""),
) => installMockFetch(impl);
const firstFetchUrl = (fetchSpy: ReturnType<typeof setMockFetch>) =>
  resolveRequestUrl(fetchSpy.mock.calls[0]![0]);
const redirectResponse = (location: string) =>
  new Response(null, { status: 302, headers: { location } });
function createWebFetchToolForTest(params?: {
  useTrustedEnvProxy?: boolean;
  ssrfPolicy?: ssrf.SsrFPolicy;
  hostnameAllowlist?: string[];
  cacheTtlMinutes?: number;
}) {
  return createFetchTool(
    {
      cacheTtlMinutes: params?.cacheTtlMinutes ?? 0,
      useTrustedEnvProxy: params?.useTrustedEnvProxy,
      ssrfPolicy: params?.ssrfPolicy,
    },
    params?.hostnameAllowlist,
  );
}

async function expectBlockedUrl(
  tool: ReturnType<typeof createWebFetchToolForTest>,
  url: string,
  expectedMessage: RegExp,
) {
  await expect(tool?.execute?.("call", { url })).rejects.toThrow(expectedMessage);
}

async function expectSuccess(tool: ReturnType<typeof createWebFetchToolForTest>, url: string) {
  const result = await tool?.execute?.("call", { url });
  expect(result?.details).toMatchObject({ status: 200, extractor: "raw" });
  return result;
}

describe("web_fetch SSRF protection", () => {
  beforeEach(() => {
    mockProvider(async () => ({ text: "A blocked request must never reach fallback." }));
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const resolvePinnedHostname = ssrf.resolvePinnedHostname;
    vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation((hostname) =>
      resolvePinnedHostname(hostname, lookupMock),
    );
  });

  const domainPolicy = { hostnameAllowlist: ["example.com", "*.example.com"] };
  const privateError = /private|internal|blocked/i;
  it.each([
    { name: "localhost", url: "http://localhost/test", error: /Blocked hostname/i, noDns: true },
    { name: "IPv4 loopback", url: "http://127.0.0.1/test", error: privateError, noDns: true },
    {
      name: "mapped loopback",
      url: "http://[::ffff:127.0.0.1]/",
      error: privateError,
      noDns: true,
    },
    {
      name: "private DNS answer",
      url: "https://private.test/resource",
      address: "10.0.0.5",
      error: privateError,
    },
    {
      name: "private redirect",
      url: "https://example.com",
      redirect: "http://127.0.0.1/secret",
      error: privateError,
    },
    {
      name: "domain policy",
      url: "https://www.nytimes.com/",
      options: domainPolicy,
      error: /domain policy: blocked hostname.*example\.com.*Try a URL on a permitted domain/i,
      noDns: true,
    },
    {
      name: "trusted proxy",
      url: "http://localhost/test",
      options: { useTrustedEnvProxy: true, cacheTtlMinutes: 1 },
      error: /Blocked hostname/i,
      noDns: true,
      proxy: true,
    },
  ] satisfies Array<{
    name: string;
    url: string;
    error: RegExp;
    noDns?: boolean;
    address?: string;
    redirect?: string;
    proxy?: boolean;
    options?: Parameters<typeof createWebFetchToolForTest>[0];
  }>)("blocks $name before a forbidden request", async (test) => {
    if (test.address) {
      lookupMock.mockResolvedValue([{ address: test.address, family: 4 }]);
    }
    if (test.proxy) {
      vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
      vi.stubEnv("http_proxy", "http://127.0.0.1:7890");
    }
    const fetchSpy = setMockFetch();
    if (test.redirect) {
      fetchSpy.mockResolvedValueOnce(redirectResponse(test.redirect));
    }
    await expectBlockedUrl(createWebFetchToolForTest(test.options), test.url, test.error);
    expect(fetchSpy).toHaveBeenCalledTimes(test.redirect ? 1 : 0);
    if (test.noDns) {
      expect(lookupMock).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["http://127.0.0.1/test", { ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } }],
    ["https://example.com/", domainPolicy],
  ] as const)("allows an explicit network policy for %s", async (url, options) => {
    if (url.startsWith("http:")) {
      lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    }
    const fetchSpy = setMockFetch();
    await expectSuccess(createWebFetchToolForTest(options), url);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("does not reuse an unrestricted cache entry across a domain policy", async () => {
    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("cached outside content"));
    const url = "https://outside.test/cached-policy-boundary";
    const unrestricted = createWebFetchToolForTest({ cacheTtlMinutes: 1 });
    await unrestricted?.execute?.("call", { url });
    const restricted = createWebFetchToolForTest({
      ssrfPolicy: { hostnameAllowlist: ["example.com", "*.example.com"] },
      cacheTtlMinutes: 1,
    });

    await expectBlockedUrl(
      restricted,
      url,
      /domain policy: blocked hostname.*example\.com.*Try a URL on a permitted domain/i,
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it.each([
    ["https:// docs.openclaw.ai", "https://docs.openclaw.ai", "https://docs.openclaw.ai/"],
    ["\u00a0\ufeffhttps://example.com", "https://example.com", "https://example.com/"],
    ["https://example.com\n", "https://example.com", "https://example.com/"],
    ["https://example.com/a\u00a0", "https://example.com/a\u00a0", "https://example.com/a%C2%A0"],
    ["https://example.com\u00a0", "https://example.com", "https://example.com/"],
  ])("normalizes %j through web_fetch", async (input, expectedUrl, expectedFetchUrl) => {
    const fetchSpy = setMockFetch().mockResolvedValue(
      new Response("ok", { headers: { "content-type": "text/plain" } }),
    );
    const tool = createWebFetchToolForTest();

    const result = await expectSuccess(tool, input);
    expect(result?.details).toMatchObject({ url: expectedUrl });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(firstFetchUrl(fetchSpy)).toBe(expectedFetchUrl);
  });

  it.each<[string, string, number, ssrf.SsrFPolicy]>([
    ["http://198.18.0.153/file", "198.18.0.153", 4, { allowRfc2544BenchmarkRange: true }],
    ["https://fake-ip.test/file", "fc00::153", 6, { allowIpv6UniqueLocalRange: true }],
  ])(
    "requires ssrfPolicy opt-in for %s, including cache hits",
    async (url, address, family, ssrfPolicy) => {
      lookupMock.mockResolvedValue([{ address, family }]);
      const strict = () => createWebFetchToolForTest({ cacheTtlMinutes: 1 });
      await expectBlockedUrl(strict(), url, /private|internal|blocked/i);
      const fetchSpy = setMockFetch().mockResolvedValue(textResponse("allowed"));
      await expectSuccess(createWebFetchToolForTest({ ssrfPolicy, cacheTtlMinutes: 1 }), url);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await expectBlockedUrl(strict(), url, /private|internal|blocked/i);
    },
  );
});
