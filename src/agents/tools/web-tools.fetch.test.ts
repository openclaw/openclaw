import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { EnvHttpProxyAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { LookupFn } from "../../infra/net/ssrf.js";
import * as logger from "../../logger.js";
import type { WebFetchProviderToolDefinition } from "../../plugin-sdk/provider-web-fetch.js";
import { resolveRequestUrl } from "../../plugin-sdk/request-url.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
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

function mockProvider(
  execute: WebFetchProviderToolDefinition["execute"],
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
  extractor: string;
  contentType?: string;
  warning?: string;
  spill?: { path: string; chars: number; truncated?: true };
};

async function fetchPage(
  path: string,
  overrides: Record<string, unknown> = {},
  args: { extractMode?: "text" | "markdown"; maxChars?: number } = {},
) {
  const result = await createFetchTool(overrides)?.execute("call", {
    url: `https://example.com/${path}`,
    ...args,
  });
  return { result, details: result?.details as FetchDetails };
}

async function readSpill(details: FetchDetails, chars: number) {
  assert(details.spill, "expected spill");
  expect(details.spill).toMatchObject({ chars, truncated: true });
  const text = await readFile(details.spill.path, "utf8");
  await rm(details.spill.path, { force: true });
  return text;
}

async function abortPendingFetch(reason?: Error) {
  const updates = vi.fn();
  const controller = new AbortController();
  const result = createFetchTool()
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
    const tool = createFetchTool();
    expect(tool).toMatchObject({ name: "web_fetch", resultContentSource: "network" });
    await tool?.execute("call", { url: "https://example.com/" }, undefined, updates);
    await vi.advanceTimersByTimeAsync(5000);
    expect(updates).not.toHaveBeenCalled();
  });

  it.each(["request", "body"] as const)(
    "cancels progress and fallback during %s",
    async (phase) => {
      vi.useFakeTimers();
      const providerExecute = vi.fn(async () => ({ text: "provider fallback" }));
      mockProvider(providerExecute, { id: "firecrawl" });
      installMockFetch(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (phase === "request") {
          return await new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
            setTimeout(() => resolve(textResponse("Loaded page")), 6000);
          });
        }
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
        return textResponse(body);
      });
      const error = await abortPendingFetch(phase === "body" ? new Error("cancelled") : undefined);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(phase === "body" ? "cancelled" : "aborted");
      expect(resolveWebFetchDefinitionMock).not.toHaveBeenCalled();
      expect(providerExecute).not.toHaveBeenCalled();
    },
  );

  it("keeps fetch execution alive when progress subscribers throw", async () => {
    vi.useFakeTimers();
    installMockFetch(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 6000);
      });
      return textResponse("Loaded page");
    });
    const tool = createFetchTool();
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

  it("does not split an emoji at the web_fetch spill file cap", async () => {
    const prefix = "x".repeat(WEB_FETCH_SPILL_MAX_CHARS - 1);
    const fullText = `${prefix}${String.fromCodePoint(0x1f600)}tail`;
    installResponse(fullText);

    const { details } = await fetchPage("spill-utf16", {
      maxChars: 500,
      maxResponseBytes: WEB_FETCH_SPILL_MAX_CHARS + 1_000,
    });

    expect(details.text).toContain(`Spilled first ${WEB_FETCH_SPILL_MAX_CHARS - 1} chars.`);
    const spilledText = await readSpill(details, WEB_FETCH_SPILL_MAX_CHARS - 1);
    expect(spilledText).toContain(prefix);
    expect(spilledText).not.toContain(String.fromCodePoint(0x1f600));
    expect(spilledText).not.toContain(String.fromCharCode(0xd83d));
  });

  it("bounds endless response streams and marks their spills as partial", async () => {
    const fullText = "z".repeat(40_000);
    const chunk = new TextEncoder().encode(fullText);
    installResponse(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(chunk);
        },
      }),
    );

    const { details } = await fetchPage("byte-cap", {
      maxChars: 500,
      maxResponseBytes: 128,
    });

    expect(details.text).toContain("Spilled available content from truncated response.");
    expect(details.warning).toContain("Response body incomplete after 32000 bytes");
    const spilledText = await readSpill(details, 32_000);
    expect(spilledText).toMatch(/<<<EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>/);
    expect(spilledText).not.toContain(fullText);
  });

  it("uses the real http-equiv charset, not a decoy in unrelated metadata", async () => {
    const japanese = "\x93\xfa\x96\x7b\x8c\xea";
    const html = `<html><head><meta name="description" content="charset=UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"><title>${japanese}</title></head><body>${japanese}</body></html>`;
    installResponse(Buffer.from(html, "latin1"), "text/html");

    const { details } = await fetchPage("shift-jis", undefined, { extractMode: "text" });
    const output = `${details.title ?? ""}\n${details.text ?? ""}`;

    expect(output).toContain("日本語");
    expect(output).not.toContain("�");
  });

  it.each([false, true])(
    "uses env proxy dispatch only with explicit trust (%s)",
    async (trusted) => {
      vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
      const mockFetch = installResponse("proxy body");
      const tool = createFetchTool(trusted ? { useTrustedEnvProxy: true } : {});

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

  it("returns readable HTML content", async () => {
    installResponse(EMPTY_HTML, "text/html");
    extractReadableContentMock.mockResolvedValue({
      extractor: "readability",
      text: "readability content",
    });
    const { details } = await fetchPage("readable");
    expect(details).toMatchObject({
      extractor: "readability",
      text: expect.stringContaining("readability content"),
    });
  });

  it.each([false, true])("rejects missing content (readability enabled: %s)", async (enabled) => {
    installResponse(enabled ? EMPTY_HTML : "<html><body>hi</body></html>", "text/html");
    if (enabled) {
      mockProvider(async () => {
        throw new Error("provider returned no content");
      });
    }
    await expect(fetchPage(`readability-${enabled}`, { readability: enabled })).rejects.toThrow(
      enabled
        ? "Readability, Test Fetch, and basic HTML cleanup returned no content"
        : "Readability disabled",
    );
  });

  it.each([
    [404, "Not Found", "Text/HTML; charset=utf-8", "x".repeat(12_000)],
    [500, "Oops", null, ""],
  ] as const)(
    "strips HTML errors with status %s (%s)",
    async (status, title, contentType, body) => {
      const html = `<!DOCTYPE HTML><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
      installResponse(contentType ? html : new TextEncoder().encode(html), contentType, status);
      const error: unknown = await fetchPage(`missing-${status}`).catch(
        (caught: unknown) => caught,
      );
      assert(error instanceof Error);
      const message = error.message;
      expect(message).toContain(`Web fetch failed (${status}):`);
      expect(message).toMatch(/<<<EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>/);
      expect(message).toContain(title);
      expect(message).not.toContain("<html");
      expect(message.length).toBeLessThan(5_000);
    },
  );

  it.each([
    {
      body: "<!DOCTYPE html><html><head><title></title><script>track()</script></head><body><p>Visible docs</p><div hidden>secret instructions</div></body></html>",
      extractor: "raw-html",
      contentType: "text/html",
      text: "Visible docs",
    },
    {
      body: "plain <b>notes</b>",
      extractor: "raw",
      contentType: "application/octet-stream",
      text: "plain <b>notes</b>",
    },
  ])("infers $contentType for untyped bodies", async ({ body, extractor, contentType, text }) => {
    installResponse(new TextEncoder().encode(body), null);
    const { details } = await fetchPage(`untyped-${extractor}`, undefined, { extractMode: "text" });
    expect(details).toMatchObject({
      extractor,
      contentType,
      truncated: false,
      text: expect.stringContaining(text),
    });
    expect(details).not.toHaveProperty("title");
    expect(details.text).not.toMatch(/<html|track\(\)|secret instructions/);
  });
});

function fetchHeaders(headers: Record<string, string>, path: string, cacheTtlMinutes = 0) {
  return createFetchTool({ cacheTtlMinutes, headers })?.execute("call", {
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
  it("normalizes operator headers before capture and cache partitioning", async () => {
    const fetchSpy = installResponse("# Routed", "text/markdown");
    const guardedFetchSpy = vi.spyOn(webGuardedFetch, "fetchWithWebToolsNetworkGuard");

    const headers = {
      "ATL-SG-SERVICE-INJECTION-URL": "http://host.docker.internal:9999",
      Authorization: "Bearer deployment-token",
      "X-Presence-Flag": "",
    };
    await fetchHeaders(
      {
        ...headers,
        "X-Presence-Flag": " \t ",
        "X-Routing-Target": "staging",
        "x-routing-target": "東京",
        accept: "text/plain",
        Host: "elsewhere.example",
        "X Invalid Name": "dropped",
      },
      "routed",
      15,
    );
    const sent = getRequestHeaders(fetchSpy);
    expect(sent).toMatchObject(headers);
    expect(Object.keys(sent)).toEqual([
      "Accept",
      "User-Agent",
      "Accept-Language",
      ...Object.keys(headers),
    ]);
    const captureMeta = guardedFetchSpy.mock.calls[0]?.[0].capture;
    expect(captureMeta === false ? undefined : captureMeta?.sensitiveRequestHeaderNames).toEqual(
      Object.keys(headers),
    );
    await fetchHeaders(headers, "routed", 15);
    await fetchHeaders({ ...headers, Authorization: "Bearer other-token" }, "routed", 15);
    await fetchHeaders(headers, "routed", 15);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(getRequestHeaders(fetchSpy, 1).Authorization).toBe("Bearer other-token");
  });

  it("still fetches when every configured header is unusable, naming it in a warning", async () => {
    const fetchSpy = installResponse("# Survives", "text/markdown");
    const warnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});

    const invalidName = "X-Bad\n[forged]\u001b[31m";
    const result = await fetchHeaders(
      {
        "X-Survives-Unicode": "東京",
        [invalidName]: "ignored",
      },
      "survives",
      15,
    );
    await fetchHeaders({}, "survives", 15);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((result?.details as { status?: number } | undefined)?.status).toBe(200);
    const warnings = warnSpy.mock.calls.map(([message]) => message).join("");
    expect(warnings).toContain("X-Survives-Unicode");
    expect(warnings).toContain(JSON.stringify(invalidName));
    expect(warnings).not.toContain("東京");
    expect(warnings).not.toContain("\n");
    expect(warnings).not.toContain("\u001b");
  });
});

describe("web_fetch cancellation", () => {
  function fixture(name: string, fallback?: string) {
    const fetch = vi.fn(async () => {
      if (fallback === "network-error") {
        throw new Error("network failed");
      }
      const body = fallback ? "<p>Upstream</p>" : "fresh direct body";
      return textResponse(body, fallback ? "text/html" : "text/plain");
    });
    vi.stubGlobal("fetch", withFetchPreconnect(fetch));
    const execute = vi
      .fn<WebFetchProviderToolDefinition["execute"]>()
      .mockResolvedValue({ text: "fresh provider body" });
    mockProvider(execute);
    const tool = createFetchTool({ cacheTtlMinutes: 1 })!;
    return { fetch, execute, tool, args: { url: `https://example.com/${name}` } };
  }

  it.each([
    { fallback: "network-error", completion: "success" },
    { fallback: "empty-readability", completion: "failure" },
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

      expect.soft(cancelled).toEqual({ status: "rejected", reason });
      expect.soft(fresh.details).not.toHaveProperty("cached");
      expect.soft(fresh.details).toMatchObject({ text });
      expect.soft(execute).toHaveBeenCalledTimes(2);
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

async function expectBlockedUrl(
  tool: ReturnType<typeof createFetchTool>,
  url: string,
  expectedMessage: RegExp,
) {
  await expect(tool?.execute?.("call", { url })).rejects.toThrow(expectedMessage);
}

async function expectSuccess(tool: ReturnType<typeof createFetchTool>, url: string) {
  const result = await tool?.execute?.("call", { url });
  expect(result?.details).toMatchObject({ status: 200, extractor: "raw" });
  return result;
}

describe("web_fetch SSRF protection", () => {
  beforeEach(() => {
    mockProvider(async () => ({ text: "A blocked request must never reach fallback." }));
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  const domainPolicy = { hostnameAllowlist: ["example.com", "*.example.com"] };
  const privateError = /private|internal|blocked/i;
  const domainError =
    /domain policy: blocked hostname.*example\.com.*Try a URL on a permitted domain/i;
  it("forwards the operator domain policy before DNS or fetch", async () => {
    const fetchSpy = installResponse("");
    const tool = createFetchTool({}, domainPolicy.hostnameAllowlist);
    await expectBlockedUrl(tool, "https://www.nytimes.com/", domainError);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
    await expectSuccess(tool, "https://example.com/");
  });

  it("propagates private-address denials without provider fallback", async () => {
    const fetchSpy = installResponse("");
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await expectBlockedUrl(createFetchTool(), "https://private.test/resource", privateError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not reuse an unrestricted cache entry across a domain policy", async () => {
    const fetchSpy = installResponse("cached outside content");
    const url = "https://outside.test/cached-policy-boundary";
    const unrestricted = createFetchTool({ cacheTtlMinutes: 1 });
    await unrestricted?.execute?.("call", { url });
    const restricted = createFetchTool({
      ssrfPolicy: { hostnameAllowlist: ["example.com", "*.example.com"] },
      cacheTtlMinutes: 1,
    });

    await expectBlockedUrl(restricted, url, domainError);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it.each([
    ["https:// docs.openclaw.ai", "https://docs.openclaw.ai", "https://docs.openclaw.ai/"],
    ["\u00a0\ufeffhttps://example.com", "https://example.com", "https://example.com/"],
    ["https://example.com\n", "https://example.com", "https://example.com/"],
    ["https://example.com/a\u00a0", "https://example.com/a\u00a0", "https://example.com/a%C2%A0"],
    ["https://example.com\u00a0", "https://example.com", "https://example.com/"],
  ])("normalizes %j through web_fetch", async (input, expectedUrl, expectedFetchUrl) => {
    const fetchSpy = installResponse("ok");
    const tool = createFetchTool();

    const result = await expectSuccess(tool, input);
    expect(result?.details).toMatchObject({ url: expectedUrl });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(resolveRequestUrl(fetchSpy.mock.calls[0]![0])).toBe(expectedFetchUrl);
  });
});
