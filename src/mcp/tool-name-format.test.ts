import { describe, expect, it } from "vitest";
import {
  formatMcpToolNameForLog,
  formatMcpToolNamesForLog,
  parseMcpToolName,
} from "./tool-name-format.js";

describe("mcp tool name formatting", () => {
  it("parses mcp__{server}__{tool}", () => {
    expect(parseMcpToolName("mcp__github__create_issue")).toEqual({
      server: "github",
      tool: "create_issue",
    });
  });

  it("keeps extra __ segments in the tool portion", () => {
    expect(parseMcpToolName("mcp__server__tool__with__parts")).toEqual({
      server: "server",
      tool: "tool__with__parts",
    });
  });

  it("formats to {server}:{tool}", () => {
    expect(formatMcpToolNameForLog("mcp__clawdbrain__exec")).toBe("clawdbrain:exec");
    expect(formatMcpToolNameForLog("  mcp__clawdbrain__web_fetch  ")).toBe("clawdbrain:web_fetch");
  });

  it("returns null for non-mcp tool names", () => {
    expect(formatMcpToolNameForLog("exec")).toBeNull();
    expect(formatMcpToolNameForLog("")).toBeNull();
    expect(formatMcpToolNameForLog("mcp__onlyserver")).toBeNull();
    expect(formatMcpToolNameForLog("mcp____tool")).toBeNull();
    expect(formatMcpToolNameForLog("mcp__server__")).toBeNull();
  });

  it("dedupes, sorts, and truncates lists", () => {
    const result = formatMcpToolNamesForLog(
      ["mcp__b__two", "mcp__a__one", "mcp__a__one", "exec", "mcp__c__three"],
      { max: 2 },
    );
    expect(result.formatted).toEqual(["a:one", "b:two"]);
    expect(result.truncated).toBe(true);
    expect(result.remaining).toBe(1);
  });

  it("truncates by maxChars when needed", () => {
    const result = formatMcpToolNamesForLog(
      ["mcp__s__tool_a", "mcp__s__tool_b", "mcp__s__tool_c"],
      { max: 60, maxChars: 12 },
    );
    // "s:tool_a" is 8 chars, adding ",s:tool_b" would exceed 12.
    expect(result.formatted).toEqual(["s:tool_a"]);
    expect(result.truncated).toBe(true);
    expect(result.remaining).toBe(2);
  });
});
