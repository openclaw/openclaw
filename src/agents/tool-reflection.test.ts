import { describe, expect, it, beforeEach } from "vitest";
import {
  classifyToolError,
  ToolFailureTracker,
  buildToolReflection,
  formatReflectionAnnotation,
  isToolResultError,
  extractErrorText,
  hasReflectionAnnotation,
  annotateToolResultWithReflection,
} from "./tool-reflection.js";

// ─── Helper: create a toolResult message ─────────────────────────────

function makeToolResult(text: string, opts?: { isError?: boolean }) {
  return {
    role: "toolResult" as const,
    toolCallId: "test-call-1",
    isError: opts?.isError ?? false,
    content: [{ type: "text" as const, text }],
  };
}

// ─── classifyToolError ───────────────────────────────────────────────

describe("classifyToolError", () => {
  it("classifies permission denied errors", () => {
    expect(classifyToolError("Error: EACCES: permission denied, open '/etc/shadow'")).toBe(
      "permission_denied",
    );
    expect(classifyToolError("Access denied to resource")).toBe("permission_denied");
    expect(classifyToolError("Operation not permitted")).toBe("permission_denied");
  });

  it("classifies not found errors", () => {
    expect(classifyToolError("Error: ENOENT: no such file or directory, open '/foo'")).toBe(
      "not_found",
    );
    expect(classifyToolError("Command not found: foobar")).toBe("not_found");
    expect(classifyToolError("The file /tmp/test.txt does not exist")).toBe("not_found");
  });

  it("classifies invalid parameter errors", () => {
    expect(classifyToolError("Missing required parameter: path")).toBe("invalid_params");
    expect(classifyToolError("Validation failed for input")).toBe("invalid_params");
    expect(classifyToolError("Invalid argument: expected string")).toBe("invalid_params");
  });

  it("classifies timeout errors", () => {
    expect(classifyToolError("Error: ETIMEDOUT")).toBe("timeout");
    expect(classifyToolError("Request timed out after 30s")).toBe("timeout");
    expect(classifyToolError("deadline exceeded")).toBe("timeout");
  });

  it("classifies rate limit errors", () => {
    expect(classifyToolError("Rate limit exceeded. Try again in 60s")).toBe("rate_limit");
    expect(classifyToolError("HTTP 429: Too Many Requests")).toBe("rate_limit");
    expect(classifyToolError("API quota exceeded")).toBe("rate_limit");
  });

  it("classifies format errors", () => {
    expect(classifyToolError("SyntaxError: Unexpected token }")).toBe("format_error");
    expect(classifyToolError("Parse error at line 5")).toBe("format_error");
    expect(classifyToolError("Invalid JSON: unterminated string")).toBe("format_error");
  });

  it("classifies size limit errors", () => {
    expect(classifyToolError("File too large to process")).toBe("size_limit");
    expect(classifyToolError("Exceeded upload size limit")).toBe("size_limit");
    expect(classifyToolError("Content was truncated due to size")).toBe("size_limit");
  });

  it("classifies connection errors", () => {
    expect(classifyToolError("Error: ECONNREFUSED 127.0.0.1:3000")).toBe("connection_error");
    expect(classifyToolError("ECONNRESET: connection reset by peer")).toBe("connection_error");
    expect(classifyToolError("DNS lookup failed")).toBe("connection_error");
  });

  it("classifies auth errors", () => {
    expect(classifyToolError("Unauthorized: invalid API key")).toBe("auth_error");
    expect(classifyToolError("Authentication failed")).toBe("auth_error");
    expect(classifyToolError("Invalid token provided")).toBe("auth_error");
  });

  it("classifies conflict errors", () => {
    expect(classifyToolError("File already exists: /tmp/output.txt")).toBe("conflict");
    expect(classifyToolError("EEXIST: file already exists")).toBe("conflict");
    expect(classifyToolError("Duplicate entry detected")).toBe("conflict");
  });

  it("returns unknown for unrecognized errors", () => {
    expect(classifyToolError("Something completely unexpected happened")).toBe("unknown");
    expect(classifyToolError("")).toBe("unknown");
  });
});

// ─── ToolFailureTracker ──────────────────────────────────────────────

describe("ToolFailureTracker", () => {
  let tracker: ToolFailureTracker;

  beforeEach(() => {
    tracker = new ToolFailureTracker(50, 5 * 60 * 1000);
  });

  it("records a failure and returns count of 1 for first occurrence", () => {
    const count = tracker.record("exec", "timeout");
    expect(count).toBe(1);
  });

  it("increments count for repeated same-pattern failures", () => {
    tracker.record("exec", "timeout");
    const count = tracker.record("exec", "timeout");
    expect(count).toBe(2);
  });

  it("tracks different patterns separately", () => {
    tracker.record("exec", "timeout");
    tracker.record("read", "not_found");
    expect(tracker.getCount("exec", "timeout")).toBe(1);
    expect(tracker.getCount("read", "not_found")).toBe(1);
  });

  it("same tool with different categories are separate patterns", () => {
    tracker.record("exec", "timeout");
    tracker.record("exec", "permission_denied");
    expect(tracker.getCount("exec", "timeout")).toBe(1);
    expect(tracker.getCount("exec", "permission_denied")).toBe(1);
  });

  it("evicts old records when maxRecords is exceeded", () => {
    const smallTracker = new ToolFailureTracker(3, 60_000);
    smallTracker.record("tool1", "unknown");
    smallTracker.record("tool2", "unknown");
    smallTracker.record("tool3", "unknown");
    smallTracker.record("tool4", "unknown");
    expect(smallTracker.size).toBe(3);
  });

  it("clear() removes all records", () => {
    tracker.record("exec", "timeout");
    tracker.record("exec", "timeout");
    tracker.clear();
    expect(tracker.size).toBe(0);
    expect(tracker.getCount("exec", "timeout")).toBe(0);
  });
});

// ─── buildToolReflection ─────────────────────────────────────────────

describe("buildToolReflection", () => {
  it("builds a reflection with correct category and diagnosis", () => {
    const reflection = buildToolReflection("read", "ENOENT: no such file or directory");
    expect(reflection.category).toBe("not_found");
    expect(reflection.diagnosis).toContain("read");
    expect(reflection.diagnosis).toContain("Not Found");
    expect(reflection.suggestions.length).toBeGreaterThan(0);
    expect(reflection.isRepeated).toBe(false);
    expect(reflection.repeatCount).toBe(1);
  });

  it("detects repeated failures with a tracker", () => {
    const tracker = new ToolFailureTracker();
    const r1 = buildToolReflection("read", "ENOENT: not found", tracker);
    expect(r1.isRepeated).toBe(false);
    expect(r1.repeatCount).toBe(1);

    const r2 = buildToolReflection("read", "ENOENT: another not found", tracker);
    expect(r2.isRepeated).toBe(true);
    expect(r2.repeatCount).toBe(2);
  });

  it("adds escalation suggestion after 3 repeats", () => {
    const tracker = new ToolFailureTracker();
    buildToolReflection("exec", "ETIMEDOUT", tracker);
    buildToolReflection("exec", "timed out", tracker);
    const r3 = buildToolReflection("exec", "timeout error", tracker);

    expect(r3.repeatCount).toBe(3);
    expect(r3.suggestions[0]).toContain("attempt #3");
    expect(r3.suggestions[0]).toContain("fundamentally different approach");
  });

  it("returns unknown category for unrecognized errors", () => {
    const reflection = buildToolReflection("custom_tool", "xyzzy something weird");
    expect(reflection.category).toBe("unknown");
    expect(reflection.suggestions.length).toBeGreaterThan(0);
  });
});

// ─── formatReflectionAnnotation ──────────────────────────────────────

describe("formatReflectionAnnotation", () => {
  it("formats a reflection as readable text", () => {
    const reflection = buildToolReflection("read", "ENOENT: no such file");
    const text = formatReflectionAnnotation(reflection);

    expect(text).toContain("Structured Reflection");
    expect(text).toContain("not_found");
    expect(text).toContain("Diagnosis:");
    expect(text).toContain("Suggested Actions:");
    expect(text).toContain("•");
  });

  it("includes repeat warning for repeated failures", () => {
    const tracker = new ToolFailureTracker();
    buildToolReflection("exec", "ETIMEDOUT", tracker);
    const reflection = buildToolReflection("exec", "timeout", tracker);
    const text = formatReflectionAnnotation(reflection);

    expect(text).toContain("Repeat: #2");
  });
});

// ─── isToolResultError ───────────────────────────────────────────────

describe("isToolResultError", () => {
  it("detects isError flag", () => {
    const msg = makeToolResult("some output", { isError: true });
    expect(isToolResultError(msg)).toBe(true);
  });

  it("detects Error: prefix in text", () => {
    const msg = makeToolResult("Error: something went wrong");
    expect(isToolResultError(msg)).toBe(true);
  });

  it("detects command exit codes", () => {
    const msg = makeToolResult("Command exited with code 1\nsome output");
    expect(isToolResultError(msg)).toBe(true);
  });

  it("detects Traceback", () => {
    const msg = makeToolResult("Traceback (most recent call last):\n  File...");
    expect(isToolResultError(msg)).toBe(true);
  });

  it("returns false for successful results", () => {
    const msg = makeToolResult("File content here\nAll good");
    expect(isToolResultError(msg)).toBe(false);
  });

  it("returns false for non-toolResult messages", () => {
    const msg = { role: "user" as const, content: "hello" };
    expect(isToolResultError(msg)).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isToolResultError(null as never)).toBe(false);
    expect(isToolResultError(undefined as never)).toBe(false);
  });
});

// ─── extractErrorText ────────────────────────────────────────────────

describe("extractErrorText", () => {
  it("extracts text from tool result content", () => {
    const msg = makeToolResult("Error: ENOENT");
    expect(extractErrorText(msg)).toBe("Error: ENOENT");
  });

  it("joins multiple text blocks", () => {
    const msg = {
      role: "toolResult" as const,
      toolCallId: "tc-1",
      content: [
        { type: "text" as const, text: "Line 1" },
        { type: "text" as const, text: "Line 2" },
      ],
    };
    expect(extractErrorText(msg)).toBe("Line 1\nLine 2");
  });

  it("returns null for non-text content", () => {
    const msg = { role: "toolResult" as const, toolCallId: "tc-1", content: [] };
    expect(extractErrorText(msg)).toBeNull();
  });

  it("returns null for null input", () => {
    expect(extractErrorText(null as never)).toBeNull();
  });
});

// ─── hasReflectionAnnotation ─────────────────────────────────────────

describe("hasReflectionAnnotation", () => {
  it("returns false for messages without reflection", () => {
    const msg = makeToolResult("Error: something failed", { isError: true });
    expect(hasReflectionAnnotation(msg)).toBe(false);
  });

  it("returns true for messages with reflection", () => {
    const reflection = buildToolReflection("exec", "timeout");
    const annotation = formatReflectionAnnotation(reflection);
    const msg = makeToolResult("Error: timeout" + annotation, { isError: true });
    expect(hasReflectionAnnotation(msg)).toBe(true);
  });
});

// ─── annotateToolResultWithReflection ────────────────────────────────

describe("annotateToolResultWithReflection", () => {
  it("annotates an error tool result", () => {
    const msg = makeToolResult("Error: ENOENT: no such file or directory", { isError: true });
    const annotated = annotateToolResultWithReflection(msg, "read");

    const text = extractErrorText(annotated);
    expect(text).toContain("Structured Reflection");
    expect(text).toContain("not_found");
    expect(text).toContain("Verify the path or resource name");
  });

  it("does not annotate successful tool results", () => {
    const msg = makeToolResult("File content here");
    const annotated = annotateToolResultWithReflection(msg, "read");

    expect(annotated).toBe(msg); // Same reference = unchanged
  });

  it("does not double-annotate", () => {
    const msg = makeToolResult("Error: ENOENT: no such file", { isError: true });
    const once = annotateToolResultWithReflection(msg, "read");
    const twice = annotateToolResultWithReflection(once, "read");

    expect(twice).toBe(once); // Same reference = not re-annotated
  });

  it("does not annotate non-toolResult messages", () => {
    const msg = { role: "user" as const, content: "hello" };
    const annotated = annotateToolResultWithReflection(msg, "exec");
    expect(annotated).toBe(msg);
  });

  it("tracks repeated failures with a tracker", () => {
    const tracker = new ToolFailureTracker();

    const msg1 = makeToolResult("Error: ENOENT: file not found", { isError: true });
    annotateToolResultWithReflection(msg1, "read", tracker);

    const msg2 = makeToolResult("Error: ENOENT: another file not found", { isError: true });
    const annotated2 = annotateToolResultWithReflection(msg2, "read", tracker);
    const text2 = extractErrorText(annotated2);
    expect(text2).toContain("Repeat: #2");
  });

  it("handles messages with no text content", () => {
    const msg = {
      role: "toolResult" as const,
      toolCallId: "tc-1",
      isError: true,
      content: [{ type: "image" as const, data: "base64data" }],
    };
    const annotated = annotateToolResultWithReflection(msg as never, "image");
    expect(annotated).toBe(msg);
  });

  it("handles error detected by text patterns (no isError flag)", () => {
    const msg = makeToolResult("Error: EACCES: permission denied, open '/etc/shadow'");
    const annotated = annotateToolResultWithReflection(msg, "read");

    const text = extractErrorText(annotated);
    expect(text).toContain("Structured Reflection");
    expect(text).toContain("permission_denied");
  });
});

// ─── Edge Cases ──────────────────────────────────────────────────────

describe("edge cases", () => {
  it("classifyToolError handles special regex characters in input", () => {
    const result = classifyToolError("Error (no match): [test] $pecial ^chars");
    expect(result).toBe("unknown");
  });

  it("very long error messages are classified correctly", () => {
    const longError =
      "Error: ENOENT: no such file or directory\n" + "a".repeat(10_000) + "\nstack trace here";
    expect(classifyToolError(longError)).toBe("not_found");
  });

  it("tracker handles rapid successive calls", () => {
    const tracker = new ToolFailureTracker();
    for (let i = 0; i < 20; i++) {
      tracker.record("exec", "timeout");
    }
    expect(tracker.getCount("exec", "timeout")).toBe(20);
  });
});
