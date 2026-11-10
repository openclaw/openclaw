import { describe, expect, it } from "vitest";
import type { ToolCall, ToolResultMessage } from "../llm/types.js";
import { summarizeCronToolProbe } from "./gateway-cron-tools-allow.test-helpers.js";

const privateText = "synthetic-private-/workspace/file-provider-model-token";
function call(name: string, id = privateText): ToolCall {
  return { type: "toolCall", id, name, arguments: { code: privateText } };
}
function result(text: string, toolCallId = privateText): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "exec",
    isError: true,
    content: [{ type: "text", text }],
    timestamp: 0,
  };
}

describe("cron tool probe diagnostics", () => {
  it("preserves correlation and error facts without disclosing content or identities", () => {
    const summary = summarizeCronToolProbe({
      calls: [call("exec"), call(privateText, "unmatched")],
      results: [result(`ReferenceError: ${privateText} MARKER`), result("no detail", "orphan")],
      assistantText: "NO_TOOLS",
      marker: "MARKER",
    });
    expect(summary).not.toContain(privateText);
    expect(summary).not.toContain("MARKER");
    expect(summary).not.toContain("unmatched");
    expect(summary).not.toContain("orphan");
    expect(JSON.parse(summary)).toEqual({
      calls: [
        { call: 0, tool: "exec", argumentShape: "code-wrapper", matchingResults: [0] },
        { call: 1, tool: "other", argumentShape: "not-exec", matchingResults: [] },
      ],
      results: [
        {
          result: 0,
          tool: "exec",
          matchingCalls: [0],
          nameMatchesCall: true,
          isError: true,
          markerPresent: true,
          category: "reference-error",
        },
        {
          result: 1,
          tool: "exec",
          matchingCalls: [],
          nameMatchesCall: false,
          isError: true,
          markerPresent: false,
          category: "unclassified",
        },
      ],
      assistantMarkerPresent: false,
      assistantNoTools: true,
    });
  });

  it.each([
    ["TypeError: private detail", "type-error"],
    ["SyntaxError: private detail", "syntax-error"],
    ["Unknown tool: private detail", "unknown-tool"],
    ["Permission denied: private detail", "permission-error"],
    ["private detail", "unclassified"],
  ])("reports only a fixed category for %s", (text, category) => {
    const summary = summarizeCronToolProbe({
      calls: [],
      results: [result(text)],
      assistantText: "",
      marker: "MARKER",
    });
    expect(JSON.parse(summary).results[0].category).toBe(category);
    expect(summary).not.toContain("private detail");
  });

  it("does not convert code mentioning read into a successful read receipt", () => {
    const wrapper = call("exec");
    wrapper.arguments = { code: 'await read({ path: "secret" })' };
    const output = result("MARKER");
    output.isError = false;
    const summary = JSON.parse(
      summarizeCronToolProbe({
        calls: [wrapper, call("read", "read-id")],
        results: [output],
        assistantText: "MARKER",
        marker: "MARKER",
      }),
    );
    expect(summary.calls[0].tool).toBe("exec");
    expect(summary.calls[1].matchingResults).toEqual([]);
    expect(summary.results[0].tool).toBe("exec");
    expect(summary.results[0].isError).toBe(false);
    expect(summary.assistantMarkerPresent).toBe(true);
    expect(summary.assistantNoTools).toBe(false);
  });
});
