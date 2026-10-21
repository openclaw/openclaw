import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { normalizeWebSearchOutput, WebSearchOutputSchema } from "./web-search-output.js";

const WRAP_MARKER_RE =
  /\n?<<<(?:END_)?EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]+">>>\n?(?:Source: Web Search\n---\n)?/gu;

function stripWrapMarkers(value: string): string {
  return value.replace(WRAP_MARKER_RE, "");
}

function normalize(result: Record<string, unknown>) {
  return normalizeWebSearchOutput({ provider: "external-demo", query: "q", result });
}

function assertOutputKind<T extends { kind: string }, K extends T["kind"]>(
  value: T,
  kind: K,
): asserts value is Extract<T, { kind: K }> {
  expect(value.kind).toBe(kind);
}

describe("web_search normalized output security", () => {
  it("preserves provider answer truncation through the closed model contract", () => {
    const normalized = normalize({ content: "bounded answer", truncated: true });
    expect(normalized).toMatchObject({ kind: "answer", truncated: true });
    expect(Value.Check(WebSearchOutputSchema, normalized)).toBe(true);
  });

  it("bounds conforming result rows to the public search count and reports the emitted count", () => {
    const normalized = normalize({
      count: 25,
      results: Array.from({ length: 25 }, (_, index) => ({
        title: `result ${index}`,
        url: `https://example.com/result/${index}`,
      })),
    });

    assertOutputKind(normalized, "results");
    expect(normalized.results).toHaveLength(10);
    expect(normalized).toMatchObject({ count: 10, truncated: true });
  });

  it.each([
    ["2026-02-30", undefined],
    ["2026-09-21T", "2026-09-21T"],
  ])("omits only impossible calendar metadata for %s", (published, expected) => {
    const normalized = normalize({
      results: [
        {
          title: "result title",
          url: "https://example.com/result",
          snippet: "result snippet",
          published,
        },
      ],
    });

    assertOutputKind(normalized, "results");
    expect(normalized.results).toHaveLength(1);
    const row = normalized.results[0];
    expect(row?.url).toBe("https://example.com/result");
    expect(stripWrapMarkers(row?.title ?? "")).toBe("result title");
    expect(stripWrapMarkers(row?.snippet ?? "")).toBe("result snippet");
    expect(row?.published).toBe(expected);
    if (expected === undefined) {
      expect(row).not.toHaveProperty("published");
    }
  });

  it("bounds the aggregate untrusted result URLs, titles, snippets, and site names", () => {
    const normalized = normalize({
      results: Array.from({ length: 10 }, (_, index) => ({
        title: "t".repeat(15_000),
        url: `https://example.com/${index}`,
        snippet: "s".repeat(15_000),
        siteName: "n".repeat(15_000),
      })),
    });

    assertOutputKind(normalized, "results");
    const untrustedContentChars = normalized.results.reduce(
      (total, row) =>
        total +
        row.url.length +
        stripWrapMarkers(row.title).length +
        stripWrapMarkers(row.snippet ?? "").length +
        stripWrapMarkers(row.siteName ?? "").length,
      0,
    );
    expect(normalized.truncated).toBe(true);
    expect(untrustedContentChars).toBeLessThanOrEqual(20_000);
    expect(JSON.stringify(normalized).length).toBeLessThan(22_000);
  });

  it("charges final sanitized answer text when short special tokens expand", () => {
    const normalized = normalize({ content: "<s>".repeat(6_666) });
    expect(normalized).toMatchObject({ kind: "answer", truncated: true });
    expect(JSON.stringify(normalized).length).toBeLessThan(21_000);
    expect(JSON.stringify(normalized)).not.toContain("<s>");
  });

  it("bounds citations and their URLs and titles within the shared answer budget", () => {
    const normalized = normalize({
      content: "answer body",
      citations: Array.from({ length: 25 }, (_, index) => ({
        url: `https://example.com/citation/${index}`,
        title: `citation ${index}`,
      })),
    });

    assertOutputKind(normalized, "answer");
    expect(normalized.citations).toHaveLength(20);
    expect(normalized.truncated).toBe(true);
  });

  it("reserves valid source URLs when an answer already fills the provider content cap", () => {
    const normalized = normalize({
      content: "x".repeat(20_000),
      citations: ["https://example.com/first", "https://example.com/second"],
    });

    assertOutputKind(normalized, "answer");
    expect(normalized.citations).toEqual([
      { url: "https://example.com/first" },
      { url: "https://example.com/second" },
    ]);
    expect(normalized.truncated).toBe(true);
    expect(JSON.stringify(normalized).length).toBeLessThan(20_500);
  });

  it("keeps the first valid citation after malformed provider entries", () => {
    const normalized = normalize({
      content: "answer",
      citations: [
        ...Array.from({ length: 20 }, () => "invalid citation"),
        "https://example.com/valid",
      ],
    });

    assertOutputKind(normalized, "answer");
    expect(normalized.citations).toEqual([{ url: "https://example.com/valid" }]);
  });

  it("bounds provider-controlled error text and rejects oversized unwrapped docs URLs", () => {
    const normalized = normalize({
      error: "e".repeat(3_000),
      message: `${"m".repeat(1_997)}🤖${"m".repeat(20_000)}`,
      docs: `https://example.com/${"x".repeat(3_000)}`,
    });

    assertOutputKind(normalized, "error");
    const unwrapped = stripWrapMarkers(normalized.message);
    expect(unwrapped).toHaveLength(3_999);
    expect(unwrapped).toBe(`${"e".repeat(2_000)}: ${"m".repeat(1_997)}`);
    expect(normalized.docs).toBeUndefined();
  });

  it("rejects citations whose normalized Unicode URL expands beyond the hard bound", () => {
    const expandedUrl = `https://example.com/${"🦀".repeat(1_000)}`;
    expect(expandedUrl.length).toBeLessThan(2_048);
    const normalized = normalize({
      content: "body",
      citations: [expandedUrl, "https://example.com/🦀"],
    });

    assertOutputKind(normalized, "answer");
    expect(normalized.citations).toEqual([{ url: "https://example.com/%F0%9F%A6%80" }]);
  });

  it("preserves the raw compatibility branch when a malformed result follows ten valid rows", () => {
    const payload = {
      results: [
        ...Array.from({ length: 10 }, (_, index) => ({
          title: `valid ${index}`,
          url: `https://example.com/${index}`,
        })),
        { name: "provider-specific", link: "https://example.com/custom" },
      ],
    };

    expect(normalize(payload)).toEqual({ kind: "raw", provider: "external-demo", data: payload });
  });
});
