import { describe, expect, it } from "vitest";
import { parseQmdMcporterJson, parseQmdQueryJson } from "./qmd-query-parser.js";

describe("parseQmdQueryJson", () => {
  it("parses clean qmd JSON output", () => {
    const results = parseQmdQueryJson('[{"docid":"abc","score":1,"snippet":"@@ -1,1\\none"}]', "");
    expect(results).toEqual([
      {
        docid: "abc",
        score: 1,
        snippet: "@@ -1,1\none",
      },
    ]);
  });

  it("extracts embedded result arrays from noisy stdout", () => {
    const results = parseQmdQueryJson(
      `initializing
{"payload":"ok"}
[{"docid":"abc","score":0.5}]
complete`,
      "",
    );
    expect(results).toEqual([{ docid: "abc", score: 0.5 }]);
  });

  it("treats plain-text no-results from stderr as an empty result set", () => {
    const results = parseQmdQueryJson("", "No results found\n");
    expect(results).toEqual([]);
  });

  it("treats prefixed no-results marker output as an empty result set", () => {
    expect(parseQmdQueryJson("warning: no results found", "")).toEqual([]);
    expect(parseQmdQueryJson("", "[qmd] warning: no results found\n")).toEqual([]);
  });

  it("does not treat arbitrary non-marker text as no-results output", () => {
    expect(() =>
      parseQmdQueryJson("warning: search completed; no results found for this query", ""),
    ).toThrow(/qmd query returned invalid JSON/i);
  });

  it("throws when stdout cannot be interpreted as qmd JSON", () => {
    expect(() => parseQmdQueryJson("this is not json", "")).toThrow(
      /qmd query returned invalid JSON/i,
    );
  });
});

describe("parseQmdMcporterJson", () => {
  it("parses mcporter structuredContent payloads", () => {
    const results = parseQmdMcporterJson(
      JSON.stringify({ structuredContent: { results: [{ docid: "abc", score: 0.4 }] } }),
      "",
    );
    expect(results).toEqual([{ docid: "abc", score: 0.4 }]);
  });

  it("parses JSON-RPC result payloads", () => {
    const results = parseQmdMcporterJson(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: [{ docid: "abc", score: 1 }] }),
      "",
    );
    expect(results).toEqual([{ docid: "abc", score: 1 }]);
  });

  it("extracts embedded JSON when stdout is noisy", () => {
    const results = parseQmdMcporterJson(
      `status: ok\n{"structuredContent":{"results":[{"docid":"abc","score":0.2}]}}\n`,
      "",
    );
    expect(results).toEqual([{ docid: "abc", score: 0.2 }]);
  });

  it("skips bracket-prefixed log lines when extracting JSON", () => {
    const results = parseQmdMcporterJson(
      `[INFO] warming cache\n{"structuredContent":{"results":[{"docid":"abc","score":0.3}]}}\n`,
      "",
    );
    expect(results).toEqual([{ docid: "abc", score: 0.3 }]);
  });

  it("throws when mcporter payload lacks results", () => {
    expect(() => parseQmdMcporterJson(JSON.stringify({ structuredContent: {} }), "")).toThrow(
      /qmd mcporter JSON response missing results array/i,
    );
  });
});
