import { afterEach, describe, expect, it } from "vitest";
import {
  enqueueSystemEvent,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticModelStartedForTest,
  markDiagnosticToolStartedForTest,
  resetDiagnosticRunActivityForTest,
} from "../../logging/diagnostic-run-activity.js";
import {
  clearRetiredSessionDiagnosticActivity,
  clearSessionResetRuntimeState,
} from "./session-reset-cleanup.js";

afterEach(() => {
  resetSystemEventsForTest();
  resetDiagnosticRunActivityForTest();
});

describe("clearSessionResetRuntimeState", () => {
  it("clears reset queues and drains system events for normalized keys", () => {
    enqueueSystemEvent("stale alpha", { sessionKey: "alpha" });
    enqueueSystemEvent("stale beta", { sessionKey: "beta" });
    enqueueSystemEvent("fresh gamma", { sessionKey: "gamma" });

    const result = clearSessionResetRuntimeState({
      sessionKeys: [" alpha ", undefined, " ", "alpha", "beta"],
    });

    expect(result.keys).toEqual(["alpha", "beta"]);
    expect(result.systemEventsCleared).toBe(2);
    expect(result.diagnosticActivityCleared).toEqual({
      activeEmbeddedRunsCleared: 0,
      activeToolsCleared: 0,
      activeModelCallsCleared: 0,
      activitiesCleared: 0,
    });
    expect(peekSystemEvents("alpha")).toStrictEqual([]);
    expect(peekSystemEvents("beta")).toStrictEqual([]);
    expect(peekSystemEvents("gamma")).toEqual(["fresh gamma"]);
  });

  it("clears stale diagnostic activity for reset session refs", () => {
    markDiagnosticToolStartedForTest({
      sessionId: "session-old",
      sessionKey: "agent:main:telegram:chat-1",
      runId: "run-old",
      toolName: "bash",
      toolCallId: "tool-old",
    });
    markDiagnosticModelStartedForTest({
      sessionId: "session-old",
      sessionKey: "agent:main:telegram:chat-1",
      runId: "run-old",
      provider: "openai",
      model: "gpt-5.5",
    });

    const result = clearSessionResetRuntimeState({
      sessionKeys: ["agent:main:telegram:chat-1"],
      retiredSessionIds: ["session-old"],
    });

    expect(result.diagnosticActivityCleared).toEqual({
      activeEmbeddedRunsCleared: 0,
      activeToolsCleared: 1,
      activeModelCallsCleared: 1,
      activitiesCleared: 1,
    });
    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "session-old",
        sessionKey: "agent:main:telegram:chat-1",
      }).activeWorkKind,
    ).toBeUndefined();
  });

  it("keeps diagnostic activity for key-only cleanup without a retired session id", () => {
    markDiagnosticToolStartedForTest({
      sessionId: "session-active",
      sessionKey: "agent:main:telegram:chat-1",
      runId: "run-active",
      toolName: "bash",
      toolCallId: "tool-active",
    });

    const result = clearSessionResetRuntimeState({
      sessionKeys: ["agent:main:telegram:chat-1"],
    });

    expect(result.diagnosticActivityCleared).toEqual({
      activeEmbeddedRunsCleared: 0,
      activeToolsCleared: 0,
      activeModelCallsCleared: 0,
      activitiesCleared: 0,
    });
    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "session-active",
        sessionKey: "agent:main:telegram:chat-1",
      }).activeWorkKind,
    ).toBe("tool_call");
  });

  it("clears key-only diagnostic activity for explicitly retired session keys", () => {
    markDiagnosticToolStartedForTest({
      sessionKey: "agent:main:telegram:chat-1",
      runId: "run-old-key-only",
      toolName: "bash",
      toolCallId: "tool-old-key-only",
    });

    const result = clearSessionResetRuntimeState({
      sessionKeys: ["agent:main:telegram:chat-1"],
      retiredSessionKeys: ["agent:main:telegram:chat-1"],
    });

    expect(result.diagnosticActivityCleared).toEqual({
      activeEmbeddedRunsCleared: 0,
      activeToolsCleared: 1,
      activeModelCallsCleared: 0,
      activitiesCleared: 1,
    });
    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionKey: "agent:main:telegram:chat-1",
      }).activeWorkKind,
    ).toBeUndefined();
  });

  it("can defer retired-session diagnostic cleanup until the active run settles", () => {
    markDiagnosticEmbeddedRunStarted({
      sessionId: "session-active",
      sessionKey: "agent:main:telegram:chat-1",
    });

    const result = clearSessionResetRuntimeState({
      sessionKeys: ["agent:main:telegram:chat-1"],
      retiredSessionIds: ["session-active"],
      clearRetiredDiagnosticActivity: false,
    });

    expect(result.keys).toEqual(["agent:main:telegram:chat-1", "session-active"]);
    expect(result.diagnosticActivityCleared).toEqual({
      activeEmbeddedRunsCleared: 0,
      activeToolsCleared: 0,
      activeModelCallsCleared: 0,
      activitiesCleared: 0,
    });
    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "session-active",
        sessionKey: "agent:main:telegram:chat-1",
      }).activeWorkKind,
    ).toBe("embedded_run");

    expect(clearRetiredSessionDiagnosticActivity(["session-active"])).toEqual({
      activeEmbeddedRunsCleared: 1,
      activeToolsCleared: 0,
      activeModelCallsCleared: 0,
      activitiesCleared: 1,
    });
    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "session-active",
        sessionKey: "agent:main:telegram:chat-1",
      }).activeWorkKind,
    ).toBeUndefined();
  });
});
