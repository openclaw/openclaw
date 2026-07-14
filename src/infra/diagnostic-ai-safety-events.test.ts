// Covers AI safety/quality taxonomy event contracts and trusted-only emission.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_SAFETY_EVENT_SCHEMA_VERSION,
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
  type DiagnosticEvalResultEvent,
  type DiagnosticExternalContentConsumedEvent,
  type DiagnosticMemoryContextSelectionEvent,
  type DiagnosticPromptInjectionSignalEvent,
  type DiagnosticToolPolicyDecisionEvent,
  type DiagnosticUserFeedbackReceivedEvent,
} from "./diagnostic-events.js";

describe("diagnostic AI safety events", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    vi.restoreAllMocks();
  });

  it("exports AI_SAFETY_EVENT_SCHEMA_VERSION as numeric constant 1", () => {
    expect(AI_SAFETY_EVENT_SCHEMA_VERSION).toBe(1);
  });

  it("drops AI safety events emitted through the untrusted emitDiagnosticEvent API", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((event) => {
      events.push(event);
    });

    const spoofed = {
      type: "ai_safety.prompt_injection.signal",
      sessionId: "session-spoof",
      severity: "critical",
      category: "jailbreak",
      actionTaken: "blocked",
      sourceType: "user_input",
    };
    // The untrusted input type excludes AI safety events, so plugin code
    // cannot emit them without an unsafe cast; the runtime gate drops them too.
    emitDiagnosticEvent(spoofed as never);
    stop();

    expect(events).toHaveLength(0);
  });

  it("emits ai_safety.prompt_injection.signal with required fields via trusted path", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((event) => {
      events.push(event);
    });

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
    emitTrustedDiagnosticEvent(input);
    stop();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
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
    const events: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((event) => {
      events.push(event);
    });

    emitTrustedDiagnosticEvent({
      type: "ai_safety.prompt_injection.signal",
      sessionId: "session-minimal",
      severity: "critical",
      category: "jailbreak",
      actionTaken: "blocked",
      sourceType: "user_input",
    });
    stop();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "ai_safety.prompt_injection.signal",
      sessionId: "session-minimal",
      severity: "critical",
      category: "jailbreak",
      actionTaken: "blocked",
      sourceType: "user_input",
    });
    expect((events[0] as DiagnosticPromptInjectionSignalEvent).agentId).toBeUndefined();
    expect((events[0] as DiagnosticPromptInjectionSignalEvent).snippetHash).toBeUndefined();
  });

  it("emits ai_safety.tool_policy.decision with all fields", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((event) => {
      events.push(event);
    });

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
    emitTrustedDiagnosticEvent(input);
    stop();

    expect(events[0]).toMatchObject({
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
    const events: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((event) => {
      events.push(event);
    });

    const input: Omit<DiagnosticExternalContentConsumedEvent, "seq" | "ts"> = {
      type: "ai_safety.external_content.consumed",
      sessionId: "session-fetch",
      sourceType: "web_fetch",
      trusted: false,
      urlHash: "a948904f2f0f479b8f936f443429b4aa1e47b1c2d44be2e82e5e25b3e4e3f1b1",
      byteSize: 4096,
      channel: "telegram",
    };
    emitTrustedDiagnosticEvent(input);
    stop();

    expect(events[0]).toMatchObject({
      type: "ai_safety.external_content.consumed",
      sessionId: "session-fetch",
      sourceType: "web_fetch",
      trusted: false,
      urlHash: "a948904f2f0f479b8f936f443429b4aa1e47b1c2d44be2e82e5e25b3e4e3f1b1",
      byteSize: 4096,
    });
    // Verify raw URL is not present in the event payload
    expect(JSON.stringify(events[0])).not.toContain("http");
  });

  it("emits ai_safety.user_feedback.received with normalized score", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((event) => {
      events.push(event);
    });

    const input: Omit<DiagnosticUserFeedbackReceivedEvent, "seq" | "ts"> = {
      type: "ai_safety.user_feedback.received",
      sessionId: "session-feedback",
      agentId: "agent-3",
      label: "negative",
      score: 0.1,
      channel: "telegram",
    };
    emitTrustedDiagnosticEvent(input);
    stop();

    expect(events[0]).toMatchObject({
      type: "ai_safety.user_feedback.received",
      sessionId: "session-feedback",
      label: "negative",
      score: 0.1,
    });
  });

  it("emits ai_safety.memory_context.selected with item count and tokens", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((event) => {
      events.push(event);
    });

    const input: Omit<DiagnosticMemoryContextSelectionEvent, "seq" | "ts"> = {
      type: "ai_safety.memory_context.selected",
      sessionId: "session-memory",
      memoryType: "long_term",
      itemCount: 12,
      totalTokens: 3200,
      channel: "telegram",
    };
    emitTrustedDiagnosticEvent(input);
    stop();

    expect(events[0]).toMatchObject({
      type: "ai_safety.memory_context.selected",
      sessionId: "session-memory",
      memoryType: "long_term",
      itemCount: 12,
      totalTokens: 3200,
    });
  });

  it("emits ai_safety.eval.result with pass/fail and score", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((event) => {
      events.push(event);
    });

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
    emitTrustedDiagnosticEvent(input);
    stop();

    expect(events[0]).toMatchObject({
      type: "ai_safety.eval.result",
      sessionId: "session-eval",
      evalName: "hallucination-detector",
      score: 0.87,
      passed: true,
      severity: "info",
    });
  });

  it("all six AI safety event types carry standard seq/ts enrichment", () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1001)
      .mockReturnValueOnce(1002)
      .mockReturnValueOnce(1003)
      .mockReturnValueOnce(1004)
      .mockReturnValueOnce(1005);

    const events: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((event) => {
      events.push(event);
    });

    emitTrustedDiagnosticEvent({
      type: "ai_safety.prompt_injection.signal",
      sessionId: "s1",
      severity: "info",
      category: "unknown",
      actionTaken: "allowed",
      sourceType: "model_response",
    });
    emitTrustedDiagnosticEvent({
      type: "ai_safety.tool_policy.decision",
      sessionId: "s1",
      toolName: "read",
      decision: "allowed",
      policySource: "hook",
      severity: "info",
    });
    emitTrustedDiagnosticEvent({
      type: "ai_safety.external_content.consumed",
      sessionId: "s1",
      sourceType: "api",
      trusted: true,
    });
    emitTrustedDiagnosticEvent({
      type: "ai_safety.user_feedback.received",
      sessionId: "s1",
      label: "positive",
    });
    emitTrustedDiagnosticEvent({
      type: "ai_safety.memory_context.selected",
      sessionId: "s1",
      memoryType: "short_term",
      itemCount: 3,
    });
    emitTrustedDiagnosticEvent({
      type: "ai_safety.eval.result",
      sessionId: "s1",
      evalName: "consistency-check",
      score: 1,
      passed: true,
      severity: "info",
    });
    stop();

    expect(events).toHaveLength(6);
    for (const event of events) {
      expect(event.seq).toBeTypeOf("number");
      expect(event.ts).toBeTypeOf("number");
    }
    expect(events.map((e) => e.type)).toEqual([
      "ai_safety.prompt_injection.signal",
      "ai_safety.tool_policy.decision",
      "ai_safety.external_content.consumed",
      "ai_safety.user_feedback.received",
      "ai_safety.memory_context.selected",
      "ai_safety.eval.result",
    ]);
  });
});
