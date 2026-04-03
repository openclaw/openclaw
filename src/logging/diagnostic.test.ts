import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import {
  diagnosticSessionStates,
  getDiagnosticSessionStateCountForTest,
  getDiagnosticSessionState,
  pruneDiagnosticSessionStates,
  resetDiagnosticSessionStateForTest,
} from "./diagnostic-session-state.js";
import {
  __testing,
  logEarlyStatusPolicyDecision,
  logMessageFirstVisibleTimeout,
  logMessageFirstVisible,
  logTurnLatencyStage,
  logSessionStateChange,
  resetDiagnosticStateForTest,
  resolveFirstVisibleWarnMs,
  resolveStuckSessionWarnMs,
  startDiagnosticHeartbeat,
} from "./diagnostic.js";

describe("diagnostic session state pruning", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDiagnosticSessionStateForTest();
  });

  afterEach(() => {
    resetDiagnosticSessionStateForTest();
    vi.useRealTimers();
  });

  it("evicts stale idle session states", () => {
    getDiagnosticSessionState({ sessionId: "stale-1" });
    expect(getDiagnosticSessionStateCountForTest()).toBe(1);

    vi.advanceTimersByTime(31 * 60 * 1000);
    getDiagnosticSessionState({ sessionId: "fresh-1" });

    expect(getDiagnosticSessionStateCountForTest()).toBe(1);
  });

  it("caps tracked session states to a bounded max", () => {
    const now = Date.now();
    for (let i = 0; i < 2001; i += 1) {
      diagnosticSessionStates.set(`session-${i}`, {
        sessionId: `session-${i}`,
        lastActivity: now + i,
        state: "idle",
        queueDepth: 1,
      });
    }
    pruneDiagnosticSessionStates(now + 2002, true);

    expect(getDiagnosticSessionStateCountForTest()).toBe(2000);
  });

  it("reuses keyed session state when later looked up by sessionId", () => {
    const keyed = getDiagnosticSessionState({
      sessionId: "s1",
      sessionKey: "agent:main:demo-channel:channel:c1",
    });
    const bySessionId = getDiagnosticSessionState({ sessionId: "s1" });

    expect(bySessionId).toBe(keyed);
    expect(bySessionId.sessionKey).toBe("agent:main:demo-channel:channel:c1");
    expect(getDiagnosticSessionStateCountForTest()).toBe(1);
  });
});

describe("logger import side effects", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not mkdir at import time", async () => {
    vi.useRealTimers();
    vi.resetModules();

    const mkdirSpy = vi.spyOn(fs, "mkdirSync");

    await import("./logger.js");

    expect(mkdirSpy).not.toHaveBeenCalled();
  });
});

describe("stuck session diagnostics threshold", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDiagnosticStateForTest();
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticStateForTest();
    vi.useRealTimers();
  });

  it("uses the configured diagnostics.stuckSessionWarnMs threshold", () => {
    const events: Array<{ type: string }> = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      events.push({ type: event.type });
    });
    try {
      startDiagnosticHeartbeat({
        diagnostics: {
          enabled: true,
          stuckSessionWarnMs: 30_000,
        },
      });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      vi.advanceTimersByTime(61_000);
    } finally {
      unsubscribe();
    }

    expect(events.filter((event) => event.type === "session.stuck")).toHaveLength(1);
  });

  it("falls back to default threshold when config is absent", () => {
    const events: Array<{ type: string }> = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      events.push({ type: event.type });
    });
    try {
      startDiagnosticHeartbeat();
      logSessionStateChange({ sessionId: "s2", sessionKey: "main", state: "processing" });
      vi.advanceTimersByTime(31_000);
    } finally {
      unsubscribe();
    }

    expect(events.filter((event) => event.type === "session.stuck")).toHaveLength(0);
  });

  it("uses the configured diagnostics.firstVisibleWarnMs threshold", () => {
    expect(resolveFirstVisibleWarnMs({ diagnostics: { firstVisibleWarnMs: 6_000 } })).toBe(6_000);
  });

  it("includes recent first-visible summary in heartbeat events", () => {
    const events: Array<{
      type: string;
      firstVisible?: {
        sampleCount: number;
        avgMs: number;
        p95Ms: number;
        maxMs: number;
        timeoutCount: number;
      };
      earlyStatus?: {
        sampleCount: number;
        eligibleCount: number;
        semanticGateCount: number;
        latencyGateCount: number;
        topReasons?: Array<{ reason: string; count: number }>;
        phase2Supplements?: {
          sampleCount: number;
          eligibleCount: number;
          hitRatePct: number;
          topSkipReasons?: Array<{ reason: string; count: number }>;
          statusFirstVisibleAvgMs?: number;
          statusFirstVisibleP95Ms?: number;
        };
      };
      latency?: {
        sampleCount: number;
        dominant?: Array<{ segment: string; count: number }>;
        segments?: Record<string, { avgMs: number; p95Ms: number; maxMs: number }>;
      };
    }> = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      if (event.type === "diagnostic.heartbeat") {
        events.push({
          type: event.type,
          firstVisible: event.firstVisible,
          earlyStatus: event.earlyStatus,
          latency: event.latency,
        });
      }
    });
    try {
      startDiagnosticHeartbeat({
        diagnostics: {
          enabled: true,
          stuckSessionWarnMs: 30_000,
        },
      });
      logMessageFirstVisible({
        channel: "slack",
        sessionKey: "agent:main:main",
        kind: "final",
        dispatchToFirstVisibleMs: 1200,
      });
      logMessageFirstVisible({
        channel: "slack",
        sessionKey: "agent:main:main",
        kind: "final",
        dispatchToFirstVisibleMs: 2200,
      });
      logMessageFirstVisibleTimeout({
        channel: "slack",
        sessionKey: "agent:main:main",
        thresholdMs: 4000,
      });
      vi.advanceTimersByTime(30_000);
    } finally {
      unsubscribe();
    }

    expect(events.at(-1)).toEqual({
      type: "diagnostic.heartbeat",
      firstVisible: {
        sampleCount: 2,
        avgMs: 1700,
        p95Ms: 2200,
        maxMs: 2200,
        timeoutCount: 1,
      },
      earlyStatus: undefined,
      latency: undefined,
    });
  });

  it("includes recent turn latency segment summaries in heartbeat events", () => {
    const events: Array<{
      type: string;
      latency?: {
        sampleCount: number;
        segments?: Record<string, { avgMs: number; p95Ms: number; maxMs: number }>;
      };
    }> = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      if (event.type === "diagnostic.heartbeat") {
        events.push({
          type: event.type,
          latency: event.latency,
        });
      }
    });
    try {
      startDiagnosticHeartbeat({
        diagnostics: {
          enabled: true,
          stuckSessionWarnMs: 30_000,
        },
      });
      logTurnLatencyStage({
        turnLatencyId: "turn-1",
        stage: "queue_arbitrated",
        channel: "slack",
        sessionKey: "agent:main:main",
        durationMs: 100,
      });
      logTurnLatencyStage({
        turnLatencyId: "turn-1",
        stage: "run_started",
        channel: "slack",
        sessionKey: "agent:main:main",
        durationMs: 400,
      });
      logTurnLatencyStage({
        turnLatencyId: "turn-1",
        stage: "acp_ensure_session_completed",
        channel: "slack",
        sessionKey: "agent:main:main",
        durationMs: 250,
      });
      logTurnLatencyStage({
        turnLatencyId: "turn-1",
        stage: "acp_first_event",
        channel: "slack",
        sessionKey: "agent:main:main",
        durationMs: 900,
      });
      logTurnLatencyStage({
        turnLatencyId: "turn-1",
        stage: "acp_first_visible_output",
        channel: "slack",
        sessionKey: "agent:main:main",
        durationMs: 1200,
        firstVisibleKind: "block",
      });
      logTurnLatencyStage({
        turnLatencyId: "turn-1",
        stage: "first_visible_emitted",
        channel: "slack",
        sessionKey: "agent:main:main",
        durationMs: 1200,
        firstVisibleKind: "block",
      });
      logTurnLatencyStage({
        turnLatencyId: "turn-1",
        stage: "final_dispatched",
        channel: "slack",
        sessionKey: "agent:main:main",
        durationMs: 1800,
      });
      logTurnLatencyStage({
        turnLatencyId: "turn-1",
        stage: "completed",
        channel: "slack",
        sessionKey: "agent:main:main",
        durationMs: 2000,
      });
      vi.advanceTimersByTime(30_000);
    } finally {
      unsubscribe();
    }

    expect(events.at(-1)).toEqual({
      type: "diagnostic.heartbeat",
      latency: {
        sampleCount: 1,
        dominant: [{ segment: "runToFirstVisible", count: 1 }],
        segments: {
          dispatchToQueue: { avgMs: 100, p95Ms: 100, maxMs: 100 },
          queueToRun: { avgMs: 300, p95Ms: 300, maxMs: 300 },
          acpEnsureToRun: { avgMs: 150, p95Ms: 150, maxMs: 150 },
          runToFirstEvent: { avgMs: 500, p95Ms: 500, maxMs: 500 },
          firstEventToFirstVisible: { avgMs: 300, p95Ms: 300, maxMs: 300 },
          runToFirstVisible: { avgMs: 800, p95Ms: 800, maxMs: 800 },
          firstVisibleToFinal: { avgMs: 600, p95Ms: 600, maxMs: 600 },
          endToEnd: { avgMs: 2000, p95Ms: 2000, maxMs: 2000 },
        },
      },
    });
  });

  it("uses default threshold for invalid values", () => {
    expect(resolveStuckSessionWarnMs({ diagnostics: { stuckSessionWarnMs: -1 } })).toBe(120_000);
    expect(resolveStuckSessionWarnMs({ diagnostics: { stuckSessionWarnMs: 0 } })).toBe(120_000);
    expect(resolveStuckSessionWarnMs()).toBe(120_000);
    expect(resolveFirstVisibleWarnMs({ diagnostics: { firstVisibleWarnMs: -1 } })).toBe(4_000);
    expect(resolveFirstVisibleWarnMs({ diagnostics: { firstVisibleWarnMs: 0 } })).toBe(4_000);
    expect(resolveFirstVisibleWarnMs()).toBe(4_000);
  });

  it("includes early-status policy gate summaries in heartbeat events", () => {
    const events: Array<{
      type: string;
      earlyStatus?: {
        sampleCount: number;
        eligibleCount: number;
        semanticGateCount: number;
        latencyGateCount: number;
        topReasons?: Array<{ reason: string; count: number }>;
      };
    }> = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      if (event.type === "diagnostic.heartbeat") {
        events.push({
          type: event.type,
          earlyStatus: event.earlyStatus,
        });
      }
    });
    try {
      startDiagnosticHeartbeat({
        diagnostics: {
          enabled: true,
          stuckSessionWarnMs: 30_000,
        },
      });
      logEarlyStatusPolicyDecision({
        channel: "slack",
        sessionKey: "agent:main:main",
        queueMode: "collect",
        decisionShouldEmit: true,
        activationShouldEmit: true,
        decisionReason: "replacement_of_active_foreground_task_is_user_visible",
        activationReason: "phase2_supplement_status_enabled_for_visible_silence_reduction",
        recommendationLevel: "prioritize",
        recommendationReason: "runtime_started_but_visible_feedback_arrives_late",
      });
      logEarlyStatusPolicyDecision({
        channel: "slack",
        sessionKey: "agent:main:main",
        queueMode: "followup",
        decisionShouldEmit: true,
        activationShouldEmit: false,
        decisionReason: "same_task_supplement_should_acknowledge_new_material",
        activationReason: "latency_priority_observe",
        recommendationLevel: "observe",
        recommendationReason:
          "latency_is_dominant_before_visible_feedback_is_semantically_decidable",
      });
      logMessageFirstVisible({
        channel: "slack",
        sessionKey: "agent:main:main",
        kind: "status",
        dispatchToFirstVisibleMs: 780,
      });
      logMessageFirstVisible({
        channel: "slack",
        sessionKey: "agent:main:main",
        kind: "status",
        dispatchToFirstVisibleMs: 940,
      });
      logEarlyStatusPolicyDecision({
        channel: "slack",
        sessionKey: "agent:main:main",
        queueMode: "queue",
        decisionShouldEmit: false,
        activationShouldEmit: false,
        decisionReason: "defer_path_not_yet_modeled_as_truthful_early_status",
        activationReason: "defer_path_not_yet_modeled_as_truthful_early_status",
        recommendationLevel: "prioritize",
        recommendationReason: "runtime_started_but_visible_feedback_arrives_late",
      });
      vi.advanceTimersByTime(30_000);
    } finally {
      unsubscribe();
    }

    expect(events.at(-1)).toEqual({
      type: "diagnostic.heartbeat",
      earlyStatus: {
        sampleCount: 3,
        eligibleCount: 1,
        semanticGateCount: 1,
        latencyGateCount: 1,
        topReasons: [
          {
            reason: "phase2_supplement_status_enabled_for_visible_silence_reduction",
            count: 1,
          },
          { reason: "latency_priority_observe", count: 1 },
          {
            reason: "defer_path_not_yet_modeled_as_truthful_early_status",
            count: 1,
          },
        ],
        phase2Supplements: {
          sampleCount: 2,
          eligibleCount: 1,
          hitRatePct: 50,
          topSkipReasons: [{ reason: "latency_priority_observe", count: 1 }],
          statusFirstVisibleAvgMs: 860,
          statusFirstVisibleP95Ms: 940,
        },
      },
    });
  });

  it("formats heartbeat latency summaries as readable segment text", () => {
    expect(
      __testing.formatLatencyHeartbeatSummary({
        sampleCount: 2,
        dominant: [{ segment: "runToFirstVisible", count: 2 }],
        segments: {
          dispatchToQueue: { avgMs: 100, p95Ms: 120, maxMs: 140 },
          runToFirstVisible: { avgMs: 900, p95Ms: 1100, maxMs: 1300 },
          endToEnd: { avgMs: 2200, p95Ms: 2600, maxMs: 3000 },
        },
      }),
    ).toBe(
      " latency=2 queue=100/120/140ms | run->visible=900/1100/1300ms | endToEnd=2200/2600/3000ms | dominant=runToFirstVisiblex2",
    );
  });

  it("formats heartbeat early-status summaries as readable gate text", () => {
    expect(
      __testing.formatEarlyStatusHeartbeatSummary({
        sampleCount: 4,
        eligibleCount: 1,
        semanticGateCount: 2,
        latencyGateCount: 1,
        topReasons: [{ reason: "latency_priority_observe", count: 2 }],
        phase2Supplements: {
          sampleCount: 2,
          eligibleCount: 1,
          hitRatePct: 50,
          statusFirstVisibleAvgMs: 860,
          statusFirstVisibleP95Ms: 940,
        },
      }),
    ).toBe(
      " earlyStatus=4 | eligible=1 | semanticGate=2 | latencyGate=1 | reasons=latency_priority_observex2 | phase2=1/2(50%) | statusVisible=860/940ms",
    );
  });
});
