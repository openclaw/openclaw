import { describe, expect, it } from "vitest";
import { summarizeToolErrorForAbort } from "./tool-error-summary.js";

// Mirrors the throw shape from validateToolArguments (packages/llm-core/src/validation.ts):
// a human-readable header + bullet detail, then a full echo of the model arguments.
function validationError(toolName: string, details: string, args: unknown): string {
  return `Validation failed for tool "${toolName}":\n${details}\n\nReceived arguments:\n${JSON.stringify(args, null, 2)}`;
}

describe("summarizeToolErrorForAbort", () => {
  it("summarizes a tool-call validation failure to one line", () => {
    const summary = summarizeToolErrorForAbort({
      toolName: "edit",
      error: validationError("edit", "  - edits: must have required properties edits", {
        path: "secret.txt",
        contents: "leaked",
      }),
    });

    expect(summary).toBe("edit tool validation failed: edits: must have required properties edits");
  });

  it("never leaks the echoed model arguments", () => {
    const summary = summarizeToolErrorForAbort({
      toolName: "edit",
      error: validationError("edit", "  - edits: must have required properties edits", {
        apiKey: "sk-should-not-appear",
      }),
    });

    expect(summary).not.toContain("Received arguments");
    expect(summary).not.toContain("sk-should-not-appear");
  });

  it("joins multiple validation issues", () => {
    const summary = summarizeToolErrorForAbort({
      toolName: "edit",
      error: validationError(
        "edit",
        "  - edits: must have required properties edits\n  - path: must be string",
        {},
      ),
    });

    expect(summary).toBe(
      "edit tool validation failed: edits: must have required properties edits; path: must be string",
    );
  });

  it("summarizes a non-validation tool error generically", () => {
    expect(summarizeToolErrorForAbort({ toolName: "browser", error: "tab not found" })).toBe(
      "browser tool failed: tab not found",
    );
  });

  it("returns undefined when there is no error text", () => {
    expect(summarizeToolErrorForAbort({ toolName: "edit" })).toBeUndefined();
    expect(summarizeToolErrorForAbort({ toolName: "edit", error: "   " })).toBeUndefined();
  });

  it("truncates an overly long detail", () => {
    const summary = summarizeToolErrorForAbort({
      toolName: "edit",
      error: validationError("edit", `  - edits: ${"x".repeat(400)}`, {}),
    });

    expect(summary?.length).toBeLessThanOrEqual(160);
    expect(summary?.endsWith("…")).toBe(true);
  });
});
