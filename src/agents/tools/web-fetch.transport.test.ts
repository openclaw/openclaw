import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginWebContentExtractorEntry } from "../../plugins/web-content-extractor-types.js";
import * as privateTempFiles from "../sessions/tools/private-temp-file.js";
import type { WebFetchTransport } from "./web-fetch-transport.js";
import { createWebFetchTool } from "./web-fetch.js";

const { directFetch, resolveProvider, resolveExtractors } = vi.hoisted(() => ({
  directFetch: vi.fn(),
  resolveProvider: vi.fn(),
  resolveExtractors: vi.fn<() => PluginWebContentExtractorEntry[]>(() => []),
}));
// mock-isolation: No real network or credentialed fallback may run in this transport fixture.
vi.mock("./web-guarded-fetch.js", () => ({ fetchWithWebToolsNetworkGuard: directFetch }));
// mock-isolation: Detect provider discovery as well as execution on an exclusive host path.
vi.mock("../../web-fetch/runtime.js", () => ({ resolveWebFetchDefinition: resolveProvider }));
// mock-isolation: Exercise native basic HTML extraction without loading external plugins.
vi.mock("../../plugins/web-content-extractors.runtime.js", () => ({
  resolvePluginWebContentExtractors: resolveExtractors,
}));

const url = "https://example.com/host-content";
const spillPaths = new Set<string>();

function createTransport(body = "host content", contentType = "text/plain") {
  const release = vi.fn(async () => {});
  const acquire = vi.fn<WebFetchTransport["acquire"]>(async () => ({
    response: new Response(body, { headers: { "content-type": contentType } }),
    finalUrl: url,
    release,
  }));
  return { acquire, release, assertInvocationCurrent: vi.fn(() => {}) };
}

function createTool(
  transport?: WebFetchTransport,
  fetch: NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>["fetch"] = {},
) {
  const tool = createWebFetchTool({
    transport,
    config: { tools: { web: { fetch: { cacheTtlMinutes: 1, ...fetch } } } },
  });
  assert(tool);
  return tool;
}

function detailsOf(result: { details?: unknown }) {
  assert(isRecord(result.details));
  const spill = result.details.spill;
  if (isRecord(spill) && typeof spill.path === "string") {
    spillPaths.add(spill.path);
  }
  return result.details;
}

beforeEach(() => {
  directFetch.mockReset();
  resolveProvider.mockReset();
  resolveExtractors.mockReset().mockReturnValue([]);
});
afterEach(async () => {
  expect(resolveProvider).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  await Promise.all([...spillPaths].map((path) => rm(path, { force: true })));
  spillPaths.clear();
});

describe("native web_fetch host acquisition", () => {
  it.each([
    { contentType: "text/markdown", body: "# Native heading", extractor: "cf-markdown" },
    { contentType: "application/json", body: '{"answer":42}', extractor: "json" },
    {
      contentType: "text/html",
      body: "<html><body><h1>Native heading</h1><p>Readable host page.</p></body></html>",
      extractor: "raw-html",
    },
  ])(
    "retains native $contentType processing and wrapping",
    async ({ contentType, body, extractor }) => {
      const transport = createTransport(body, contentType);
      const tool = createTool(transport);
      const result = detailsOf(await tool.execute("host-call", { url, extractMode: "text" }));
      expect(result).toMatchObject({
        url,
        finalUrl: url,
        status: 200,
        contentType,
        extractMode: "text",
        extractor,
        externalContent: { untrusted: true, source: "web_fetch", wrapped: true },
        text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
      });
      expect(result.text).toContain(
        contentType === "application/json" ? '"answer": 42' : "Native heading",
      );
      expect(transport.release).toHaveBeenCalledTimes(1);
      expect(directFetch).not.toHaveBeenCalled();
    },
  );

  it("passes the normalized destination, operator headers, limits and cancellation, not forged context", async () => {
    const transport = createTransport();
    const controller = new AbortController();
    const tool = createTool(transport, {
      maxRedirects: 2,
      maxResponseBytes: 32_000,
      timeoutSeconds: 9,
      userAgent: "host-test",
      headers: { "X-Route": "test-route" },
      ssrfPolicy: { blockedHostnames: ["blocked.example"] },
    });
    await tool.execute(
      "trusted-call",
      {
        url: "  https:// EXAMPLE.com/a path?q=Case  ",
        toolCallId: "forged-call",
        sessionId: "forged-session",
        transport: "forged-transport",
      },
      controller.signal,
    );
    expect(transport.acquire).toHaveBeenCalledExactlyOnceWith({
      url: "https://example.com/a%20path?q=Case",
      toolCallId: "trusted-call",
      init: {
        method: "GET",
        headers: {
          Accept: "text/markdown, text/html;q=0.9, */*;q=0.1",
          "User-Agent": "host-test",
          "Accept-Language": "en-US,en;q=0.9",
          "X-Route": "test-route",
        },
      },
      signal: controller.signal,
      maxRedirects: 2,
      maxResponseBytes: 32_000,
      timeoutSeconds: 9,
      ssrfPolicy: { blockedHostnames: ["blocked.example"] },
    });
    expect(directFetch).not.toHaveBeenCalled();
  });

  it.each([
    "refusal",
    "http-error",
    "readability-disabled",
    "empty-html",
    "invalid-final-url",
    "release-error",
  ])("does not escape to HTTP or providers on %s", async (failure) => {
    const transport = createTransport();
    transport.acquire.mockImplementation(async () => {
      if (failure === "refusal") {
        throw new Error("host refused");
      }
      return {
        response: new Response(failure === "http-error" ? "host refused" : "<html></html>", {
          status: failure === "http-error" ? 403 : 200,
          headers: { "content-type": "text/html" },
        }),
        finalUrl: failure === "invalid-final-url" ? "file:///private" : url,
        release: transport.release,
      };
    });
    if (failure === "release-error") {
      transport.release.mockRejectedValue(new Error("host cleanup failed"));
    }
    const tool = createTool(transport, { readability: failure !== "readability-disabled" });
    await expect(tool.execute("failure", { url })).rejects.toThrow();
    await expect(tool.execute("retry", { url })).rejects.toThrow();
    expect(transport.acquire).toHaveBeenCalledTimes(2);
    expect(transport.release).toHaveBeenCalledTimes(failure === "refusal" ? 0 : 2);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it("isolates host and default caches while reusing an explicit equivalent host scope", async () => {
    directFetch.mockImplementation(async () => ({
      response: new Response("direct content"),
      finalUrl: url,
      release: async () => {},
    }));
    const native = createTool();
    await native.execute("direct", { url });
    const first = createTransport("first audience");
    const second = createTransport("second audience");
    const firstTool = createTool(first);
    await firstTool.execute("first", { url });
    expect(detailsOf(await createTool(second).execute("second", { url })).text).toContain(
      "second audience",
    );
    expect(detailsOf(await createTool(first).execute("reuse", { url })).cached).toBe(true);
    const sharedScope = {};
    await createTool({ ...first, cacheScope: sharedScope }).execute("share", { url });
    expect(
      detailsOf(
        await createTool({ ...second, cacheScope: sharedScope }).execute("shared", { url }),
      ),
    ).toMatchObject({
      cached: true,
      text: expect.stringContaining("first audience"),
    });
    expect(detailsOf(await native.execute("native-cache", { url }))).toMatchObject({
      cached: true,
      text: expect.stringContaining("direct content"),
    });
    expect(first.acquire).toHaveBeenCalledTimes(2);
    expect(second.acquire).toHaveBeenCalledTimes(1);
    expect(directFetch).toHaveBeenCalledTimes(1);
  });

  it("does not reuse entries under tighter limits, changed headers or disabled caching", async () => {
    const transport = createTransport();
    await createTool(transport).execute("seed", { url });
    for (const fetch of [
      { maxResponseBytes: 32_000 },
      { maxRedirects: 0 },
      { readability: false },
      { headers: { "X-Audience": "other" } },
      { cacheTtlMinutes: 0 },
    ]) {
      expect(
        detailsOf(await createTool(transport, fetch).execute("changed", { url })).cached,
      ).toBeUndefined();
    }
    expect(transport.acquire).toHaveBeenCalledTimes(6);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it("checks live authority and cancellation even for cached results", async () => {
    const transport = createTransport();
    const tool = createTool(transport);
    await tool.execute("seed", { url });
    transport.assertInvocationCurrent.mockImplementation(() => {
      throw new Error("invocation closed");
    });
    await expect(tool.execute("stale", { url, assertInvocationCurrent: () => {} })).rejects.toThrow(
      "invocation closed",
    );
    transport.assertInvocationCurrent.mockReset();
    await expect(
      tool.execute("cancelled", { url }, AbortSignal.abort(new Error("cancelled"))),
    ).rejects.toThrow("cancelled");
    expect(detailsOf(await tool.execute("reuse", { url })).cached).toBe(true);
    expect(transport.acquire).toHaveBeenCalledTimes(1);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it("rechecks a cached result after the execution await boundary", async () => {
    const transport = createTransport();
    const tool = createTool(transport);
    await tool.execute("seed", { url });
    let current = true;
    transport.assertInvocationCurrent.mockImplementation(() => {
      if (!current) {
        throw new Error("invocation closed");
      }
      queueMicrotask(() => {
        current = false;
      });
    });
    await expect(tool.execute("retired-cache-hit", { url })).rejects.toThrow("invocation closed");
    expect(transport.acquire).toHaveBeenCalledTimes(1);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it.each([
    { phase: "acquisition", cancellation: false },
    { phase: "release", cancellation: false },
    { phase: "acquisition", cancellation: true },
    { phase: "release", cancellation: true },
  ])(
    "rejects revoked authority during $phase (cancellation=$cancellation) without caching",
    async ({ phase, cancellation }) => {
      const transport = createTransport();
      const started = createDeferred();
      const pending = createDeferred();
      let current = true;
      transport.assertInvocationCurrent.mockImplementation(() => {
        if (!current) {
          throw new Error("invocation closed");
        }
      });
      const wait = async () => {
        started.resolve();
        await pending.promise;
      };
      if (phase === "acquisition") {
        transport.acquire.mockImplementationOnce(async () => {
          await wait();
          return {
            response: new Response("stale content"),
            finalUrl: url,
            release: transport.release,
          };
        });
      } else {
        transport.release.mockImplementationOnce(wait);
      }
      const tool = createTool(transport);
      const controller = new AbortController();
      const outcome = tool.execute("revoked", { url }, controller.signal);
      const rejected = expect(outcome).rejects.toThrow("invocation closed");
      await started.promise;
      if (cancellation) {
        controller.abort(new Error("invocation closed"));
      } else {
        current = false;
      }
      pending.resolve();
      await rejected;
      expect(transport.release).toHaveBeenCalledTimes(1);
      current = true;
      expect(detailsOf(await tool.execute("fresh", { url })).cached).toBeUndefined();
      expect(transport.acquire).toHaveBeenCalledTimes(2);
      expect(directFetch).not.toHaveBeenCalled();
    },
  );

  it("bounds host response bytes and native output, including the recoverable spill", async () => {
    const transport = createTransport("x".repeat(40_000));
    const tool = createTool(transport, { maxResponseBytes: 32_000 });
    const result = detailsOf(await tool.execute("bounded", { url, maxChars: 1_000 }));
    expect(result).toMatchObject({
      truncated: true,
      rawLength: 32_000,
      length: expect.any(Number),
    });
    assert(typeof result.text === "string");
    expect(result.text.length).toBeLessThanOrEqual(1_000);
    assert(isRecord(result.spill) && typeof result.spill.path === "string");
    expect(result.spill).toMatchObject({ chars: 32_000, truncated: true });
    expect(await readFile(result.spill.path, "utf8")).toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(transport.release).toHaveBeenCalledTimes(1);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it.each([
    { fallback: false, cancellation: false },
    { fallback: true, cancellation: false },
    { fallback: false, cancellation: true },
    { fallback: true, cancellation: true },
  ])(
    "prevents spill creation after delayed HTML extraction (fallback=$fallback, cancellation=$cancellation)",
    async ({ fallback, cancellation }) => {
      const content = "Private acquired content. ".repeat(200);
      const transport = createTransport(`<html><body><p>${content}</p></body></html>`, "text/html");
      const started = createDeferred();
      const pending = createDeferred();
      let current = true;
      transport.assertInvocationCurrent.mockImplementation(() => {
        if (!current) {
          throw new Error("invocation closed");
        }
      });
      resolveExtractors.mockReturnValue([
        {
          id: "delayed",
          pluginId: "test-extractor",
          label: "Delayed extractor",
          extract: async () => {
            started.resolve();
            await pending.promise;
            return fallback ? null : { text: content };
          },
        },
      ]);
      const realWrite = privateTempFiles.writePrivateTempFile;
      const write = vi
        .spyOn(privateTempFiles, "writePrivateTempFile")
        .mockImplementation(async (...args) => {
          const path = await realWrite(...args);
          spillPaths.add(path);
          return path;
        });
      const controller = new AbortController();
      const tool = createTool(transport);
      const args = { url, maxChars: 1_000 };
      const rejected = expect(
        tool.execute("retired-extraction", args, controller.signal),
      ).rejects.toThrow("invocation closed");
      await started.promise;
      if (cancellation) {
        controller.abort(new Error("invocation closed"));
      } else {
        current = false;
      }
      pending.resolve();
      await rejected;
      expect(write).not.toHaveBeenCalled();
      expect(transport.release).toHaveBeenCalledTimes(1);

      current = true;
      const fresh = detailsOf(await tool.execute("fresh-extraction", args));
      expect(fresh.cached).toBeUndefined();
      expect(fresh.spill).toMatchObject({ chars: expect.any(Number) });
      expect(write).toHaveBeenCalledTimes(1);
      expect(transport.acquire).toHaveBeenCalledTimes(2);
      expect(directFetch).not.toHaveBeenCalled();
    },
  );

  it("does not expose an HTTP error body after authority is revoked during cleanup", async () => {
    const transport = createTransport();
    const started = createDeferred();
    const pending = createDeferred();
    let current = true;
    transport.assertInvocationCurrent.mockImplementation(() => {
      if (!current) {
        throw new Error("invocation closed");
      }
    });
    transport.acquire.mockResolvedValue({
      response: new Response("private host error detail", { status: 403 }),
      finalUrl: url,
      release: async () => {
        started.resolve();
        await pending.promise;
      },
    });
    const outcome = createTool(transport).execute("revoked-error", { url });
    const rejected = expect(outcome).rejects.toThrow(/^invocation closed$/);
    await started.promise;
    current = false;
    pending.resolve();
    await rejected;
    expect(directFetch).not.toHaveBeenCalled();
  });
});
