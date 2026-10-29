import { describe, expect, it } from "vitest";
import { normalizeWebSearchOutput, unwrapWebSearchOutputText } from "./web-search-output.js";

describe("web-search fair prose allocation", () => {
  it("preserves small later results and charges sanitized prose without reordering", () => {
    const lengths = [12_000, 9_000, 100, 100, 100, 100, 100, 100, 100, 100];
    const output = normalizeWebSearchOutput({
      provider: "fixture",
      query: "fair",
      result: {
        results: lengths.map((length, index) => ({
          title: `result ${index}`,
          url: `https://example.com/${index}`,
          snippet: "s".repeat(length),
          siteName: "example.com",
        })),
      },
    });
    if (output.kind !== "results") {
      throw new Error("expected results");
    }
    expect(output.truncated).toBe(true);
    expect(output.results.map((row) => row.url)).toEqual(
      lengths.map((_, index) => `https://example.com/${index}`),
    );
    expect(
      output.results.slice(1).map((row) => unwrapWebSearchOutputText(row.snippet ?? "").length),
    ).toEqual(lengths.slice(1));
    const prose = output.results
      .flatMap((row) => [row.title, row.snippet ?? "", row.siteName ?? ""])
      .map(unwrapWebSearchOutputText);
    expect(prose.reduce((sum, value) => sum + value.length, 0)).toBeLessThanOrEqual(20_000);
  });
  it("does not truncate small results when special token sanitization expands demand", () => {
    const output = normalizeWebSearchOutput({
      provider: "fixture",
      query: "sanitized",
      result: {
        results: [
          { title: "a", url: "https://example.com/a", snippet: "<s>".repeat(500) },
          { title: "b", url: "https://example.com/b", snippet: "x".repeat(6000) },
        ],
      },
    });
    if (output.kind !== "results") {
      throw new Error("expected results");
    }
    expect(output.truncated).toBeUndefined();
    expect(unwrapWebSearchOutputText(output.results[0]?.snippet ?? "")).toBe(
      "[REMOVED_SPECIAL_TOKEN]".repeat(500),
    );
    expect(unwrapWebSearchOutputText(output.results[1]?.snippet ?? "")).toBe("x".repeat(6000));
  });
});
