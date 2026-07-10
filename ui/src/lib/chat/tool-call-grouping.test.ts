// Control UI tests cover collapsed tool-group summary labels.
import { describe, expect, it } from "vitest";
import { summarizeToolGroup, type ToolGroupSummaryInput } from "./tool-call-grouping.ts";

describe("summarizeToolGroup", () => {
  it("builds a capitalized multi-segment label with a failure suffix", () => {
    const cards: ToolGroupSummaryInput[] = [
      { name: "bash", args: { command: "ls" } },
      { name: "bash", args: { command: "pwd" }, isError: true },
      { name: "read", args: { path: "/repo/a.ts" } },
      { name: "read", args: { path: "/repo/b.ts" } },
      { name: "edit", args: { path: "/repo/a.ts", oldText: "x", newText: "y" } },
      { name: "edit", args: { path: "/repo/a.ts", oldText: "y", newText: "z" } },
      { name: "write", args: { path: "/repo/new.ts", content: "hi" } },
      { name: "grep", args: { pattern: "TODO" } },
      { name: "web_fetch", args: { url: "https://x.dev" } },
    ];

    expect(summarizeToolGroup(cards)).toBe(
      "Ran 2 commands, read 2 files, edited a file, created a file, ran a search, fetched a page · 1 failed",
    );
  });

  it.each<[string, ToolGroupSummaryInput[], string]>([
    ["a single command", [{ name: "bash", args: { command: "ls" } }], "Ran a command"],
    [
      "distinct paths over call count",
      [
        { name: "read", args: { path: "/repo/a.ts" } },
        { name: "read", args: { path: "/repo/a.ts" } },
        { name: "read", args: { path: "/repo/b.ts" } },
      ],
      "Read 2 files",
    ],
    [
      "call count when reads carry no paths",
      [
        { name: "read", args: {} },
        { name: "read", args: {} },
      ],
      "Read 2 files",
    ],
    [
      "multiple searches",
      [
        { name: "grep", args: { pattern: "a" } },
        { name: "glob", args: { pattern: "b" } },
      ],
      "Ran 2 searches",
    ],
    ["one generic tool by name", [{ name: "mcp__linear" }], "Used mcp__linear"],
    [
      "repeat generic tool with a multiplier",
      [{ name: "mcp__linear" }, { name: "mcp__linear" }],
      "Used mcp__linear ×2",
    ],
    [
      "many distinct generic tools as a count",
      [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }],
      "Used 3 tools",
    ],
  ])("summarizes %s", (_label, cards, expected) => {
    expect(summarizeToolGroup(cards)).toBe(expected);
  });
});
