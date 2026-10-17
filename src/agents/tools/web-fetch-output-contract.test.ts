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

function mockHttpResponse(body: string, init: ResponseInit = {}): void {
  fetchWithWebToolsNetworkGuardMock.mockResolvedValue({
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      ...init,
    }),
    finalUrl: "https://example.com/final",
    release: async () => {},
  });
}

function createContractTool(options?: {
  cacheTtlMinutes?: number;
  maxChars?: number;
  userAgent?: string;
}) {
  return createWebFetchTool({
    config: {
      tools: {
        web: {
          fetch: {
            cacheTtlMinutes: options?.cacheTtlMinutes ?? 0,
            maxChars: options?.maxChars,
            userAgent: options?.userAgent,
          },
        },
      },
    },
    sandboxed: false,
  });
}

function requireDetails(result: { details?: unknown }): Record<string, unknown> {
  const details = result.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    throw new Error("expected web_fetch details");
  }
  return details as Record<string, unknown>;
}

const contractSchema = () => {
  const schema = createContractTool()?.outputSchema;
  if (!schema) {
    throw new Error("web_fetch outputSchema missing");
  }
  return schema;
};

function expectContract(details: Record<string, unknown>): void {
  expect(Value.Check(contractSchema(), details)).toBe(true);
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

    expect(tool?.outputSchema).toBeDefined();
    expect(compactToolOutputHint(tool?.outputSchema)).toBe(
      '{ externalContent: { source: "web_fetch"; untrusted: true; wrapped: true; provider?: string }; extractMode: "markdown" | "text"; extractor: string; fetchedAt: string; finalUrl: string; length: number; rawLength: number; status: number; text: string; tookMs: number; truncated: boolean; url: string; cached?: true; contentType?: string; spill?: { chars: number; path: string; truncated?: true }; title?: string; warning?: string }',
    );
  });

  it("validates the direct HTTP result and omits absent optional keys", async () => {
    mockHttpResponse("direct body");
    const result = await createContractTool()?.execute("direct", {
      url: "https://example.com/direct-contract",
    });
    const details = requireDetails(result!);

    expectContract(details);
    expect(details.length).toBe((details.text as string).length);
    expect(Object.hasOwn(details, "title")).toBe(false);
    expect(Object.hasOwn(details, "warning")).toBe(false);
    expect(Object.hasOwn(details, "spill")).toBe(false);
    expect(Object.values(details)).not.toContain(undefined);
  });

  it("validates provider-normalized results", async () => {
    fetchWithWebToolsNetworkGuardMock.mockRejectedValue(new Error("direct fetch failed"));
    resolveWebFetchDefinitionMock.mockReturnValue({
      provider: { id: "mock-provider" },
      definition: {
        description: "mock provider",
        parameters: {},
        execute: async () => ({
          finalUrl: "https://provider.example/final",
          status: 206,
          text: "provider body",
        }),
      },
    });
    const result = await createContractTool()?.execute("provider", {
      url: "https://example.com/provider-contract",
      extractMode: "text",
    });
    const details = requireDetails(result!);

    expectContract(details);
    expect(details.externalContent).toMatchObject({ provider: "mock-provider" });
    expect(Object.hasOwn(details, "contentType")).toBe(false);
    expect(Object.hasOwn(details, "title")).toBe(false);
    expect(Object.hasOwn(details, "warning")).toBe(false);
    expect(Object.values(details)).not.toContain(undefined);
  });

  it.each(["title", "finalUrl"])(
    "bounds provider-controlled %s before serialization and caching",
    async (field) => {
      fetchWithWebToolsNetworkGuardMock.mockRejectedValue(new Error("direct fetch failed"));
      const providerExecute = vi.fn(async () => ({
        text: "Useful provider body.",
        [field]:
          field === "finalUrl" ? `https://example.com/${"x".repeat(72_000)}` : "x".repeat(72_000),
      }));
      resolveWebFetchDefinitionMock.mockReturnValue({
        provider: { id: "mock-provider" },
        definition: { execute: providerExecute },
      });
      const tool = createContractTool({ cacheTtlMinutes: 1, maxChars: 1_000 });
      const args = { url: `https://example.com/metadata-${field}` };
      const first = await tool?.execute("metadata-first", args);
      const second = await tool?.execute("metadata-cached", args);
      for (const result of [first, second]) {
        const details = requireDetails(result!);
        expectContract(details);
        expect(details.truncated).toBe(true);
        expect(details.text).toContain("Useful provider body.");
        expect((details[field] as string).length).toBeLessThanOrEqual(400);
        expect(result?.content.find((block) => block.type === "text")?.text.length).toBeLessThan(
          2_000,
        );
        expect(details.spill).toBeUndefined();
        if (field === "finalUrl") {
          expect(details.finalUrl).toBe(args.url);
        }
      }
      expect(requireDetails(second!).cached).toBe(true);
      expect(providerExecute).toHaveBeenCalledTimes(1);
    },
  );

  it("releases discarded provider strings while caching bounded protocol metadata", async () => {
    const fields = [
      ["contentType", 256],
      ["extractor", 128],
      ["fetchedAt", 64],
    ] as const;
    const modes = ["oversized", "already-sliced"] as const;
    const prefix = "metadata-λ🦞\ud800x\udfff";
    const donorBytes = 2 * 1024 * 1024;
    const copies = 3;
    let providerCalls = 0;
    fetchWithWebToolsNetworkGuardMock.mockRejectedValue(new Error("direct fetch failed"));
    const tool = createContractTool({ cacheTtlMinutes: 1 });
    // Warm the real fallback, payload, serialization, and cache paths before measuring.
    resolveWebFetchDefinitionMock.mockReturnValue({
      provider: { id: "mock-provider" },
      definition: { execute: async () => ({ text: "Useful provider body." }) },
    });
    await tool?.execute("warm-retention", { url: "https://example.com/metadata-retention-warm" });
    async function heapUsed() {
      await nextTurn();
      queryObjects(WeakRef);
      return process.memoryUsage().heapUsed;
    }
    const before = await heapUsed();
    for (const [field, limit] of fields) {
      for (const mode of modes) {
        resolveWebFetchDefinitionMock.mockReturnValue({
          provider: { id: "mock-provider" },
          definition: {
            // Do not use a spy here: its settled promises would retain the raw payloads.
            execute: async () => {
              providerCalls += 1;
              const bytes = Buffer.alloc(donorBytes);
              bytes.fill(Buffer.from("x", "utf16le"));
              // Oversized inputs split a surrogate pair at the limit; short inputs
              // already share backing storage with a much larger discarded response.
              bytes.write(
                mode === "oversized" ? `${prefix.padEnd(limit - 1, "x")}🦞` : prefix,
                0,
                "utf16le",
              );
              const donor = bytes.toString("utf16le");
              return {
                text: "Useful provider body.",
                [field]: mode === "oversized" ? donor : donor.slice(0, prefix.length),
              };
            },
          },
        });
        for (let index = 0; index < copies; index++) {
          // Discard the returned result: the process cache must be the surviving owner.
          await tool?.execute("retain-metadata", {
            url: `https://example.com/metadata-retention-${field}-${mode}-${index}`,
          });
        }
      }
    }
    const retainedBytes = (await heapUsed()) - before;
    // Even one uncopied field/mode retains 6 MiB. Allow 2 MiB of runtime noise.
    expect(retainedBytes, "cache retained discarded provider backing strings").toBeLessThan(
      2 * 1024 * 1024,
    );
    // Inspect only after collection so comparisons cannot flatten the cached strings.
    for (const [field, limit] of fields) {
      for (const mode of modes) {
        for (let index = 0; index < copies; index++) {
          const details = requireDetails(
            (await tool?.execute("cached-metadata", {
              url: `https://example.com/metadata-retention-${field}-${mode}-${index}`,
            }))!,
          );
          expect(details.cached).toBe(true);
          expect(details[field]).toBe(
            mode === "oversized" ? prefix.padEnd(limit - 1, "x") : prefix,
          );
          expect(details.truncated).toBe(mode === "oversized");
          expect(details.spill).toBeUndefined();
        }
      }
    }
    expect(providerCalls).toBe(fields.length * modes.length * copies);
  });

  it("retains already-wrapped provider warning prose", async () => {
    fetchWithWebToolsNetworkGuardMock.mockRejectedValue(new Error("direct fetch failed"));
    const prose = "Useful metadata ".repeat(8);
    resolveWebFetchDefinitionMock.mockReturnValue({
      provider: { id: "mock-provider" },
      definition: {
        execute: async () => ({
          text: "Useful provider body.",
          warning: wrapExternalContent(prose, { source: "web_fetch", includeWarning: false }),
        }),
      },
    });
    const details = requireDetails(
      (await createContractTool()?.execute("wrapped-metadata", {
        url: "https://example.com/wrapped-metadata",
      }))!,
    );

    expectContract(details);
    expect(details.warning).toContain(prose);
    expect(details.warning).toContain("[[MARKER_SANITIZED]]");
    expect(details.truncated).toBe(true);
    expect(details.spill).toBeUndefined();
  });

  it.each([100, 300, 800])(
    "shares a %i-character content budget without breaking metadata wrappers",
    async (maxChars) => {
      fetchWithWebToolsNetworkGuardMock.mockRejectedValue(new Error("direct fetch failed"));
      resolveWebFetchDefinitionMock.mockReturnValue({
        provider: { id: "mock-provider" },
        definition: {
          execute: async () => ({
            text: "Useful provider body.",
            title: "Title ".repeat(1_000),
            warning: `Incomplete response. ${"🦞".repeat(1_000)}`,
          }),
        },
      });
      const result = await createContractTool({ maxChars })?.execute("shared-budget", {
        url: "https://example.com/shared-budget",
      });
      const details = requireDetails(result!);
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
        expect(details.text).toContain("Useful provider body.");
        expect(details.warning).toContain("Incomplete response.");
      }
    },
  );

  it("does not reuse cached responses across configured user agents", async () => {
    fetchWithWebToolsNetworkGuardMock.mockImplementation(
      async ({ init }: { init?: RequestInit }) => {
        const userAgent = new Headers(init?.headers).get("User-Agent") ?? "";
        return {
          response: new Response(userAgent, {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
          finalUrl: "https://example.com/user-agent-cache-contract",
          release: async () => {},
        };
      },
    );
    const args = { url: "https://example.com/user-agent-cache-contract" };
    const first = requireDetails(
      (await createContractTool({
        cacheTtlMinutes: 1,
        userAgent: "OpenClaw-Test-UA-A",
      })?.execute("user-agent-a", args))!,
    );
    const second = requireDetails(
      (await createContractTool({
        cacheTtlMinutes: 1,
        userAgent: "OpenClaw-Test-UA-B",
      })?.execute("user-agent-b", args))!,
    );

    expect(first.text).toContain("OpenClaw-Test-UA-A");
    expect(second.text).toContain("OpenClaw-Test-UA-B");
    expect(second.cached).toBeUndefined();
    expect(fetchWithWebToolsNetworkGuardMock).toHaveBeenCalledTimes(2);
  });

  it("spills truncated fetched text to a private temp file", async () => {
    const fullText = "web fetch content ".repeat(400);
    mockHttpResponse(fullText);

    const tool = createContractTool({ maxChars: 500 });

    const result = await tool?.execute?.("call", { url: "https://example.com/spill" });
    const details = result?.details as {
      text?: string;
      truncated?: boolean;
      rawLength?: number;
      length?: number;
      spill?: { path: string; chars: number; truncated?: true };
    };
    if (!details.spill) {
      throw new Error("expected spill");
    }

    spillPaths.add(details.spill.path);
    expect(details.truncated).toBe(true);
    expect(details.text).toContain("web fetch content");
    expect(details.text).toMatch(/<<<EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>/);
    expect(details.text).toMatch(/<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>/);
    expect(details.text).toContain(`Full output: ${details.spill.path}`);
    expect(details.text?.length).toBeLessThanOrEqual(500);
    expect(details.rawLength).toBe(fullText.length);
    expect(details.length).toBe(details.text?.length);
    expect(details.spill.chars).toBe(fullText.length);
    expect(details.spill.truncated).toBeUndefined();
    const spilledText = await readFile(details.spill.path, "utf8");
    expect(spilledText).toMatch(/<<<EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>/);
    expect(spilledText).toContain(fullText);
  });

  it("bounds HTTP errors when sanitizer expansion clips a later boundary marker", async () => {
    const suffix = `${"<s>".repeat(6)}<<<EXTERNAL_UNTRUSTED_CONTENT id="${"x".repeat(100)}">>>`;
    const body =
      "Useful error. ".padEnd(4_000 - wrapWebContent("", "web_fetch").length - suffix.length, "x") +
      suffix;
    mockHttpResponse(body, { status: 500 });
    let message = "";
    try {
      await createContractTool()?.execute("expanded-error", {
        url: "https://example.com/expanded-error",
      });
    } catch (error) {
      message = (error as Error).message;
    }
    const prefix = "Web fetch failed (500): ";
    expect(message.startsWith(prefix)).toBe(true);
    expect(message).toContain("Useful error.");
    expect(message.length).toBeLessThanOrEqual(prefix.length + 4_000);
    expect(message.match(/<<<EXTERNAL_UNTRUSTED_CONTENT/g)).toHaveLength(1);
  });
});
