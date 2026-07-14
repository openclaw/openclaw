// Tests for plugin-emitted AI safety taxonomy events.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitAuthorizedAISafetyDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../infra/diagnostic-events.js";
import { emitPluginSafetyEvent } from "./safety-event-emission.js";
import type { AISafetyEventInput } from "./safety-event-emission.js";

vi.mock("../infra/diagnostic-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/diagnostic-events.js")>();
  return {
    ...actual,
    emitAuthorizedAISafetyDiagnosticEvent: vi.fn(),
    emitTrustedDiagnosticEvent: vi.fn(),
  };
});

const emitAuthorizedAISafetyDiagnosticEventMock = vi.mocked(emitAuthorizedAISafetyDiagnosticEvent);
const emitTrustedDiagnosticEventMock = vi.mocked(emitTrustedDiagnosticEvent);

const baseExternalContentEvent: AISafetyEventInput = {
  type: "ai_safety.external_content.consumed",
  sessionId: "sess-001",
  sourceType: "web_fetch",
  trusted: false,
};

const basePromptInjectionEvent: AISafetyEventInput = {
  type: "ai_safety.prompt_injection.signal",
  sessionId: "sess-002",
  severity: "warn",
  category: "indirect",
  actionTaken: "flagged",
  sourceType: "tool_output",
};

const baseEvalEvent: AISafetyEventInput = {
  type: "ai_safety.eval.result",
  sessionId: "sess-003",
  evalName: "source-trust-check",
  score: 0.85,
  passed: true,
  severity: "info",
};

beforeEach(() => {
  emitAuthorizedAISafetyDiagnosticEventMock.mockClear();
  emitTrustedDiagnosticEventMock.mockClear();
});

describe("emitPluginSafetyEvent — trusted plugin", () => {
  it("emits any declared event type via trusted path", () => {
    const result = emitPluginSafetyEvent({
      pluginId: "my-bundled-plugin",
      event: baseExternalContentEvent,
      trusted: true,
    });
    expect(result).toEqual({ ok: true });
    expect(emitTrustedDiagnosticEventMock).toHaveBeenCalledOnce();
    expect(emitTrustedDiagnosticEventMock).toHaveBeenCalledWith(baseExternalContentEvent);
    expect(emitAuthorizedAISafetyDiagnosticEventMock).not.toHaveBeenCalled();
  });

  it("trusted plugin can emit without declaredSafetyEventTypes", () => {
    const result = emitPluginSafetyEvent({
      pluginId: "my-bundled-plugin",
      event: baseEvalEvent,
      trusted: true,
    });
    expect(result).toEqual({ ok: true });
    expect(emitTrustedDiagnosticEventMock).toHaveBeenCalledOnce();
  });

  it("trusted plugin can emit prompt injection signal", () => {
    const result = emitPluginSafetyEvent({
      pluginId: "my-bundled-plugin",
      event: basePromptInjectionEvent,
      trusted: true,
    });
    expect(result).toEqual({ ok: true });
    expect(emitTrustedDiagnosticEventMock).toHaveBeenCalledWith(basePromptInjectionEvent);
  });
});

describe("emitPluginSafetyEvent — non-trusted (external) plugin", () => {
  it("emits via authorized untrusted-provenance path when type is declared in manifest", () => {
    const result = emitPluginSafetyEvent({
      pluginId: "third-party-plugin",
      event: baseExternalContentEvent,
      trusted: false,
      declaredSafetyEventTypes: ["ai_safety.external_content.consumed"],
    });
    expect(result).toEqual({ ok: true });
    expect(emitAuthorizedAISafetyDiagnosticEventMock).toHaveBeenCalledOnce();
    expect(emitAuthorizedAISafetyDiagnosticEventMock).toHaveBeenCalledWith(
      baseExternalContentEvent,
    );
    expect(emitTrustedDiagnosticEventMock).not.toHaveBeenCalled();
  });

  it("rejects undeclared event type with ok: false", () => {
    const result = emitPluginSafetyEvent({
      pluginId: "third-party-plugin",
      event: baseExternalContentEvent,
      trusted: false,
      declaredSafetyEventTypes: ["ai_safety.eval.result"],
    });
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("ai_safety.external_content.consumed"),
    });
    expect(emitAuthorizedAISafetyDiagnosticEventMock).not.toHaveBeenCalled();
    expect(emitTrustedDiagnosticEventMock).not.toHaveBeenCalled();
  });

  it("rejects when declaredSafetyEventTypes is empty", () => {
    const result = emitPluginSafetyEvent({
      pluginId: "third-party-plugin",
      event: baseEvalEvent,
      trusted: false,
      declaredSafetyEventTypes: [],
    });
    expect(result.ok).toBe(false);
    expect(emitAuthorizedAISafetyDiagnosticEventMock).not.toHaveBeenCalled();
  });

  it("rejects when declaredSafetyEventTypes is absent", () => {
    const result = emitPluginSafetyEvent({
      pluginId: "third-party-plugin",
      event: baseExternalContentEvent,
      trusted: false,
    });
    expect(result.ok).toBe(false);
  });

  it("allows multiple declared types and picks the right one", () => {
    const result = emitPluginSafetyEvent({
      pluginId: "multi-event-plugin",
      event: basePromptInjectionEvent,
      trusted: false,
      declaredSafetyEventTypes: [
        "ai_safety.external_content.consumed",
        "ai_safety.prompt_injection.signal",
        "ai_safety.eval.result",
      ],
    });
    expect(result).toEqual({ ok: true });
    expect(emitAuthorizedAISafetyDiagnosticEventMock).toHaveBeenCalledOnce();
  });
});

describe("emitPluginSafetyEvent — invalid event type", () => {
  it("rejects event type that does not start with ai_safety.", () => {
    const result = emitPluginSafetyEvent({
      pluginId: "rogue-plugin",
      // @ts-expect-error - intentionally invalid type for test
      event: { type: "security.event", sessionId: "sess-bad" },
      trusted: true,
    });
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining('must start with "ai_safety."'),
    });
    expect(emitTrustedDiagnosticEventMock).not.toHaveBeenCalled();
    expect(emitAuthorizedAISafetyDiagnosticEventMock).not.toHaveBeenCalled();
  });

  it("rejects unknown ai_safety.* type not in taxonomy", () => {
    const result = emitPluginSafetyEvent({
      pluginId: "rogue-plugin",
      // @ts-expect-error - intentionally invalid type for test
      event: { type: "ai_safety.unknown_event", sessionId: "sess-bad" },
      trusted: true,
    });
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("not a recognized AI safety taxonomy type"),
    });
    expect(emitTrustedDiagnosticEventMock).not.toHaveBeenCalled();
  });

  it("rejects empty string type", () => {
    const result = emitPluginSafetyEvent({
      pluginId: "rogue-plugin",
      // @ts-expect-error - intentionally invalid type for test
      event: { type: "", sessionId: "sess-bad" },
      trusted: true,
    });
    expect(result.ok).toBe(false);
  });
});

describe("emitPluginSafetyEvent — all taxonomy types accepted for trusted plugin", () => {
  const allTypes: AISafetyEventInput[] = [
    {
      type: "ai_safety.prompt_injection.signal",
      sessionId: "s",
      severity: "info",
      category: "direct",
      actionTaken: "allowed",
      sourceType: "user_input",
    },
    {
      type: "ai_safety.tool_policy.decision",
      sessionId: "s",
      toolName: "bash",
      decision: "allowed",
      policySource: "static_config",
      severity: "info",
    },
    {
      type: "ai_safety.external_content.consumed",
      sessionId: "s",
      sourceType: "web_fetch",
      trusted: false,
    },
    {
      type: "ai_safety.user_feedback.received",
      sessionId: "s",
      label: "positive",
    },
    {
      type: "ai_safety.memory_context.selected",
      sessionId: "s",
      memoryType: "long_term",
      itemCount: 5,
    },
    {
      type: "ai_safety.eval.result",
      sessionId: "s",
      evalName: "test-eval",
      score: 1.0,
      passed: true,
      severity: "info",
    },
  ];

  for (const event of allTypes) {
    it(`accepts ${event.type}`, () => {
      const result = emitPluginSafetyEvent({ pluginId: "bundled", event, trusted: true });
      expect(result).toEqual({ ok: true });
      expect(emitTrustedDiagnosticEventMock).toHaveBeenCalledWith(event);
      emitTrustedDiagnosticEventMock.mockClear();
    });
  }
});
