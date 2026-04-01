import { describe, expect, it } from "vitest";
import { stripMarkdown } from "./strip-markdown.js";

describe("stripMarkdown", () => {
  it("strips fenced code blocks, preserving content", () => {
    expect(stripMarkdown("```\nconst x = 1;\n```")).toBe("const x = 1;");
    expect(stripMarkdown("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
    expect(stripMarkdown("```sh\ngh repo list\n```")).toBe("gh repo list");
    expect(stripMarkdown("```txt\n/approve abc allow-once\n```")).toBe("/approve abc allow-once");
  });

  it("strips fenced code blocks embedded in approval messages", () => {
    const approvalMsg = [
      "Approval required.",
      "",
      "Run:",
      "",
      "```txt",
      "/approve 2e58a12e allow-once",
      "```",
      "",
      "Pending command:",
      "",
      "```sh",
      "gh repo list BestSelf-Company --limit 100",
      "```",
    ].join("\n");

    const result = stripMarkdown(approvalMsg);
    expect(result).not.toContain("```");
    expect(result).toContain("/approve 2e58a12e allow-once");
    expect(result).toContain("gh repo list BestSelf-Company --limit 100");
    expect(result).toContain("Approval required.");
  });

  it("strips fenced blocks before inline-code so triple-backtick fences are not partially consumed", () => {
    // Without the fenced-block fix, the inline-code regex (`[^`]+`) would eat
    // one backtick from the opening fence, leaving `` `` `` markers in output.
    const input = "```txt\nhello\n```";
    const result = stripMarkdown(input);
    expect(result).not.toContain("`");
    expect(result).toBe("hello");
  });
});

it("does not insert extra blank line when fence is adjacent to surrounding text", () => {
  const input = "prefix\n```sh\ncode\n```\nsuffix";
  const result = stripMarkdown(input);
  expect(result).toBe("prefix\ncode\nsuffix");
});
