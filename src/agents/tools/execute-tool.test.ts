import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./common.js";
import {
  buildErrorContextParts,
  describeError,
  executeToolWithErrorHandling,
  extractFirstLine,
  extractHttpStatusCode,
} from "./execute-tool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStubTool(name: string, overrides?: Partial<AnyAgentTool>): AnyAgentTool {
  return {
    name,
    label: overrides?.label ?? name,
    description: overrides?.description ?? `Stub tool: ${name}`,
    parameters:
      overrides?.parameters ??
      Type.Object({
        input: Type.String({ description: "Test input" }),
      }),
    execute:
      overrides?.execute ??
      (async () => ({
        content: [{ type: "text", text: `${name} result` }],
        details: undefined,
      })),
  };
}

// ---------------------------------------------------------------------------
// extractFirstLine
// ---------------------------------------------------------------------------

describe("extractFirstLine", () => {
  it("returns full text when no line breaks and under max length", () => {
    expect(extractFirstLine("simple message")).toBe("simple message");
  });

  it("truncates at first LF", () => {
    expect(extractFirstLine("first line\nsecond line\nthird line")).toBe("first line");
  });

  it("truncates at first CR", () => {
    expect(extractFirstLine("first line\rsecond line")).toBe("first line");
  });

  it("truncates at earliest of LF or CR", () => {
    expect(extractFirstLine("line one\r\nline two")).toBe("line one");
    expect(extractFirstLine("line one\n\rline two")).toBe("line one");
  });

  it("truncates long single lines to maxLength", () => {
    const longText = "x".repeat(300);
    const result = extractFirstLine(longText, 240);
    expect(result).toHaveLength(241); // 240 + "…"
    expect(result.endsWith("…")).toBe(true);
  });

  it("truncates long first lines to maxLength", () => {
    const longFirstLine = "x".repeat(300);
    const text = `${longFirstLine}\nsecond line`;
    const result = extractFirstLine(text, 240);
    expect(result).toHaveLength(241);
    expect(result.endsWith("…")).toBe(true);
  });

  it("extracts exit code from end and prepends to first line", () => {
    const text = "fatal: not a git repo\n/tmp/test\nCommand exited with code 128";
    const result = extractFirstLine(text);
    expect(result).toBe("Command exited with code 128 :: fatal: not a git repo");
  });

  it("extracts signal termination from end", () => {
    const text = "stdout line 1\nstdout line 2\nCommand aborted by signal SIGTERM";
    const result = extractFirstLine(text);
    expect(result).toBe("Command aborted by signal SIGTERM :: stdout line 1");
  });

  it("extracts abort message from end", () => {
    const text = "partial output\nCommand aborted before exit code was captured";
    const result = extractFirstLine(text);
    expect(result).toBe("Command aborted before exit code was captured :: partial output");
  });

  it("truncates combined exit code + first line to maxLength", () => {
    const longFirstLine = "x".repeat(200);
    const text = `${longFirstLine}\nCommand exited with code 1`;
    const result = extractFirstLine(text, 100);
    expect(result).toHaveLength(101);
    expect(result.endsWith("…")).toBe(true);
    expect(result.startsWith("Command exited with code 1")).toBe(true);
  });

  it("handles empty string", () => {
    expect(extractFirstLine("")).toBe("");
  });

  it("handles string with only newlines", () => {
    expect(extractFirstLine("\n\n")).toBe("");
  });

  it("handles text without exit code at end", () => {
    const text = "error message\nmore details\nCommand exited with code 128 in the middle";
    const result = extractFirstLine(text);
    // Exit code pattern only matches at the END of the string, so this won't match
    expect(result).toBe("error message");
  });
});

// ---------------------------------------------------------------------------
// describeError
// ---------------------------------------------------------------------------

describe("describeError", () => {
  it("extracts message and stack from Error", () => {
    const err = new Error("Something broke");
    const described = describeError(err);
    expect(described.message).toBe("Something broke");
    expect(described.stack).toBeDefined();
    expect(described.stack).toContain("Something broke");
  });

  it("handles Error with empty message", () => {
    const err = new Error("");
    const described = describeError(err);
    expect(described.message).toBe("Error"); // String(err) fallback
  });

  it("handles Error with whitespace-only message", () => {
    const err = new Error("   ");
    const described = describeError(err);
    // When message is whitespace-only, trim() returns "" which is falsy
    // so describeError falls back to String(err) which is "Error:    "
    expect(described.message).toBe("Error:    ");
  });

  it("converts non-Error to string", () => {
    expect(describeError("string error").message).toBe("string error");
    expect(describeError(42).message).toBe("42");
    expect(describeError(null).message).toBe("null");
    expect(describeError(undefined).message).toBe("undefined");
    expect(describeError({ custom: "error" }).message).toBe("[object Object]");
  });

  it("does not include stack for non-Error", () => {
    const described = describeError("string error");
    expect(described.stack).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractHttpStatusCode
// ---------------------------------------------------------------------------

describe("extractHttpStatusCode", () => {
  it("extracts status code from parentheses format", () => {
    expect(extractHttpStatusCode("Request failed (404)")).toBe(404);
    expect(extractHttpStatusCode("Server error (500)")).toBe(500);
    expect(extractHttpStatusCode("Unauthorized (403)")).toBe(403);
  });

  it("extracts status code from status= format", () => {
    expect(extractHttpStatusCode("Error with status=404")).toBe(404);
    expect(extractHttpStatusCode("status=500 internal error")).toBe(500);
  });

  it("extracts status code from status: format", () => {
    expect(extractHttpStatusCode("Error with status: 404")).toBe(404);
    expect(extractHttpStatusCode("status: 500 internal error")).toBe(500);
  });

  it("extracts status code from status (space) format", () => {
    expect(extractHttpStatusCode("Error with status 404")).toBe(404);
    expect(extractHttpStatusCode("status 500 internal error")).toBe(500);
  });

  it("returns undefined when no status code found", () => {
    expect(extractHttpStatusCode("Generic error message")).toBeUndefined();
    expect(extractHttpStatusCode("Error without code")).toBeUndefined();
  });

  it("returns undefined for non-HTTP status codes", () => {
    expect(extractHttpStatusCode("Error code 12")).toBeUndefined(); // not 3 digits
    expect(extractHttpStatusCode("Status 1234")).toBeUndefined(); // 4 digits
  });

  it("is case insensitive for status keyword", () => {
    expect(extractHttpStatusCode("Error with STATUS=404")).toBe(404);
    expect(extractHttpStatusCode("Error with Status: 500")).toBe(500);
  });

  it("prefers parentheses format over status keyword", () => {
    // When both formats present, parentheses should match first
    expect(extractHttpStatusCode("Error (404) with status=500")).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// buildErrorContextParts
// ---------------------------------------------------------------------------

describe("buildErrorContextParts", () => {
  it("includes toolCallId", () => {
    const ctx = {
      toolCallId: "call-123",
      toolName: "web_fetch",
      normalizedToolName: "web_fetch",
      params: {},
    };
    const parts = buildErrorContextParts(ctx, {});
    expect(parts).toContain("toolCallId=call-123");
  });

  it("includes sessionKey when present", () => {
    const ctx = {
      toolCallId: "call-123",
      toolName: "web_fetch",
      normalizedToolName: "web_fetch",
      params: {},
      sessionKey: "session-456",
    };
    const parts = buildErrorContextParts(ctx, {});
    expect(parts).toContain("sessionId=session-456");
  });

  it("excludes sessionKey when not present", () => {
    const ctx = {
      toolCallId: "call-123",
      toolName: "web_fetch",
      normalizedToolName: "web_fetch",
      params: {},
    };
    const parts = buildErrorContextParts(ctx, {});
    expect(parts.some((p) => p.startsWith("sessionId="))).toBe(false);
  });

  it("includes exec command context for exec tool", () => {
    const ctx = {
      toolCallId: "call-123",
      toolName: "exec",
      normalizedToolName: "exec",
      params: { command: "git status", workdir: "/tmp/repo" },
    };
    const parts = buildErrorContextParts(ctx, ctx.params);
    expect(parts.some((p) => p.startsWith("cmd="))).toBe(true);
    expect(parts.some((p) => p.startsWith("cwd="))).toBe(true);
    expect(parts.find((p) => p.startsWith("cmd="))).toBe('cmd="git status"');
    expect(parts.find((p) => p.startsWith("cwd="))).toBe('cwd="/tmp/repo"');
  });

  it("excludes exec context for non-exec tools", () => {
    const ctx = {
      toolCallId: "call-123",
      toolName: "web_fetch",
      normalizedToolName: "web_fetch",
      params: { command: "git status" }, // has command but not an exec tool
    };
    const parts = buildErrorContextParts(ctx, ctx.params);
    expect(parts.some((p) => p.startsWith("cmd="))).toBe(false);
  });

  it("truncates long exec commands to 240 chars", () => {
    const longCommand = "x".repeat(300);
    const ctx = {
      toolCallId: "call-123",
      toolName: "exec",
      normalizedToolName: "exec",
      params: { command: longCommand },
    };
    const parts = buildErrorContextParts(ctx, ctx.params);
    const cmdPart = parts.find((p) => p.startsWith("cmd="));
    expect(cmdPart).toBeDefined();
    // JSON.stringify adds quotes, so total length is cmd= + quotes + content + …
    expect(cmdPart!.length).toBeLessThan(260);
  });

  it("includes web_fetch URL for 404 status code", () => {
    const ctx = {
      toolCallId: "call-123",
      toolName: "web_fetch",
      normalizedToolName: "web_fetch",
      params: { url: "https://example.com/missing" },
    };
    const errorMessage = "Request failed with status code (404)";
    const parts = buildErrorContextParts(ctx, ctx.params, errorMessage);
    expect(parts.some((p) => p.includes("url="))).toBe(true);
    expect(parts.find((p) => p.includes("url="))).toContain("https://example.com/missing");
  });

  it("includes web_fetch URL for 500 status code", () => {
    const ctx = {
      toolCallId: "call-123",
      toolName: "web_fetch",
      normalizedToolName: "web_fetch",
      params: { url: "https://example.com/error" },
    };
    const errorMessage = "Server error: status=500";
    const parts = buildErrorContextParts(ctx, ctx.params, errorMessage);
    expect(parts.some((p) => p.includes("url="))).toBe(true);
  });

  it("excludes web_fetch URL for 200 status code", () => {
    const ctx = {
      toolCallId: "call-123",
      toolName: "web_fetch",
      normalizedToolName: "web_fetch",
      params: { url: "https://example.com/ok" },
    };
    const errorMessage = "Unexpected response with status 200";
    const parts = buildErrorContextParts(ctx, ctx.params, errorMessage);
    expect(parts.some((p) => p.includes("url="))).toBe(false);
  });

  it("excludes web_fetch URL for 301 status code", () => {
    const ctx = {
      toolCallId: "call-123",
      toolName: "web_fetch",
      normalizedToolName: "web_fetch",
      params: { url: "https://example.com/redirect" },
    };
    const errorMessage = "Redirect with status: 301";
    const parts = buildErrorContextParts(ctx, ctx.params, errorMessage);
    expect(parts.some((p) => p.includes("url="))).toBe(false);
  });

  it("excludes web_fetch URL when no error message provided", () => {
    const ctx = {
      toolCallId: "call-123",
      toolName: "web_fetch",
      normalizedToolName: "web_fetch",
      params: { url: "https://example.com/test" },
    };
    const parts = buildErrorContextParts(ctx, ctx.params); // no errorMessage
    expect(parts.some((p) => p.includes("url="))).toBe(false);
  });

  it("includes web_search query", () => {
    const ctx = {
      toolCallId: "call-123",
      toolName: "web_search",
      normalizedToolName: "web_search",
      params: { query: "anthropic claude ai models" },
    };
    const parts = buildErrorContextParts(ctx, ctx.params);
    expect(parts.some((p) => p.includes("query="))).toBe(true);
    expect(parts.find((p) => p.includes("query="))).toContain("anthropic claude ai models");
  });

  it("truncates long web_search queries to 240 chars", () => {
    const longQuery = "search ".repeat(50); // ~300 chars
    const ctx = {
      toolCallId: "call-123",
      toolName: "web_search",
      normalizedToolName: "web_search",
      params: { query: longQuery },
    };
    const parts = buildErrorContextParts(ctx, ctx.params);
    const queryPart = parts.find((p) => p.startsWith("query="));
    expect(queryPart).toBeDefined();
    // JSON.stringify adds quotes, so total length is query= + quotes + content + …
    expect(queryPart!.length).toBeLessThan(260);
  });

  it("excludes web tool context for non-web tools", () => {
    const ctx = {
      toolCallId: "call-123",
      toolName: "other",
      normalizedToolName: "other",
      params: { url: "https://example.com", query: "test" },
    };
    const parts = buildErrorContextParts(ctx, ctx.params, "error with status=404");
    expect(parts.some((p) => p.includes("url="))).toBe(false);
    expect(parts.some((p) => p.includes("query="))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// executeToolWithErrorHandling
// ---------------------------------------------------------------------------

describe("executeToolWithErrorHandling", () => {
  it("returns successful result", async () => {
    const executeFn = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "success" }],
      details: { ok: true },
    });
    const tool = createStubTool("test", { execute: executeFn });

    const { result, durationMs, aborted, error } = await executeToolWithErrorHandling(tool, {
      toolCallId: "call-1",
      toolName: "test",
      normalizedToolName: "test",
      params: { input: "hello" },
    });

    expect(result.content).toEqual([{ type: "text", text: "success" }]);
    expect(result.details).toEqual({ ok: true });
    expect(durationMs).toBeGreaterThanOrEqual(0);
    expect(aborted).toBeUndefined();
    expect(error).toBeUndefined();
  });

  it("passes correct arguments to tool.execute", async () => {
    const executeFn = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const tool = createStubTool("test", { execute: executeFn });

    const controller = new AbortController();
    const onUpdate = vi.fn();

    await executeToolWithErrorHandling(tool, {
      toolCallId: "call-1",
      toolName: "test",
      normalizedToolName: "test",
      params: { input: "hello" },
      signal: controller.signal,
      onUpdate,
    });

    expect(executeFn).toHaveBeenCalledWith(
      "call-1",
      { input: "hello" },
      controller.signal,
      onUpdate,
    );
  });

  it("returns error info on tool failure", async () => {
    const executeFn = vi.fn().mockRejectedValue(new Error("Something went wrong"));
    const tool = createStubTool("failing", { execute: executeFn });

    const { result, error, aborted } = await executeToolWithErrorHandling(tool, {
      toolCallId: "call-1",
      toolName: "failing",
      normalizedToolName: "failing",
      params: {},
    });

    expect(aborted).toBeUndefined();
    expect(error).toBeDefined();
    expect(error!.message).toBe("Something went wrong");
    expect(error!.stack).toBeDefined();

    // Result should be a JSON error
    const content = result.content[0] as { type: string; text: string };
    expect(content.type).toBe("text");
    const parsed = JSON.parse(content.text);
    expect(parsed.status).toBe("error");
    expect(parsed.tool).toBe("failing");
    expect(parsed.error).toBe("Something went wrong");
  });

  it("handles AbortError from thrown exception", async () => {
    const abortError = new DOMException("aborted", "AbortError");
    const executeFn = vi.fn().mockRejectedValue(abortError);
    const tool = createStubTool("abortable", { execute: executeFn });

    const { aborted, error } = await executeToolWithErrorHandling(tool, {
      toolCallId: "call-1",
      toolName: "abortable",
      normalizedToolName: "abortable",
      params: {},
    });

    expect(aborted).toBe(true);
    expect(error).toBeUndefined();
  });

  it("handles abort via signal.aborted", async () => {
    const executeFn = vi.fn().mockRejectedValue(new Error("random error"));
    const tool = createStubTool("abortable", { execute: executeFn });

    const controller = new AbortController();
    controller.abort();

    const { aborted } = await executeToolWithErrorHandling(tool, {
      toolCallId: "call-1",
      toolName: "abortable",
      normalizedToolName: "abortable",
      params: {},
      signal: controller.signal,
    });

    expect(aborted).toBe(true);
  });

  it("handles non-Error objects as errors", async () => {
    const executeFn = vi.fn().mockRejectedValue("string error");
    const tool = createStubTool("string-error", { execute: executeFn });

    const { error } = await executeToolWithErrorHandling(tool, {
      toolCallId: "call-1",
      toolName: "string-error",
      normalizedToolName: "string_error",
      params: {},
    });

    expect(error).toBeDefined();
    expect(error!.message).toBe("string error");
    expect(error!.stack).toBeUndefined();
  });

  it("includes sessionKey and agentId in structured logging context", async () => {
    const executeFn = vi.fn().mockRejectedValue(new Error("test error"));
    const tool = createStubTool("context-test", { execute: executeFn });

    // We're mainly testing that the function doesn't throw when these are provided
    const { error } = await executeToolWithErrorHandling(tool, {
      toolCallId: "call-1",
      toolName: "context-test",
      normalizedToolName: "context_test",
      params: {},
      sessionKey: "session-123",
      agentId: "agent-456",
    });

    expect(error).toBeDefined();
    // The structured logging happens internally; we just verify it doesn't break
  });

  it("measures execution duration", async () => {
    const executeFn = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { content: [{ type: "text", text: "ok" }] };
    });
    const tool = createStubTool("timed", { execute: executeFn });

    const { durationMs } = await executeToolWithErrorHandling(tool, {
      toolCallId: "call-1",
      toolName: "timed",
      normalizedToolName: "timed",
      params: {},
    });

    expect(durationMs).toBeGreaterThanOrEqual(10);
  });
});
