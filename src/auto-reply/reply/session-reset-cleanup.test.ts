import { afterEach, describe, expect, it } from "vitest";
import {
  enqueueSystemEvent,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticToolStartedForTest,
  resetDiagnosticRunActivityForTest,
} from "../../logging/diagnostic-run-activity.js";
import { clearSessionResetRuntimeState } from "./session-reset-cleanup.js";

afterEach(() => {
  resetSystemEventsForTest();
  resetDiagnosticRunActivityForTest();
});

describe("clearSessionResetRuntimeState", () => {
  it("clears reset queues and drains system events for normalized keys", () => {
    enqueueSystemEvent("stale alpha", { sessionKey: "alpha" });
    enqueueSystemEvent("stale beta", { sessionKey: "beta" });
    enqueueSystemEvent("fresh gamma", { sessionKey: "gamma" });

    const result = clearSessionResetRuntimeState([" alpha ", undefined, " ", "alpha", "beta"]);

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

  it("clears stale diagnostic tool activity for reset session refs", () => {
    markDiagnosticToolStartedForTest({
      sessionId: "session-old",
      sessionKey: "agent:main:telegram:chat-1",
      runId: "run-old",
      toolName: "bash",
      toolCallId: "tool-old",
    });

    const result = clearSessionResetRuntimeState(["agent:main:telegram:chat-1", "session-old"]);

    expect(result.diagnosticActivityCleared).toEqual({
      activeEmbeddedRunsCleared: 0,
      activeToolsCleared: 1,
      activeModelCallsCleared: 0,
      activitiesCleared: 1,
    });
    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "session-old",
        sessionKey: "agent:main:telegram:chat-1",
      }).activeWorkKind,
    ).toBeUndefined();
  });
});
