import { describe, expect, it, vi, afterEach } from "vitest";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { redactPayload, truncateString, clearRunToolSpans } from "./langfuse-agent-hooks.js";
import { initializeLangfuseAgentHooks } from "./langfuse-agent-hooks.js";
import { withLangfuseRequestScope, getLangfuseRequestScope } from "./langfuse-request-scope.js";
import type { LangfuseHandle } from "./langfuse.js";

// ─────────────────────────────────────────────────────────────────────────────
// Payload redaction and safety
// ─────────────────────────────────────────────────────────────────────────────

describe("langfuse agent hook payload safety", () => {
  it("redacts sensitive keys recursively", () => {
    expect(
      redactPayload({
        token: "secret-token",
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

  it("redacts all known sensitive key names", () => {
    const keys = [
      "token",
      "secret",
      "password",
      "authorization",
      "apikey",
      "api_key",
      "auth",
      "credential",
      "private_key",
      "access_token",
      "refresh_token",
      "bearer",
    ];
    for (const key of keys) {
      const result = redactPayload({ [key]: "value" }) as Record<string, unknown>;
      expect(result[key]).toBe("[REDACTED]");
    }
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
    expect(truncateString("", 4)).toBe("");
  });

  it("handles null and undefined gracefully", () => {
    expect(redactPayload(null)).toBeNull();
    expect(redactPayload(undefined)).toBeUndefined();
    expect(redactPayload({ nested: null })).toEqual({ nested: null });
  });

  it("replaces over-depth payload branches with a safe sentinel", () => {
    const payload = {
      level0: {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: {
                  token: "secret-token",
                  long: "x".repeat(5_000),
                },
              },
            },
          },
        },
      },
    };

    expect(redactPayload(payload)).toEqual({
      level0: {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: "[max depth exceeded]",
              },
            },
          },
        },
      },
    });
  });

  it("does not throw on circular-like or deeply nested values", () => {
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 10; i++) {
      cur.child = {};
      cur = cur.child as Record<string, unknown>;
    }
    expect(() => redactPayload(deep)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool span bookkeeping and clearRunToolSpans
// ─────────────────────────────────────────────────────────────────────────────

function makeNoopHandle(): LangfuseHandle {
  return {
    enabled: true,
    kind: "span",
    update: vi.fn(),
    end: vi.fn(),
    captureError: vi.fn(),
    span: vi.fn(() => makeNoopHandle()),
    generation: vi.fn(() => makeNoopHandle()),
  };
}

function makeMockTrace(): LangfuseHandle {
  return {
    enabled: true,
    kind: "trace",
    update: vi.fn(),
    end: vi.fn(),
    captureError: vi.fn(),
    span: vi.fn(() => makeNoopHandle()),
    generation: vi.fn(() => makeNoopHandle()),
  };
}

describe("langfuse agent hooks — tool span lifecycle via emitAgentEvent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens a tool span on start event and closes on result via emitAgentEvent", async () => {
    // Ensure the global listener is registered.
    initializeLangfuseAgentHooks();

    const mockTrace = makeMockTrace();
    const spanEndFn = vi.fn();
    const spanHandle = {
      ...makeNoopHandle(),
      end: spanEndFn,
    };
    (mockTrace.span as ReturnType<typeof vi.fn>).mockReturnValueOnce(spanHandle);

    const runId = "run-abc-123";
    const toolCallId = "tc-001";

    // Emit tool start from within a request scope.
    await withLangfuseRequestScope({ trace: mockTrace, requestName: "test" }, async () => {
      emitAgentEvent({
        runId,
        stream: "tool",
        data: {
          phase: "start",
          name: "read",
          toolCallId,
          args: { path: "/tmp/test.txt" },
        },
      });
    });

    expect(mockTrace.span).toHaveBeenCalledWith(expect.objectContaining({ name: "tool.read" }));

    // Emit tool result from within the same scope (simulates async resolution).
    await withLangfuseRequestScope({ trace: mockTrace, requestName: "test" }, async () => {
      emitAgentEvent({
        runId,
        stream: "tool",
        data: {
          phase: "result",
          name: "read",
          toolCallId,
          isError: false,
          result: { content: "file contents" },
        },
      });
    });

    expect(spanEndFn).toHaveBeenCalledWith(expect.objectContaining({ output: expect.anything() }));
  });

  it("clearRunToolSpans closes orphaned spans on exception paths", async () => {
    initializeLangfuseAgentHooks();

    const mockTrace = makeMockTrace();
    const spanEndFn = vi.fn();
    const spanHandle = { ...makeNoopHandle(), end: spanEndFn };
    (mockTrace.span as ReturnType<typeof vi.fn>).mockReturnValueOnce(spanHandle);

    const runId = "run-orphan-456";
    const toolCallId = "tc-002";

    // Open a tool span.
    await withLangfuseRequestScope({ trace: mockTrace, requestName: "test" }, async () => {
      emitAgentEvent({
        runId,
        stream: "tool",
        data: { phase: "start", name: "exec", toolCallId, args: { command: "ls" } },
      });
    });

    expect(mockTrace.span).toHaveBeenCalledOnce();
    expect(spanEndFn).not.toHaveBeenCalled();

    // Simulate exception path: result event never fires, clearRunToolSpans is called.
    clearRunToolSpans(runId);

    expect(spanEndFn).toHaveBeenCalledWith(
      expect.objectContaining({ statusMessage: expect.stringContaining("run ended") }),
    );
  });

  it("captures tool errors even when result is unserializable", async () => {
    initializeLangfuseAgentHooks();

    const mockTrace = makeMockTrace();
    const spanCaptureErrorFn = vi.fn();
    const spanHandle = {
      ...makeNoopHandle(),
      captureError: spanCaptureErrorFn,
    };
    (mockTrace.span as ReturnType<typeof vi.fn>).mockReturnValueOnce(spanHandle);

    const runId = "run-tool-error-789";
    const toolCallId = "tc-003";

    await withLangfuseRequestScope({ trace: mockTrace, requestName: "test" }, async () => {
      emitAgentEvent({
        runId,
        stream: "tool",
        data: { phase: "start", name: "exec", toolCallId, args: { command: "ls" } },
      });
    });

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    circular.big = 123n;

    await withLangfuseRequestScope({ trace: mockTrace, requestName: "test" }, async () => {
      emitAgentEvent({
        runId,
        stream: "tool",
        data: {
          phase: "result",
          name: "exec",
          toolCallId,
          isError: true,
          result: circular,
        },
      });
    });

    expect(spanCaptureErrorFn).toHaveBeenCalledWith(
      "[unserializable tool error]",
      expect.objectContaining({ toolCallId, runId, durationMs: expect.any(Number) }),
    );
    expect(() => clearRunToolSpans(runId)).not.toThrow();
  });

  it("tool span is not opened outside a request scope", () => {
    initializeLangfuseAgentHooks();

    // Emit WITHOUT being inside withLangfuseRequestScope.
    const unsubscribe = onAgentEvent((evt) => {
      if (evt.stream === "tool") {
        // Just verify scope is missing at this point.
        const scope = getLangfuseRequestScope();
        expect(scope).toBeUndefined();
      }
    });

    emitAgentEvent({
      runId: "run-no-scope",
      stream: "tool",
      data: { phase: "start", name: "read", toolCallId: "tc-noscope", args: {} },
    });

    unsubscribe();
    // No span opened — clearRunToolSpans is a no-op.
    expect(() => clearRunToolSpans("run-no-scope")).not.toThrow();
  });
});
