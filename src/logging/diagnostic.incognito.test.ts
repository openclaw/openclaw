import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { getDiagnosticSessionState } from "./diagnostic-session-state.js";
import { logToolLoopAction } from "./diagnostic-tool-loop.js";
import {
  diagnosticLogger,
  logMessageDispatchCompleted,
  logMessageProcessed,
  logSessionStateChange,
} from "./diagnostic.js";
import {
  resetDiagnosticStateForTest,
  startEnabledDiagnosticHeartbeatForTest,
} from "./diagnostic.test-support.js";

const events: DiagnosticEventPayload[] = [];
beforeEach(() => {
  resetDiagnosticStateForTest();
  resetDiagnosticEventsForTest();
  setDiagnosticsEnabledForProcess(true);
  vi.spyOn(diagnosticLogger, "isEnabled").mockReturnValue(true);
  events.length = 0;
  onInternalDiagnosticEvent((event) => events.push(event));
});

afterEach(() => {
  resetDiagnosticStateForTest();
  resetDiagnosticEventsForTest();
  setDiagnosticsEnabledForProcess(false);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["key", "session-id"] as const)(
  "keeps Incognito text out of formatted logs for a %s while retaining lifecycle state",
  async (identity) => {
    const debug = vi.spyOn(diagnosticLogger, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => {});
    const error = vi.spyOn(diagnosticLogger, "error").mockImplementation(() => {});
    const run = async (incognito: boolean) => {
      const sessionKey = `agent:main:dashboard:${incognito ? "incognito-" : ""}diagnostic`;
      const sessionId = incognito ? "private-diagnostic-id" : "ordinary-diagnostic-id";
      const state = getDiagnosticSessionState({ sessionId, sessionKey });
      const ref = identity === "key" ? { sessionKey } : { sessionId };
      const marker = incognito
        ? "SYNTHETIC_PRIVATE_DIAGNOSTIC_TEXT"
        : "SYNTHETIC_ORDINARY_DIAGNOSTIC_TEXT";
      const failed = { ...ref, outcome: "error", reason: marker, error: marker } as const;
      logMessageDispatchCompleted({
        ...failed,
        source: "test",
        durationMs: 1,
      });
      logMessageProcessed({
        ...failed,
        agentId: "main",
        channel: "webchat",
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
      await waitForDiagnosticEventsDrained();
      const output = JSON.stringify([...debug.mock.calls, ...warn.mock.calls, ...error.mock.calls]);
      if (incognito) {
        expect(output).not.toContain(marker);
      } else {
        expect(output).toContain(marker);
      }
      for (const expected of [
        { type: "message.dispatch.completed", outcome: "error", reason: marker, error: marker },
        {
          type: "message.processed",
          agentId: "main",
          outcome: "error",
          reason: marker,
          error: marker,
        },
        { type: "session.state", prevState: "idle", state: "processing", reason: marker },
        { type: "session.state", prevState: "processing", state: "idle", reason: marker },
        { type: "tool.loop", agentId: "main", action: "warn", count: 3, message: marker },
      ]) {
        expect(events).toContainEqual(expect.objectContaining({ sessionKey, ...expected }));
      }
    };
    await run(true);
    await run(false);
  },
);

it.each([true, false])(
  "preserves heartbeat recovery and events with Incognito=%s",
  async (incognito) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const warn = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => {});
    const recoverStuckSession = vi.fn();
    const ref = {
      sessionId: incognito ? "private-stuck-id" : "ordinary-stuck-id",
      sessionKey: `agent:main:dashboard:${incognito ? "incognito-" : ""}stuck`,
    };
    startEnabledDiagnosticHeartbeatForTest({ recoverStuckSession });
    logSessionStateChange({ ...ref, state: "processing" });

    await vi.advanceTimersByTimeAsync(61_000);
    await waitForDiagnosticEventsDrained();

    expect(recoverStuckSession).toHaveBeenCalledWith(expect.objectContaining(ref));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "session.stuck", ...ref, state: "processing" }),
    );
    if (incognito) {
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining(ref.sessionKey));
    } else {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`sessionKey=${ref.sessionKey}`));
    }
  },
);
