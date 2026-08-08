import { describe, expect, it } from "vitest";
import { classifyAgentExecResult } from "./agent-exec-result.js";

function successResult(text = "done") {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 25,
      finalAssistantVisibleText: text,
      agentMeta: {
        sessionId: "session-result",
        provider: "openai",
        model: "gpt-5.6-sol",
        usage: { input: 10, output: 2, total: 12 },
      },
    },
  };
}

describe("agent exec strict result classification", () => {
  it("classifies a successful embedded result", () => {
    expect(classifyAgentExecResult(successResult())).toMatchObject({
      ok: true,
      status: "ok",
      final: "done",
    });
  });

  it("classifies model error payloads as failure", () => {
    const envelope = classifyAgentExecResult({
      payloads: [{ text: "provider rejected request", isError: true }],
      meta: { durationMs: 10 },
    });
    expect(envelope).toMatchObject({
      ok: false,
      status: "error",
      error: { kind: "error_payload", message: "provider rejected request" },
    });
  });

  it("classifies textless error payloads as failure", () => {
    const envelope = classifyAgentExecResult({
      payloads: [{ isError: true }],
      meta: { durationMs: 10 },
    });
    expect(envelope).toMatchObject({
      ok: false,
      status: "error",
      error: { kind: "error_payload", message: "Agent run failed" },
    });
  });

  it("classifies terminal timeouts separately", () => {
    const envelope = classifyAgentExecResult({
      payloads: [{ text: "timed out", isError: true }],
      meta: { durationMs: 600_000, aborted: true, stopReason: "timeout" },
    });
    expect(envelope).toMatchObject({
      ok: false,
      status: "timeout",
      error: { kind: "timeout" },
    });
  });

  it("classifies exhausted explicit fallbacks as failure", () => {
    const envelope = classifyAgentExecResult(successResult("last candidate output"), true);
    expect(envelope).toMatchObject({
      ok: false,
      status: "error",
      error: { kind: "fallback_exhausted" },
    });
  });

  it("classifies projected production error payloads as failure", () => {
    const envelope = classifyAgentExecResult(
      successResult("projected error text"),
      false,
      "projected error text",
    );
    expect(envelope).toMatchObject({
      ok: false,
      status: "error",
      final: "",
      payloads: [{ text: "projected error text", isError: true }],
      error: { kind: "error_payload", message: "projected error text" },
    });
  });

  it("does not restore metadata text for a projected textless error", () => {
    const result = successResult("metadata error text");
    result.payloads = [];
    const envelope = classifyAgentExecResult(result, false, true);
    expect(envelope).toMatchObject({ ok: false, status: "error", final: "", payloads: [] });
  });

  it("projects payloads onto the stable documented fields", () => {
    const envelope = classifyAgentExecResult({
      payloads: [
        {
          text: "done",
          mediaUrl: null,
          audioAsVoice: true,
          presentation: { blocks: [] },
          channelData: { private: true },
        },
      ],
      meta: { durationMs: 10 },
    });
    expect(envelope.payloads).toEqual([{ text: "done", mediaUrl: null }]);
  });

  it("projects the embedded outer tool summary", () => {
    const envelope = classifyAgentExecResult({
      payloads: [{ text: "done" }],
      meta: {
        durationMs: 10,
        toolSummary: {
          calls: 2,
          tools: ["read", "write"],
          failures: 1,
          totalToolTimeMs: 25,
        },
      },
    });
    expect(envelope.toolSummary).toEqual({
      calls: 2,
      tools: ["read", "write"],
      failures: 1,
      totalToolTimeMs: 25,
    });
  });
});
