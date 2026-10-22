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
function session(incognito: boolean, suffix: string) {
  return {
    sessionKey: `agent:main:dashboard:${incognito ? "incognito-" : ""}${suffix}`,
    sessionId: `${incognito ? "private" : "ordinary"}-${suffix}-id`,
  };
}
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
    const logs = (["debug", "warn", "error"] as const).map((level) =>
      vi.spyOn(diagnosticLogger, level).mockImplementation(() => {}),
    );
    for (const incognito of [true, false]) {
      const { sessionKey, sessionId } = session(incognito, "diagnostic");
      const state = getDiagnosticSessionState({ sessionId, sessionKey });
      const ref = identity === "key" ? { sessionKey } : { sessionId };
      const marker = incognito
        ? "SYNTHETIC_PRIVATE_DIAGNOSTIC_TEXT"
        : "SYNTHETIC_ORDINARY_DIAGNOSTIC_TEXT";
      const failure = { outcome: "error", reason: marker, error: marker } as const;
      const failed = { ...ref, ...failure };
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
      for (const next of ["processing", "idle"] as const) {
        logSessionStateChange({ ...ref, state: next, reason: marker });
        expect(state.state).toBe(next);
      }
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
      const output = JSON.stringify(logs.flatMap((log) => log.mock.calls));
      if (incognito) {
        expect(output).not.toContain(marker);
      } else {
        expect(output).toContain(marker);
      }
      for (const expected of [
        { type: "message.dispatch.completed", ...failure },
        { type: "message.processed", agentId: "main", ...failure },
        { type: "session.state", prevState: "idle", state: "processing", reason: marker },
        { type: "session.state", prevState: "processing", state: "idle", reason: marker },
        { type: "tool.loop", agentId: "main", action: "warn", count: 3, message: marker },
      ]) {
        expect(events).toContainEqual(expect.objectContaining({ sessionKey, ...expected }));
      }
    }
  },
);

it.each([true, false])(
  "preserves heartbeat recovery and events with Incognito=%s",
  async (incognito) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const warn = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => {});
    const recoverStuckSession = vi.fn();
    const ref = session(incognito, "stuck");
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
