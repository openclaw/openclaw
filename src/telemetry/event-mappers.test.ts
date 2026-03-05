import { describe, it, expect, beforeEach, vi } from "vitest";
import { TraceContextManager } from "../../extensions/posthog-analytics/lib/trace-context.js";
import { emitGeneration, emitToolSpan, emitTrace, emitCustomEvent, extractToolNamesFromMessages, extractUsageFromMessages, normalizeOutputForPostHog, buildTraceState } from "../../extensions/posthog-analytics/lib/event-mappers.js";

function createMockPostHog() {
  return {
    capture: vi.fn(),
    shutdown: vi.fn(),
  } as any;
}

describe("extractToolNamesFromMessages", () => {
  it("extracts tool names from OpenAI-format tool_calls in assistant messages", () => {
    const messages = [
      { role: "assistant", tool_calls: [{ function: { name: "web_search" } }, { function: { name: "exec" } }] },
    ];
    expect(extractToolNamesFromMessages(messages)).toEqual(["web_search", "exec"]);
  });

  it("extracts tool names from Anthropic-format content blocks with type tool_use", () => {
    const messages = [
      { role: "assistant", content: [{ type: "tool_use", name: "read_file" }, { type: "text", text: "hello" }] },
    ];
    expect(extractToolNamesFromMessages(messages)).toEqual(["read_file"]);
  });

  it("extracts tool names from tool result messages with role=tool", () => {
    const messages = [
      { role: "tool", name: "exec", content: "output" },
    ];
    expect(extractToolNamesFromMessages(messages)).toEqual(["exec"]);
  });

  it("deduplicates tool names across messages", () => {
    const messages = [
      { role: "assistant", tool_calls: [{ function: { name: "exec" } }] },
      { role: "tool", name: "exec", content: "result" },
      { role: "assistant", tool_calls: [{ function: { name: "exec" } }] },
    ];
    expect(extractToolNamesFromMessages(messages)).toEqual(["exec"]);
  });

  it("returns empty array for messages without tool calls", () => {
    expect(extractToolNamesFromMessages([{ role: "user", content: "hello" }])).toEqual([]);
    expect(extractToolNamesFromMessages(null)).toEqual([]);
    expect(extractToolNamesFromMessages([])).toEqual([]);
  });
});

describe("extractUsageFromMessages", () => {
  it("sums input/output tokens and cost across assistant messages", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi", usage: { input: 10, output: 50, cost: { total: 0.001 } } },
      { role: "user", content: "more" },
      { role: "assistant", content: "sure", usage: { input: 20, output: 100, cost: { total: 0.002 } } },
    ];
    const result = extractUsageFromMessages(messages);
    expect(result.inputTokens).toBe(30);
    expect(result.outputTokens).toBe(150);
    expect(result.totalCostUsd).toBeCloseTo(0.003);
  });

  it("skips non-assistant messages (user, tool, system)", () => {
    const messages = [
      { role: "user", content: "hello", usage: { input: 999, output: 999, cost: { total: 99 } } },
      { role: "tool", name: "exec", content: "result" },
    ];
    const result = extractUsageFromMessages(messages);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.totalCostUsd).toBe(0);
  });

  it("handles assistant messages without usage field", () => {
    const messages = [
      { role: "assistant", content: "hi" },
    ];
    const result = extractUsageFromMessages(messages);
    expect(result.inputTokens).toBe(0);
  });

  it("returns zeros for non-array input", () => {
    expect(extractUsageFromMessages(null)).toEqual({ inputTokens: 0, outputTokens: 0, totalCostUsd: 0 });
  });
});

describe("normalizeOutputForPostHog", () => {
  it("converts Anthropic toolCall content blocks to OpenAI tool_calls format", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me run that." },
          { type: "toolCall", name: "exec", id: "call_1", arguments: { command: "ls" } },
        ],
      },
    ];
    const result = normalizeOutputForPostHog(messages) as any[];
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toBe("Let me run that.");
    expect(result[0].tool_calls).toHaveLength(1);
    expect(result[0].tool_calls[0].function.name).toBe("exec");
    expect(result[0].tool_calls[0].type).toBe("function");
  });

  it("passes through OpenAI-format tool_calls unchanged", () => {
    const messages = [
      {
        role: "assistant",
        content: "OK",
        tool_calls: [{ id: "c1", type: "function", function: { name: "search" } }],
      },
    ];
    const result = normalizeOutputForPostHog(messages) as any[];
    expect(result[0].tool_calls[0].function.name).toBe("search");
  });

  it("returns undefined for non-array or empty input", () => {
    expect(normalizeOutputForPostHog(null)).toBeUndefined();
    expect(normalizeOutputForPostHog([])).toBeUndefined();
  });

  it("skips non-assistant messages", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "tool", name: "exec", content: "result" },
    ];
    expect(normalizeOutputForPostHog(messages)).toBeUndefined();
  });
});

describe("emitGeneration", () => {
  let ph: ReturnType<typeof createMockPostHog>;
  let traceCtx: TraceContextManager;

  beforeEach(() => {
    ph = createMockPostHog();
    traceCtx = new TraceContextManager();
  });

  it("emits $ai_generation with correct model, provider, and trace linkage", () => {
    traceCtx.startTrace("sess-1", "run-1");
    traceCtx.setModel("sess-1", "anthropic/claude-4-sonnet");
    traceCtx.setInput("sess-1", [{ role: "user", content: "hello" }], false);

    emitGeneration(ph, traceCtx, "sess-1", {
      usage: { inputTokens: 10, outputTokens: 20 },
      cost: { totalUsd: 0.001 },
      output: [{ role: "assistant", content: "hi" }],
    }, false);

    expect(ph.capture).toHaveBeenCalledOnce();
    const call = ph.capture.mock.calls[0][0];
    expect(call.event).toBe("$ai_generation");
    expect(call.properties.$ai_model).toBe("anthropic/claude-4-sonnet");
    expect(call.properties.$ai_provider).toBe("anthropic");
    expect(call.properties.$ai_trace_id).toBe(traceCtx.getTrace("sess-1")!.traceId);
    expect(call.properties.$ai_session_id).toBe("sess-1");
    expect(call.properties.$ai_input_tokens).toBe(10);
    expect(call.properties.$ai_output_tokens).toBe(20);
    expect(call.properties.$ai_total_cost_usd).toBe(0.001);
    expect(call.properties.$ai_is_error).toBe(false);
  });

  it("redacts input/output content when privacy mode is on but preserves message structure (roles, tool names visible)", () => {
    traceCtx.startTrace("s", "r");
    traceCtx.setInput("s", [{ role: "user", content: "sensitive" }], true);

    emitGeneration(ph, traceCtx, "s", {
      output: [{ role: "assistant", content: "also sensitive" }],
    }, true);

    const props = ph.capture.mock.calls[0][0].properties;
    const input = props.$ai_input as Array<Record<string, unknown>>;
    expect(input[0].role).toBe("user");
    expect(input[0].content).toBe("[REDACTED]");
    const output = props.$ai_output_choices as Array<Record<string, unknown>>;
    expect(output[0].role).toBe("assistant");
    expect(output[0].content).toBe("[REDACTED]");
  });

  it("does not set $ai_total_cost_usd when cost is zero (prevents misleading $0 in PostHog)", () => {
    traceCtx.startTrace("s", "r");
    emitGeneration(ph, traceCtx, "s", { cost: { totalUsd: 0 } }, true);
    expect(ph.capture.mock.calls[0][0].properties.$ai_total_cost_usd).toBeUndefined();
  });

  it("does not set $ai_total_cost_usd when cost object is absent", () => {
    traceCtx.startTrace("s", "r");
    emitGeneration(ph, traceCtx, "s", {}, true);
    expect(ph.capture.mock.calls[0][0].properties.$ai_total_cost_usd).toBeUndefined();
  });

  it("sets $ai_total_cost_usd when cost is positive (via event.usage path)", () => {
    traceCtx.startTrace("s", "r");
    emitGeneration(ph, traceCtx, "s", {
      usage: { inputTokens: 10, outputTokens: 20 },
      cost: { totalUsd: 0.05 },
    }, true);
    expect(ph.capture.mock.calls[0][0].properties.$ai_total_cost_usd).toBe(0.05);
  });

  it("does not set token counts when usage is absent (prevents null in PostHog)", () => {
    traceCtx.startTrace("s", "r");
    emitGeneration(ph, traceCtx, "s", {}, true);
    const props = ph.capture.mock.calls[0][0].properties;
    expect(props).not.toHaveProperty("$ai_input_tokens");
    expect(props).not.toHaveProperty("$ai_output_tokens");
  });

  it("does not set token counts when they are zero", () => {
    traceCtx.startTrace("s", "r");
    emitGeneration(ph, traceCtx, "s", { usage: { inputTokens: 0, outputTokens: 0 } }, true);
    const props = ph.capture.mock.calls[0][0].properties;
    expect(props).not.toHaveProperty("$ai_input_tokens");
    expect(props).not.toHaveProperty("$ai_output_tokens");
  });

  it("extracts real token counts and cost from message usage metadata (OpenClaw fallback)", () => {
    traceCtx.startTrace("s", "r");
    const messages = [
      { role: "user", content: "What is 2 + 2?" },
      { role: "assistant", content: "The answer is 4.", usage: { input: 15, output: 8, cost: { total: 0.0005 } } },
    ];
    emitGeneration(ph, traceCtx, "s", { messages }, true);
    const props = ph.capture.mock.calls[0][0].properties;
    expect(props.$ai_input_tokens).toBe(15);
    expect(props.$ai_output_tokens).toBe(8);
    expect(props.$ai_total_cost_usd).toBe(0.0005);
  });

  it("captures error details when generation fails", () => {
    traceCtx.startTrace("s", "r");
    emitGeneration(ph, traceCtx, "s", { error: { message: "Rate limit exceeded" } }, true);
    const props = ph.capture.mock.calls[0][0].properties;
    expect(props.$ai_is_error).toBe(true);
    expect(props.$ai_error).toBe("Rate limit exceeded");
  });

  it("detects error from success=false even without error field", () => {
    traceCtx.startTrace("s", "r");
    emitGeneration(ph, traceCtx, "s", { success: false }, true);
    expect(ph.capture.mock.calls[0][0].properties.$ai_is_error).toBe(true);
  });

  it("includes tool names from both spans and messages in $ai_tools", () => {
    traceCtx.startTrace("s", "r");
    traceCtx.startToolSpan("s", "web_search", {});
    traceCtx.endToolSpan("s", "web_search", {});

    const messages = [
      { role: "assistant", tool_calls: [{ function: { name: "exec" } }] },
      { role: "tool", name: "exec", content: "result" },
    ];

    emitGeneration(ph, traceCtx, "s", { messages }, true);

    const tools = ph.capture.mock.calls[0][0].properties.$ai_tools;
    expect(tools).toEqual([
      { type: "function", function: { name: "web_search" } },
      { type: "function", function: { name: "exec" } },
    ]);
  });

  it("sets $ai_tools to undefined when no tools were called", () => {
    traceCtx.startTrace("s", "r");
    emitGeneration(ph, traceCtx, "s", {}, true);
    expect(ph.capture.mock.calls[0][0].properties.$ai_tools).toBeUndefined();
  });

  it("silently skips when trace does not exist", () => {
    emitGeneration(ph, traceCtx, "ghost", {}, true);
    expect(ph.capture).not.toHaveBeenCalled();
  });

  it("never throws even if PostHog capture throws (prevents gateway crash)", () => {
    ph.capture.mockImplementation(() => { throw new Error("PostHog down"); });
    traceCtx.startTrace("s", "r");
    expect(() => emitGeneration(ph, traceCtx, "s", {}, true)).not.toThrow();
  });

  it("uses durationMs from event for latency when available (more accurate)", () => {
    traceCtx.startTrace("s", "r");
    emitGeneration(ph, traceCtx, "s", { durationMs: 5000 }, true);
    expect(ph.capture.mock.calls[0][0].properties.$ai_latency).toBe(5);
  });
});

describe("emitToolSpan", () => {
  let ph: ReturnType<typeof createMockPostHog>;
  let traceCtx: TraceContextManager;

  beforeEach(() => {
    ph = createMockPostHog();
    traceCtx = new TraceContextManager();
  });

  it("emits $ai_span with correct tool name, timing, and trace linkage (same session key)", () => {
    traceCtx.startTrace("sess", "r");
    traceCtx.startToolSpan("sess", "web_search", { q: "test" });
    traceCtx.endToolSpan("sess", "web_search", { results: [] });

    emitToolSpan(ph, traceCtx, "sess", {}, false);

    const call = ph.capture.mock.calls[0][0];
    expect(call.event).toBe("$ai_span");
    expect(call.properties.$ai_span_name).toBe("web_search");
    expect(call.properties.$ai_trace_id).toBe(traceCtx.getTrace("sess")!.traceId);
    expect(call.properties.$ai_parent_id).toBe(traceCtx.getTrace("sess")!.traceId);
  });

  it("excludes tool_params and tool_result when privacy mode is on", () => {
    traceCtx.startTrace("s", "r");
    traceCtx.startToolSpan("s", "exec", { cmd: "cat /etc/passwd" });
    traceCtx.endToolSpan("s", "exec", { output: "root:x:0:0:..." });

    emitToolSpan(ph, traceCtx, "s", {}, true);

    const props = ph.capture.mock.calls[0][0].properties;
    expect(props).not.toHaveProperty("tool_params");
    expect(props).not.toHaveProperty("tool_result");
  });

  it("includes tool_params and tool_result with secrets stripped when privacy is off", () => {
    traceCtx.startTrace("s", "r");
    traceCtx.startToolSpan("s", "api_call", { url: "https://example.com", apiKey: "secret" });
    traceCtx.endToolSpan("s", "api_call", { status: 200 });

    emitToolSpan(ph, traceCtx, "s", {}, false);

    const props = ph.capture.mock.calls[0][0].properties;
    expect(props.tool_params.url).toBe("https://example.com");
    expect(props.tool_params.apiKey).toBe("[REDACTED]");
  });

  it("uses event.durationMs for latency when span timing is unavailable", () => {
    traceCtx.startTrace("s", "r");
    traceCtx.startToolSpan("s", "exec", {});

    emitToolSpan(ph, traceCtx, "s", { durationMs: 250 }, false);

    expect(ph.capture.mock.calls[0][0].properties.$ai_latency).toBe(0.25);
  });
});

describe("buildTraceState", () => {
  it("includes all user messages in inputState and all assistant messages in outputState (full conversation)", () => {
    const messages = [
      { role: "user", content: "Question 1" },
      { role: "assistant", content: "Answer 1" },
      { role: "user", content: "Question 2" },
      { role: "assistant", content: "Answer 2" },
    ];
    const { inputState, outputState } = buildTraceState(messages, false);
    expect(inputState).toEqual([
      { role: "user", content: "Question 1" },
      { role: "user", content: "Question 2" },
    ]);
    expect(outputState).toEqual([
      { role: "assistant", content: "Answer 1" },
      { role: "assistant", content: "Answer 2" },
    ]);
  });

  it("includes tool result messages in inputState (user sees tool activity)", () => {
    const messages = [
      { role: "user", content: "run ls" },
      { role: "assistant", content: "Running..." },
      { role: "tool", name: "exec", content: "file1.txt" },
      { role: "assistant", content: "Done!" },
    ];
    const { inputState, outputState } = buildTraceState(messages, false);
    expect(inputState).toHaveLength(2);
    expect((inputState as any[])[1].role).toBe("tool");
    expect((inputState as any[])[1].name).toBe("exec");
    expect(outputState).toHaveLength(2);
  });

  it("redacts content in privacy mode but keeps role and tool metadata", () => {
    const messages = [
      { role: "user", content: "secret" },
      { role: "assistant", content: [{ type: "text", text: "classified" }, { type: "toolCall", name: "exec" }] },
    ];
    const { inputState, outputState } = buildTraceState(messages, true);
    expect((inputState as any[])[0]).toEqual({ role: "user", content: "[REDACTED]" });
    expect((outputState as any[])[0].content).toBe("[REDACTED]");
    expect((outputState as any[])[0].tool_calls).toEqual([{ type: "function", function: { name: "exec" } }]);
  });

  it("preserves tool call names on assistant messages in privacy mode (tool type always visible)", () => {
    const messages = [
      {
        role: "assistant",
        content: "Let me search",
        tool_calls: [{ function: { name: "web_search" } }],
      },
    ];
    const { outputState } = buildTraceState(messages, true);
    expect((outputState as any[])[0].tool_calls).toEqual([{ type: "function", function: { name: "web_search" } }]);
  });

  it("returns undefined for empty or non-array input", () => {
    expect(buildTraceState(null, false)).toEqual({ inputState: undefined, outputState: undefined });
    expect(buildTraceState([], false)).toEqual({ inputState: undefined, outputState: undefined });
  });
});

describe("emitTrace", () => {
  it("emits $ai_trace with full conversation state from buildTraceState", () => {
    const ph = createMockPostHog();
    const traceCtx = new TraceContextManager();
    traceCtx.startTrace("sess-1", "r");

    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];

    emitTrace(ph, traceCtx, "sess-1", { messages }, false);

    const props = ph.capture.mock.calls[0][0].properties;
    expect(props.$ai_trace_id).toBe(traceCtx.getTrace("sess-1")!.traceId);
    expect(props.$ai_input_state).toEqual([{ role: "user", content: "Hello" }]);
    expect(props.$ai_output_state).toEqual([{ role: "assistant", content: "Hi there!" }]);
  });

  it("sets undefined state when no messages provided (backward compat)", () => {
    const ph = createMockPostHog();
    const traceCtx = new TraceContextManager();
    traceCtx.startTrace("s", "r");

    emitTrace(ph, traceCtx, "s");

    const props = ph.capture.mock.calls[0][0].properties;
    expect(props.$ai_input_state).toBeUndefined();
    expect(props.$ai_output_state).toBeUndefined();
  });
});

describe("emitCustomEvent", () => {
  it("captures event with $process_person_profile: false (prevents person profile creation)", () => {
    const ph = createMockPostHog();
    emitCustomEvent(ph, "dench_session_start", { session_id: "abc" });
    const call = ph.capture.mock.calls[0][0];
    expect(call.event).toBe("dench_session_start");
    expect(call.properties.$process_person_profile).toBe(false);
  });
});
