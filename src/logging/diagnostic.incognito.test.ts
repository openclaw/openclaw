import { afterEach, expect, it, vi } from "vitest";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "./diagnostic-session-state.js";
import { logToolLoopAction } from "./diagnostic-tool-loop.js";
import {
  diagnosticLogger,
  logMessageDispatchCompleted,
  logMessageProcessed,
  logSessionStateChange,
} from "./diagnostic.js";

afterEach(() => {
  setDiagnosticsEnabledForProcess(false);
  resetDiagnosticSessionStateForTest();
  resetDiagnosticEventsForTest();
  vi.restoreAllMocks();
});

it.each(["key", "session-id"] as const)(
  "keeps Incognito text out of formatted logs for a %s while retaining lifecycle state",
  (identity) => {
    setDiagnosticsEnabledForProcess(true);
    vi.spyOn(diagnosticLogger, "isEnabled").mockReturnValue(true);
    const debug = vi.spyOn(diagnosticLogger, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => {});
    const error = vi.spyOn(diagnosticLogger, "error").mockImplementation(() => {});
    const events: DiagnosticEventPayload[] = [];
    onDiagnosticEvent((event) => events.push(event));
    const run = (incognito: boolean) => {
      const sessionKey = `agent:main:dashboard:${incognito ? "incognito-" : ""}diagnostic`;
      const sessionId = incognito ? "private-diagnostic-id" : "ordinary-diagnostic-id";
      const state = getDiagnosticSessionState({ sessionId, sessionKey });
      const ref = identity === "key" ? { sessionKey } : { sessionId };
      const marker = incognito
        ? "SYNTHETIC_PRIVATE_DIAGNOSTIC_TEXT"
        : "SYNTHETIC_ORDINARY_DIAGNOSTIC_TEXT";
      logMessageDispatchCompleted({
        ...ref,
        source: "test",
        durationMs: 1,
        outcome: "error",
        reason: marker,
        error: marker,
      });
      logMessageProcessed({
        ...ref,
        agentId: "main",
        channel: "webchat",
        outcome: "error",
        reason: marker,
        error: marker,
      });
      logSessionStateChange({ ...ref, state: "processing", reason: marker });
      expect(state.state).toBe("processing");
      logSessionStateChange({ ...ref, state: "idle", reason: marker });
      expect(state.state).toBe("idle");
      logToolLoopAction({
        ...ref,
        agentId: "main",
        toolName: "test",
        level: "warning",
        action: "warn",
        detector: "generic_repeat",
        count: 3,
        message: marker,
      });
    };
    run(true);
    run(false);
    const output = JSON.stringify([...debug.mock.calls, ...warn.mock.calls, ...error.mock.calls]);
    expect(output).not.toContain("SYNTHETIC_PRIVATE_DIAGNOSTIC_TEXT");
    expect(output).toContain("SYNTHETIC_ORDINARY_DIAGNOSTIC_TEXT");
    expect(events).toHaveLength(10);
    for (const event of events) {
      if (event.type === "message.processed" || event.type === "tool.loop") {
        expect(event).toMatchObject({ agentId: "main" });
      }
    }
    expect(
      events.every(
        (event) => "sessionKey" in event && event.sessionKey?.startsWith("agent:main:dashboard:"),
      ),
    ).toBe(true);
  },
);
