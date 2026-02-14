import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../infra/net/ssrf.js";
import { createWebFetchTool } from "./web-tools.js";

function makeHeaders(map: Record<string, string>): { get: (key: string) => string | null } {
  return { get: (key) => map[key.toLowerCase()] ?? null };
}

function requestUrl(input: RequestInfo): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if ("url" in input && typeof input.url === "string") {
    return input.url;
  }
  return "";
}

describe("web_fetch excludeFromContext", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation(async (hostname) => {
      const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
      const addresses = ["93.184.216.34"];
      return {
        hostname: normalized,
        addresses,
        lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses }),
      };
    });
  });

  afterEach(() => {
    // @ts-expect-error restore
    global.fetch = priorFetch;
    vi.restoreAllMocks();
  });

  it("returns full jsonResult when excludeFromContext is not set", async () => {
    const mockFetch = vi.fn((input: RequestInfo) =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: makeHeaders({ "content-type": "text/plain" }),
        text: async () => "hello world",
        url: requestUrl(input),
      } as Response),
    );
    // @ts-expect-error mock
    global.fetch = mockFetch;

    const tool = createWebFetchTool({
      config: { tools: { web: { fetch: { cacheTtlMinutes: 0, firecrawl: { enabled: false } } } } },
      sandboxed: false,
    });

    const result = await tool?.execute?.("call1", { url: "https://example.com/plain" });
    const text =
      result?.content?.find((c: { type: string; text?: string }) => c.type === "text")?.text ?? "";
    expect(text).not.toContain("excluded from context");
  });

  it("writes artifact and returns preview when excludeFromContext is true", async () => {
    const longText = "y".repeat(12_000);
    const mockFetch = vi.fn((input: RequestInfo) =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: makeHeaders({ "content-type": "text/plain" }),
        text: async () => longText,
        url: requestUrl(input),
      } as Response),
    );
    // @ts-expect-error mock
    global.fetch = mockFetch;

    const tool = createWebFetchTool({
      config: { tools: { web: { fetch: { cacheTtlMinutes: 0, firecrawl: { enabled: false } } } } },
      sandboxed: false,
    });

    const result = await tool?.execute?.("call_exclude", {
      url: "https://example.com/big",
      excludeFromContext: true,
    });

    const text =
      result?.content?.find((c: { type: string; text?: string }) => c.type === "text")?.text ?? "";
    expect(text).toContain("excluded from context");
    expect(text.length).toBeLessThan(6_000);

    const details = result?.details as {
      outputFile?: string;
      excludedFromContext?: boolean;
    };
    expect(details.excludedFromContext).toBe(true);
    expect(details.outputFile).toBeTruthy();

    const artifactContent = fs.readFileSync(details.outputFile!, "utf-8");
    expect(artifactContent.length).toBeGreaterThanOrEqual(4_000);
  });
});
