// Covers AI safety/quality taxonomy event contracts and provenance metadata.
import { describe, expect, it, vi } from "vitest";
import {
  emitAuthorizedAISafetyEvent,
  emitTrustedAISafetyEvent,
  onAISafetyDiagnosticEvent,
  type AISafetyEventMetadata,
  type DiagnosticAISafetyEventPayload,
  type DiagnosticEvalResultEvent,
  type DiagnosticExternalContentConsumedEvent,
  type DiagnosticMemoryContextSelectionEvent,
  type DiagnosticPromptInjectionSignalEvent,
  type DiagnosticToolPolicyDecisionEvent,
  type DiagnosticUserFeedbackReceivedEvent,
} from "./diagnostic-ai-safety-events.js";

type Captured = {
  event: DiagnosticAISafetyEventPayload;
  metadata: AISafetyEventMetadata;
};

function capture(run: () => void): Captured[] {
  const captured: Captured[] = [];
  const stop = onAISafetyDiagnosticEvent((event, metadata) => {
    captured.push({ event, metadata });
  });
  try {
    run();
  } finally {
    stop();
  }
  return captured;
}

describe("diagnostic AI safety events", () => {
  it("marks plugin-authorized emissions as untrusted provenance", () => {
    const captured = capture(() => {
      emitAuthorizedAISafetyEvent({
        type: "ai_safety.prompt_injection.signal",
        sessionId: "session-plugin",
        severity: "critical",
        category: "jailbreak",
        actionTaken: "blocked",
        sourceType: "user_input",
      });
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.metadata).toEqual({ trusted: false });
  });

  it("emits ai_safety.prompt_injection.signal with required fields via trusted path", () => {
    const input: Omit<DiagnosticPromptInjectionSignalEvent, "seq" | "ts"> = {
      type: "ai_safety.prompt_injection.signal",
      sessionId: "session-abc",
      agentId: "agent-1",
      severity: "warn",
      category: "indirect",
      actionTaken: "flagged",
      sourceType: "tool_output",
      channel: "telegram",
      snippetHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    };
    const captured = capture(() => {
      emitTrustedAISafetyEvent(input);
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.metadata).toEqual({ trusted: true });
    expect(captured[0]!.event).toMatchObject({
      type: "ai_safety.prompt_injection.signal",
      sessionId: "session-abc",
      agentId: "agent-1",
      severity: "warn",
      category: "indirect",
      actionTaken: "flagged",
      sourceType: "tool_output",
      channel: "telegram",
      snippetHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      seq: expect.any(Number),
      ts: expect.any(Number),
    });
  });

  it("emits ai_safety.prompt_injection.signal without optional fields", () => {
    const captured = capture(() => {
      emitTrustedAISafetyEvent({
        type: "ai_safety.prompt_injection.signal",
        sessionId: "session-minimal",
        severity: "critical",
        category: "jailbreak",
        actionTaken: "blocked",
        sourceType: "user_input",
      });
    });

    expect(captured).toHaveLength(1);
    const event = captured[0]!.event as DiagnosticPromptInjectionSignalEvent;
    expect(event).toMatchObject({
      type: "ai_safety.prompt_injection.signal",
      sessionId: "session-minimal",
      severity: "critical",
      category: "jailbreak",
      actionTaken: "blocked",
      sourceType: "user_input",
    });
    expect(event.agentId).toBeUndefined();
    expect(event.snippetHash).toBeUndefined();
  });

  it("emits ai_safety.tool_policy.decision with all fields", () => {
    const input: Omit<DiagnosticToolPolicyDecisionEvent, "seq" | "ts"> = {
      type: "ai_safety.tool_policy.decision",
      sessionId: "session-policy",
      agentId: "agent-2",
      toolName: "exec",
      decision: "blocked",
      policySource: "static_config",
      severity: "warn",
      channel: "whatsapp",
      reason: "tool not in allowlist",
    };
    const captured = capture(() => {
      emitTrustedAISafetyEvent(input);
    });

    expect(captured[0]!.event).toMatchObject({
      type: "ai_safety.tool_policy.decision",
      sessionId: "session-policy",
      agentId: "agent-2",
      toolName: "exec",
      decision: "blocked",
      policySource: "static_config",
      severity: "warn",
      channel: "whatsapp",
      reason: "tool not in allowlist",
    });
  });

  it("emits ai_safety.external_content.consumed with hashed URL only", () => {
    const input: Omit<DiagnosticExternalContentConsumedEvent, "seq" | "ts"> = {
      type: "ai_safety.external_content.consumed",
      sessionId: "session-fetch",
      sourceType: "web_fetch",
      trusted: false,
      urlHash: "a948904f2f0f479b8f936f443429b4aa1e47b1c2d44be2e82e5e25b3e4e3f1b1",
      byteSize: 4096,
      channel: "telegram",
    };
    const captured = capture(() => {
      emitTrustedAISafetyEvent(input);
    });

    expect(captured[0]!.event).toMatchObject({
      type: "ai_safety.external_content.consumed",
      sessionId: "session-fetch",
      sourceType: "web_fetch",
      trusted: false,
      urlHash: "a948904f2f0f479b8f936f443429b4aa1e47b1c2d44be2e82e5e25b3e4e3f1b1",
      byteSize: 4096,
    });
    // Verify raw URL is not present in the event payload
    expect(JSON.stringify(captured[0]!.event)).not.toContain("http");
  });

  it("emits ai_safety.user_feedback.received with normalized score", () => {
    const input: Omit<DiagnosticUserFeedbackReceivedEvent, "seq" | "ts"> = {
      type: "ai_safety.user_feedback.received",
      sessionId: "session-feedback",
      agentId: "agent-3",
      label: "negative",
      score: 0.1,
      channel: "telegram",
    };
    const captured = capture(() => {
      emitTrustedAISafetyEvent(input);
    });

    expect(captured[0]!.event).toMatchObject({
      type: "ai_safety.user_feedback.received",
      sessionId: "session-feedback",
      label: "negative",
      score: 0.1,
    });
  });

  it("emits ai_safety.memory_context.selected with item count and tokens", () => {
    const input: Omit<DiagnosticMemoryContextSelectionEvent, "seq" | "ts"> = {
      type: "ai_safety.memory_context.selected",
      sessionId: "session-memory",
      memoryType: "long_term",
      itemCount: 12,
      totalTokens: 3200,
      channel: "telegram",
    };
    const captured = capture(() => {
      emitTrustedAISafetyEvent(input);
    });

    expect(captured[0]!.event).toMatchObject({
      type: "ai_safety.memory_context.selected",
      sessionId: "session-memory",
      memoryType: "long_term",
      itemCount: 12,
      totalTokens: 3200,
    });
  });

  it("emits ai_safety.eval.result with pass/fail and score", () => {
    const input: Omit<DiagnosticEvalResultEvent, "seq" | "ts"> = {
      type: "ai_safety.eval.result",
      sessionId: "session-eval",
      agentId: "agent-eval",
      evalName: "hallucination-detector",
      score: 0.87,
      passed: true,
      severity: "info",
      channel: "whatsapp",
    };
    const captured = capture(() => {
      emitTrustedAISafetyEvent(input);
    });

    expect(captured[0]!.event).toMatchObject({
      type: "ai_safety.eval.result",
      sessionId: "session-eval",
      evalName: "hallucination-detector",
      score: 0.87,
      passed: true,
      severity: "info",
    });
  });

  it("all six AI safety event types carry standard seq/ts enrichment", () => {
    const captured = capture(() => {
      emitTrustedAISafetyEvent({
        type: "ai_safety.prompt_injection.signal",
        sessionId: "s1",
        severity: "info",
        category: "unknown",
        actionTaken: "allowed",
        sourceType: "model_response",
      });
      emitTrustedAISafetyEvent({
        type: "ai_safety.tool_policy.decision",
        sessionId: "s1",
        toolName: "read",
        decision: "allowed",
        policySource: "hook",
        severity: "info",
      });
      emitTrustedAISafetyEvent({
        type: "ai_safety.external_content.consumed",
        sessionId: "s1",
        sourceType: "api",
        trusted: true,
      });
      emitTrustedAISafetyEvent({
        type: "ai_safety.user_feedback.received",
        sessionId: "s1",
        label: "positive",
      });
      emitTrustedAISafetyEvent({
        type: "ai_safety.memory_context.selected",
        sessionId: "s1",
        memoryType: "short_term",
        itemCount: 3,
      });
      emitTrustedAISafetyEvent({
        type: "ai_safety.eval.result",
        sessionId: "s1",
        evalName: "consistency-check",
        score: 1,
        passed: true,
        severity: "info",
      });
    });

    expect(captured).toHaveLength(6);
    let previousSeq = 0;
    for (const { event, metadata } of captured) {
      expect(event.seq).toBeTypeOf("number");
      expect(event.ts).toBeTypeOf("number");
      expect(event.seq).toBeGreaterThan(previousSeq);
      previousSeq = event.seq;
      expect(metadata).toEqual({ trusted: true });
    }
    expect(captured.map(({ event }) => event.type)).toEqual([
      "ai_safety.prompt_injection.signal",
      "ai_safety.tool_policy.decision",
      "ai_safety.external_content.consumed",
      "ai_safety.user_feedback.received",
      "ai_safety.memory_context.selected",
      "ai_safety.eval.result",
    ]);
  });

  it("isolates listener failures from other listeners", () => {
    const seen: DiagnosticAISafetyEventPayload[] = [];
    const stopThrowing = onAISafetyDiagnosticEvent(() => {
      throw new Error("listener boom");
    });
    const stopCollecting = onAISafetyDiagnosticEvent((event) => {
      seen.push(event);
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      emitTrustedAISafetyEvent({
        type: "ai_safety.user_feedback.received",
        sessionId: "session-isolated",
        label: "flag",
      });
    } finally {
      consoleError.mockRestore();
      stopThrowing();
      stopCollecting();
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]!.type).toBe("ai_safety.user_feedback.received");
  });
});
