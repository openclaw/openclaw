import { describe, expect, it } from "vitest";
import { parseQmdQueryJson } from "./qmd-query-parser.js";

describe("parseQmdQueryJson", () => {
  it("parses plain JSON output", () => {
    const result = parseQmdQueryJson(
      '[{"docid":"#abc123","score":0.9,"file":"qmd://citadel/a.md","snippet":"hello"}]',
      "",
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.docid).toBe("#abc123");
  });

  it("parses JSON payload when progress lines are mixed into stdout", () => {
    const stdout = [
      "Expanding query...",
      "Searching 2 lexical + 2 vector queries...",
      "\u001b]9;4;3\u0007Reranking not supported by OpenAI provider, returning original order.",
      "\u001b]9;4;0\u0007",
      "[",
      '  {"docid":"#abc123","score":1,"file":"qmd://citadel/a.md","snippet":"text"}',
      "]",
    ].join("\n");

    const result = parseQmdQueryJson(stdout, "");
    expect(result).toHaveLength(1);
    expect(result[0]?.file).toBe("qmd://citadel/a.md");
  });

  it("returns empty when no-results marker is present", () => {
    const stdout = [
      "Expanding query...",
      "Searching 2 lexical + 2 vector queries...",
      "No results found above minimum score threshold.",
    ].join("\n");

    const result = parseQmdQueryJson(stdout, "");
    expect(result).toEqual([]);
  });

  it("returns empty when stderr contains no-results marker and stdout is empty", () => {
    const result = parseQmdQueryJson("", "No results found.");
    expect(result).toEqual([]);
  });

  it("throws when output has no JSON payload and no no-results marker", () => {
    expect(() => parseQmdQueryJson("Reranking documents...", "bad things happened")).toThrow(
      "qmd query returned invalid JSON",
    );
  });
});
