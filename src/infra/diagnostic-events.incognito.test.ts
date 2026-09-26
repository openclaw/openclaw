import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  emitTrustedSkillUsedDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  onTrustedToolExecutionEvent,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
} from "./diagnostic-events.js";

const sessionKey = "agent:main:dashboard:incognito-diagnostics";

describe("Incognito diagnostic admission", () => {
  beforeEach(resetDiagnosticEventsForTest);
  afterEach(resetDiagnosticEventsForTest);

  it.each([sessionKey, "agent:main:main"])(
    "delivers lifecycle metrics without private capture for %s",
    async (key) => {
      const entries: Array<{ event: DiagnosticEventPayload; content: DiagnosticEventPrivateData }> =
        [];
      onTrustedInternalDiagnosticEvent((event, _metadata, content) =>
        entries.push({ event, content }),
      );
      const readContent = vi.fn(() => ({ inputMessages: ["PRIVATE_MODEL"] }));
      const readTool = vi.fn(() => ({ toolInput: "PRIVATE_TOOL" }));
      const readError = vi.fn(() => "PRIVATE_ERROR");
      const content = {
        get modelContent() {
          return readContent();
        },
        get toolContent() {
          return readTool();
        },
        get errorMessage() {
          return readError();
        },
      };
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "model.call.error",
          sessionKey: key,
          runId: "run-1",
          callId: "call-1",
          provider: "openai",
          model: "gpt-5",
          errorCategory: "error",
          durationMs: 42,
        },
        content,
      );
      await waitForDiagnosticEventsDrained();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.event).toMatchObject({
        durationMs: 42,
        errorCategory: "error",
        runId: "run-1",
      });
      if (key === sessionKey) {
        expect(entries[0]?.content).toEqual({});
        expect(readContent).not.toHaveBeenCalled();
        expect(readTool).not.toHaveBeenCalled();
        expect(readError).not.toHaveBeenCalled();
      } else {
        expect(JSON.stringify(entries[0]?.content)).toContain("PRIVATE_MODEL");
        expect(readContent).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([true, false])(
    "preserves skill accounting with diagnostics enabled=%s",
    async (enabled) => {
      setDiagnosticsEnabledForProcess(enabled);
      const listener = vi.fn();
      onTrustedInternalDiagnosticEvent(listener);
      const readModel = vi.fn(() => ({ inputMessages: ["PRIVATE_MODEL"] }));
      emitTrustedSkillUsedDiagnosticEvent(
        {
          type: "skill.used",
          sessionKey,
          skillName: "example",
          skillSource: "workspace",
          activation: "read",
        },
        {
          skillUsage: { skillFile: "/workspace/skills/example/SKILL.md" },
          get modelContent() {
            return readModel();
          },
        },
      );
      await waitForDiagnosticEventsDrained();
      expect(listener).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ type: "skill.used", skillName: "example" }),
        expect.objectContaining({ trusted: true }),
        { skillUsage: { skillFile: "/workspace/skills/example/SKILL.md" } },
      );
      expect(readModel).not.toHaveBeenCalled();
    },
  );

  it("omits free-form error text without dropping delivery status", () => {
    const listener = vi.fn();
    const readError = vi.fn(() => "PRIVATE_ERROR");
    onInternalDiagnosticEvent(listener);
    emitDiagnosticEvent({
      type: "message.processed",
      sessionKey,
      channel: "webchat",
      outcome: "error",
      durationMs: 42,
      get error() {
        return readError();
      },
    });
    expect(listener).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "message.processed", outcome: "error", durationMs: 42 }),
      expect.anything(),
    );
    expect(listener.mock.calls[0]?.[0]).not.toHaveProperty("error");
    expect(readError).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "keeps blocked tool liveness without optional reason text, enabled=%s",
    async (enabled) => {
      setDiagnosticsEnabledForProcess(enabled);
      const liveness = vi.fn();
      const listener = vi.fn();
      const readReason = vi.fn(() => "PRIVATE_BLOCKED_COMMAND");
      onTrustedToolExecutionEvent(liveness);
      onTrustedInternalDiagnosticEvent(listener);
      emitTrustedDiagnosticEventWithPrivateData({
        type: "tool.execution.blocked",
        sessionKey,
        toolName: "exec",
        deniedReason: "plugin-before-tool-call",
        get reason() {
          return readReason();
        },
      });
      await waitForDiagnosticEventsDrained();
      expect(liveness).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          type: "tool.execution.blocked",
          toolName: "exec",
          reason: "plugin-before-tool-call",
        }),
      );
      expect(readReason).not.toHaveBeenCalled();
      expect(JSON.stringify(listener.mock.calls)).not.toContain("PRIVATE_");
    },
  );

  it("omits optional state and loop text without reading private getters", () => {
    const listener = vi.fn();
    const readReason = vi.fn(() => "PRIVATE_STATE_REASON");
    const readMessage = vi.fn(() => "PRIVATE_LOOP_MESSAGE");
    onInternalDiagnosticEvent(listener);
    emitDiagnosticEvent({
      type: "session.state",
      sessionKey,
      state: "processing",
      queueDepth: 2,
      get reason() {
        return readReason();
      },
    });
    emitDiagnosticEvent({
      type: "tool.loop",
      sessionKey,
      toolName: "exec",
      level: "critical",
      action: "block",
      detector: "generic_repeat",
      count: 10,
      get message() {
        return readMessage();
      },
    });
    expect(readReason).not.toHaveBeenCalled();
    expect(readMessage).not.toHaveBeenCalled();
    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ type: "session.state", state: "processing", queueDepth: 2 }),
      expect.objectContaining({
        type: "tool.loop",
        action: "block",
        count: 10,
        message: "generic_repeat:block",
      }),
    ]);
    expect(JSON.stringify(listener.mock.calls)).not.toContain("PRIVATE_");
  });

  it("preserves ordinary optional text and semantic private progress reasons", async () => {
    const listener = vi.fn();
    onInternalDiagnosticEvent(listener);
    emitDiagnosticEvent({
      type: "session.state",
      sessionKey: "agent:main:main",
      state: "idle",
      reason: "ordinary reason",
    });
    emitDiagnosticEvent({ type: "run.progress", sessionKey, reason: "model_response" });
    await waitForDiagnosticEventsDrained();
    expect(listener.mock.calls.map(([event]) => event.reason)).toEqual([
      "ordinary reason",
      "model_response",
    ]);
  });
});
