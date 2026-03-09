import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRunToolSpans,
  onToolResult,
  onToolStart,
  redactPayload,
  truncateString,
} from "./langfuse-agent-hooks.js";
import { withLangfuseRequestScope } from "./langfuse-request-scope.js";
import type { LangfuseHandle } from "./langfuse.js";

describe("langfuse agent hook payload safety", () => {
  afterEach(() => {
    clearRunToolSpans("run-1");
  });

  it("redacts sensitive keys recursively", () => {
    expect(
      redactPayload({
        token: "secret-token", // pragma: allowlist secret
        nested: {
          password: "p@ss",
          ok: "visible",
        },
      }),
    ).toEqual({
      token: "[REDACTED]",
      nested: {
        password: "[REDACTED]",
        ok: "visible",
      },
    });
  });

  it("truncates oversized strings and arrays", () => {
    const long = "x".repeat(2_100);
    const result = redactPayload({
      long,
      items: Array.from({ length: 25 }, (_, i) => i + 1),
    }) as { long: string; items: unknown[] };

    expect(result.long).toContain("…[truncated]");
    expect(result.long.length).toBeLessThan(long.length);
    expect(result.items).toHaveLength(21);
    expect(result.items.at(-1)).toBe("…[5 more items]");
  });

  it("truncateString adds truncation marker", () => {
    expect(truncateString("abcdef", 4)).toBe("abcd…[truncated]");
    expect(truncateString("abc", 4)).toBe("abc");
  });

  it("ignores incomplete duplicate tool lifecycle events from UI-oriented callbacks", () => {
    const spanEnd = vi.fn();
    const spanCaptureError = vi.fn();
    const traceSpan = vi.fn(
      () =>
        ({
          enabled: true,
          kind: "span",
          update: vi.fn(),
          end: spanEnd,
          captureError: spanCaptureError,
          span: vi.fn(),
          generation: vi.fn(),
        }) satisfies LangfuseHandle,
    );
    const trace = {
      enabled: true,
      kind: "trace",
      update: vi.fn(),
      end: vi.fn(),
      captureError: vi.fn(),
      span: traceSpan,
      generation: vi.fn(),
    } satisfies LangfuseHandle;

    withLangfuseRequestScope(
      {
        trace,
        requestName: "inbound.request",
      },
      () => {
        onToolStart("run-1", "tool-1", "sessions_spawn", null);
        onToolStart("run-1", "tool-1", "sessions_spawn", { task: "investigate" });
        onToolResult("run-1", "tool-1", undefined, true);
        onToolResult("run-1", "tool-1", { status: "accepted", runId: "child-1" }, false);
      },
    );

    expect(traceSpan).toHaveBeenCalledTimes(1);
    expect(traceSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "tool.sessions_spawn",
        input: { task: "investigate" },
      }),
    );
    expect(spanCaptureError).not.toHaveBeenCalled();
    expect(spanEnd).toHaveBeenCalledTimes(1);
    expect(spanEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        output: { status: "accepted", runId: "child-1" },
      }),
    );
  });
});
