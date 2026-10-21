import { readFile, rm } from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapExternalContent, wrapWebContent } from "../../security/external-content.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";

const { fetchWithWebToolsNetworkGuardMock, resolveWebFetchDefinitionMock } = vi.hoisted(() => ({
  fetchWithWebToolsNetworkGuardMock: vi.fn(),
  resolveWebFetchDefinitionMock: vi.fn(),
}));

vi.mock("./web-guarded-fetch.js", () => ({
  fetchWithWebToolsNetworkGuard: fetchWithWebToolsNetworkGuardMock,
}));
vi.mock("../../web-fetch/runtime.js", () => ({
  resolveWebFetchDefinition: resolveWebFetchDefinitionMock,
}));

import { createWebFetchTool } from "./web-fetch.js";

const spillPaths = new Set<string>();
const text = "Useful provider body.";

function mockHttpResponse(
  body: string | ((init?: RequestInit) => string),
  init: ResponseInit = {},
): void {
  fetchWithWebToolsNetworkGuardMock.mockImplementation(async (request: { init?: RequestInit }) => ({
    response: new Response(typeof body === "function" ? body(request.init) : body, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      ...init,
    }),
    finalUrl: "https://example.com/final",
    release: async () => {},
  }));
}

function createContractTool(options?: {
  cacheTtlMinutes?: number;
  maxChars?: number;
  userAgent?: string;
}) {
  return createWebFetchTool({
    config: { tools: { web: { fetch: { cacheTtlMinutes: 0, ...options } } } },
    sandboxed: false,
  });
}

function mockProvider(execute: () => unknown) {
  fetchWithWebToolsNetworkGuardMock.mockRejectedValue(new Error("direct fetch failed"));
  resolveWebFetchDefinitionMock.mockReturnValue({
    provider: { id: "mock-provider" },
    definition: { execute },
  });
}

async function fetchDetails(
  path: string,
  options?: Parameters<typeof createContractTool>[0],
  extractMode?: "text",
) {
  const args = { url: `https://example.com/${path}`, extractMode };
  return requireDetails((await createContractTool(options)!.execute("call", args))!);
}

function requireDetails(result: { details?: unknown }): Record<string, unknown> {
  const details = result.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    throw new Error("expected web_fetch details");
  }
  return details as Record<string, unknown>;
}

function expectContract(details: Record<string, unknown>): void {
  const schema = createContractTool()?.outputSchema;
  if (!schema) {
    throw new Error("web_fetch outputSchema missing");
  }
  expect(Value.Check(schema, details)).toBe(true);
}

describe("web_fetch output contract", () => {
  beforeEach(() => {
    fetchWithWebToolsNetworkGuardMock.mockReset();
    resolveWebFetchDefinitionMock.mockReset();
    resolveWebFetchDefinitionMock.mockReturnValue(null);
  });

  afterEach(async () => {
    await Promise.all([...spillPaths].map(async (path) => await rm(path, { force: true })));
    spillPaths.clear();
  });

  it("declares the exact schema and promotes its complete compact hint", () => {
    const tool = createContractTool();

    expect(compactToolOutputHint(tool?.outputSchema)).toBe(
      '{ externalContent: { source: "web_fetch"; untrusted: true; wrapped: true; provider?: string }; extractMode: "markdown" | "text"; extractor: string; fetchedAt: string; finalUrl: string; length: number; rawLength: number; status: number; text: string; tookMs: number; truncated: boolean; url: string; cached?: true; contentType?: string; spill?: { chars: number; path: string; truncated?: true }; title?: string; warning?: string }',
    );
  });

  it.each(["direct", "provider"])("validates %s output and omits absent keys", async (source) => {
    const provider = source === "provider";
    if (provider) {
      mockProvider(async () => ({ finalUrl: "https://p.test", status: 206, text: "provider" }));
    } else {
      mockHttpResponse("direct body");
    }
    const details = await fetchDetails(source, undefined, provider ? "text" : undefined);
    expectContract(details);
    if (provider) {
      expect(details.externalContent).toMatchObject({ provider: "mock-provider" });
    } else {
      expect(details.length).toBe((details.text as string).length);
    }
    for (const key of ["title", "warning", provider ? "contentType" : "spill"]) {
      expect(Object.hasOwn(details, key)).toBe(false);
    }
    expect(Object.values(details)).not.toContain(undefined);
  });

  it.each(["title", "finalUrl"])("bounds cached provider %s", async (field) => {
    const providerExecute = vi.fn(async () => ({
      text,
      [field]:
        field === "finalUrl" ? `https://example.com/${"x".repeat(72_000)}` : "x".repeat(72_000),
    }));
    mockProvider(providerExecute);
    const tool = createContractTool({ cacheTtlMinutes: 1, maxChars: 1_000 });
    const args = { url: `https://example.com/metadata-${field}` };
    const first = await tool?.execute("metadata-first", args);
    const second = await tool?.execute("metadata-cached", args);
    for (const result of [first, second]) {
      const details = requireDetails(result!);
      expectContract(details);
      expect(details.truncated).toBe(true);
      expect(details.text).toContain(text);
      expect((details[field] as string).length).toBeLessThanOrEqual(400);
      const content = result?.content.find((block) => block.type === "text");
      expect(content?.text.length).toBeLessThan(2_000);
      expect(details.spill).toBeUndefined();
      if (field === "finalUrl") {
        expect(details.finalUrl).toBe(args.url);
      }
    }
    expect(requireDetails(second!).cached).toBe(true);
    expect(providerExecute).toHaveBeenCalledTimes(1);
  });

  it("releases discarded provider strings while caching bounded protocol metadata", async () => {
    const fields = Object.entries({ contentType: 256, extractor: 128, fetchedAt: 64 });
    const modes = [true, false];
    const prefix = "metadata-λ🦞\ud800x\udfff";
    const copies = 3;
    let providerCalls = 0;
    const tool = createContractTool({ cacheTtlMinutes: 1 });
    // Warm the real fallback, payload, serialization, and cache paths before measuring.
    mockProvider(async () => ({ text }));
    await tool?.execute("warm-retention", { url: "https://example.com/metadata-retention-warm" });
    async function heapUsed() {
      await nextTurn();
      queryObjects(WeakRef);
      return process.memoryUsage().heapUsed;
    }
    const before = await heapUsed();
    for (const [field, limit] of fields) {
      for (const oversized of modes) {
        // Do not spy on execute: settled promises would retain the raw payloads.
        mockProvider(async () => {
          providerCalls += 1;
          const bytes = Buffer.alloc(2 * 1024 * 1024, Buffer.from("x", "utf16le"));
          // Oversized inputs split a surrogate pair at the limit; short inputs
          // already share backing storage with a much larger discarded response.
          bytes.write(oversized ? `${prefix.padEnd(limit - 1, "x")}🦞` : prefix, 0, "utf16le");
          const donor = bytes.toString("utf16le");
          return { text, [field]: oversized ? donor : donor.slice(0, prefix.length) };
        });
        for (let index = 0; index < copies; index++) {
          // Discard the returned result: the process cache must be the surviving owner.
          await tool?.execute("retain-metadata", {
            url: `https://example.com/metadata-retention-${field}-${oversized}-${index}`,
          });
        }
      }
    }
    const retainedBytes = (await heapUsed()) - before;
    // Even one uncopied field/mode retains 6 MiB. Allow 2 MiB of runtime noise.
    expect(retainedBytes, "cache retained backing strings").toBeLessThan(2 * 1024 * 1024);
    // Inspect only after collection so comparisons cannot flatten the cached strings.
    for (const [field, limit] of fields) {
      for (const oversized of modes) {
        for (let index = 0; index < copies; index++) {
          const details = requireDetails(
            (await tool?.execute("cached-metadata", {
              url: `https://example.com/metadata-retention-${field}-${oversized}-${index}`,
            }))!,
          );
          expect(details.cached).toBe(true);
          expect(details[field]).toBe(oversized ? prefix.padEnd(limit - 1, "x") : prefix);
          expect(details.truncated).toBe(oversized);
          expect(details.spill).toBeUndefined();
        }
      }
    }
    expect(providerCalls).toBe(fields.length * modes.length * copies);
  });

  it("retains already-wrapped provider warning prose", async () => {
    const prose = "Useful metadata ".repeat(8);
    mockProvider(async () => ({
      text,
      warning: wrapExternalContent(prose, { source: "web_fetch", includeWarning: false }),
    }));
    const details = await fetchDetails("wrapped-metadata");

    expectContract(details);
    expect(details.warning).toContain(prose);
    expect(details.warning).toContain("[[MARKER_SANITIZED]]");
    expect(details.truncated).toBe(true);
    expect(details.spill).toBeUndefined();
  });

  it.each([100, 300, 800])("preserves wrappers in a %i-char budget", async (maxChars) => {
    mockProvider(async () => ({
      text,
      title: "Title ".repeat(1_000),
      warning: `Incomplete response. ${"🦞".repeat(1_000)}`,
    }));
    const details = await fetchDetails("shared-budget", { maxChars });
    const spill = details.spill as { path: string } | undefined;
    if (spill) {
      spillPaths.add(spill.path);
    }
    expectContract(details);
    const content = [details.text, details.title ?? "", details.warning ?? ""] as string[];
    expect(content.reduce((length, value) => length + value.length, 0)).toBeLessThanOrEqual(
      maxChars,
    );
    expect(details.truncated).toBe(true);
    for (const field of [details.title, details.warning]) {
      if (typeof field === "string") {
        expect(field.trimStart()).toMatch(/^<<<EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>/);
        expect(field).toMatch(/<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>$/);
        expect(field).not.toMatch(/[\uD800-\uDFFF]/u);
      }
    }
    if (maxChars >= 800) {
      expect(details.text).toContain(text);
      expect(details.warning).toContain("Incomplete response.");
    }
  });

  it("does not reuse cached responses across configured user agents", async () => {
    mockHttpResponse((init) => new Headers(init?.headers).get("User-Agent") ?? "");
    const fetchAs = (userAgent: string) =>
      fetchDetails("user-agent-cache-contract", { cacheTtlMinutes: 1, userAgent });
    const first = await fetchAs("OpenClaw-Test-UA-A");
    const second = await fetchAs("OpenClaw-Test-UA-B");

    expect(first.text).toContain("OpenClaw-Test-UA-A");
    expect(second.text).toContain("OpenClaw-Test-UA-B");
    expect(second.cached).toBeUndefined();
    expect(fetchWithWebToolsNetworkGuardMock).toHaveBeenCalledTimes(2);
  });

  it("spills truncated fetched text to a private temp file", async () => {
    const fullText = "web fetch content ".repeat(400);
    mockHttpResponse(fullText);

    const details = await fetchDetails("spill", { maxChars: 500 });
    const spill = details.spill as { path: string; chars: number; truncated?: true } | undefined;
    if (!spill) {
      throw new Error("expected spill");
    }
    spillPaths.add(spill.path);
    expect(details.truncated).toBe(true);
    expect(details.text).toContain("web fetch content");
    expect(details.text).toMatch(/<<<EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>/);
    expect(details.text).toMatch(/<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>/);
    expect(details.text).toContain(`Full output: ${spill.path}`);
    expect((details.text as string).length).toBeLessThanOrEqual(500);
    expect(details.rawLength).toBe(fullText.length);
    expect(details.length).toBe((details.text as string).length);
    expect(spill.chars).toBe(fullText.length);
    expect(spill.truncated).toBeUndefined();
    const spilledText = await readFile(spill.path, "utf8");
    expect(spilledText).toMatch(/<<<EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>/);
    expect(spilledText).toContain(fullText);
  });

  it("bounds HTTP errors when sanitizer expansion clips a later boundary marker", async () => {
    const suffix = `${"<s>".repeat(6)}<<<EXTERNAL_UNTRUSTED_CONTENT id="${"x".repeat(100)}">>>`;
    const body =
      "Useful error. ".padEnd(4_000 - wrapWebContent("", "web_fetch").length - suffix.length, "x") +
      suffix;
    mockHttpResponse(body, { status: 500 });
    const message = await createContractTool()!
      .execute("expanded-error", { url: "https://example.com/expanded-error" })
      .then(
        () => "",
        (error: unknown) => {
          if (!(error instanceof Error)) {
            throw error;
          }
          return error.message;
        },
      );
    const prefix = "Web fetch failed (500): ";
    expect(message.startsWith(prefix)).toBe(true);
    expect(message).toContain("Useful error.");
    expect(message.length).toBeLessThanOrEqual(prefix.length + 4_000);
    expect(message.match(/<<<EXTERNAL_UNTRUSTED_CONTENT/g)).toHaveLength(1);
  });
});
