import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEmbeddedSessionLane } from "../agents/pi-embedded-runner/lanes.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../logging/diagnostic-session-state.js";
import {
  enqueueCommandInLane,
  resetAllLanes,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import { buildQueueDiagnosticsSnapshot } from "./queue-diagnostics.js";

describe("buildQueueDiagnosticsSnapshot", () => {
  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetAllLanes();
  });

  it("merges lane backlog with tracked session state and flags stuck sessions", async () => {
    const sessionKey = "agent:alpha:main";
    const lane = resolveEmbeddedSessionLane(sessionKey);
    setCommandLaneConcurrency(lane, 1);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      let release!: () => void;
      const blocker = new Promise<void>((resolve) => {
        release = resolve;
      });

      const first = enqueueCommandInLane(lane, async () => {
        await blocker;
      });
      await Promise.resolve();

      vi.setSystemTime(1_500);
      const second = enqueueCommandInLane(lane, async () => "done");

      const sessionState = getDiagnosticSessionState({
        sessionId: "sess-1",
        sessionKey,
      });
      sessionState.state = "processing";
      sessionState.queueDepth = 2;
      sessionState.lastActivity = 1_000;

      const snapshot = buildQueueDiagnosticsSnapshot({
        now: 200_000,
        stuckSessionWarnMs: 60_000,
      });

      expect(snapshot.summary).toMatchObject({
        active: 1,
        queued: 1,
        sessions: 1,
        stuckSessions: 1,
      });
      expect(snapshot.lanes[0]).toMatchObject({
        lane,
        active: 1,
        queued: 1,
      });
      expect(snapshot.sessions[0]).toMatchObject({
        sessionId: "sess-1",
        sessionKey,
        lane,
        state: "processing",
        queueDepth: 2,
        stuck: true,
      });

      release();
      await expect(first).resolves.toBeUndefined();
      await expect(second).resolves.toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits idle lanes and sessions by default", () => {
    const sessionState = getDiagnosticSessionState({
      sessionId: "idle-1",
      sessionKey: "main",
    });
    sessionState.state = "idle";
    sessionState.queueDepth = 0;
    sessionState.lastActivity = 10;

    const hidden = buildQueueDiagnosticsSnapshot({
      now: 20,
      stuckSessionWarnMs: 10_000,
    });
    expect(hidden.summary.sessions).toBe(0);
    expect(hidden.summary.lanes).toBe(0);

    const visible = buildQueueDiagnosticsSnapshot({
      now: 20,
      includeIdle: true,
      stuckSessionWarnMs: 10_000,
    });
    expect(visible.sessions).toHaveLength(1);
  });
});
