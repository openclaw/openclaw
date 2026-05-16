import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEmbeddedSessionLane } from "../agents/pi-embedded-runner/lanes.js";
import {
  __testing as embeddedRunTesting,
  clearActiveEmbeddedRun,
  isEmbeddedPiRunActive,
  queueEmbeddedPiMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
  type EmbeddedPiQueueHandle,
} from "../agents/pi-embedded-runner/runs.js";
import {
  __testing as replyRunTesting,
  createReplyOperation,
} from "../auto-reply/reply/reply-run-registry.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import {
  enqueueCommandInLane,
  getQueueSize,
  resetCommandLane,
  resetCommandQueueStateForTest,
} from "../process/command-queue.js";
import { markDiagnosticRunProgressForTest } from "./diagnostic-run-activity.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "./diagnostic-session-state.js";
import {
  __testing as recoveryTesting,
  recoverStuckDiagnosticSession,
} from "./diagnostic-stuck-session-recovery.runtime.js";
import {
  logSessionStateChange,
  resetDiagnosticStateForTest,
  startDiagnosticHeartbeat,
} from "./diagnostic.js";

function delay(ms: number): Promise<"blocked"> {
  return new Promise((resolve) => setTimeout(() => resolve("blocked"), ms));
}

function requireMatchingEvent(
  events: readonly DiagnosticEventPayload[],
  fields: Record<string, unknown>,
  label: string,
): DiagnosticEventPayload {
  const found = events.find((event) => {
    const record = event as unknown as Record<string, unknown>;
    return Object.entries(fields).every(([key, value]) => Object.is(record[key], value));
  });
  if (!found) {
    throw new Error(`missing ${label}`);
  }
  return found;
}

describe("stuck session recovery integration", () => {
  afterEach(() => {
    embeddedRunTesting.resetActiveEmbeddedRuns();
    recoveryTesting.resetRecoveriesInFlight();
    replyRunTesting.resetReplyRunRegistry();
    resetDiagnosticEventsForTest();
    resetDiagnosticStateForTest();
    resetDiagnosticSessionStateForTest();
    resetCommandQueueStateForTest();
    vi.useRealTimers();
  });

  it("does not reset a blocked lane while a reply operation is still active", async () => {
    const sessionKey = "agent:main:active-reply";
    const sessionId = "active-reply-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);

    void enqueueCommandInLane(lane, () => new Promise<never>(() => {}), {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    const queued = enqueueCommandInLane(lane, async () => "drained", {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    const operation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });

    expect(getQueueSize(lane)).toBe(2);

    await recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      ageMs: 180_000,
      queueDepth: 1,
    });

    await expect(Promise.race([queued, delay(100)])).resolves.toBe("blocked");
    expect(getQueueSize(lane)).toBe(2);

    operation.complete();
    expect(resetCommandLane(lane)).toBe(1);
    await expect(queued).resolves.toBe("drained");
  });

  it("does not reset a blocked lane while unregistered lane work is still active", async () => {
    const sessionKey = "agent:main:unregistered-work";
    const sessionId = "unregistered-work-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);

    void enqueueCommandInLane(lane, () => new Promise<never>(() => {}), {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    const queued = enqueueCommandInLane(lane, async () => "drained", {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });

    expect(getQueueSize(lane)).toBe(2);

    await recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      ageMs: 180_000,
      queueDepth: 1,
    });

    await expect(Promise.race([queued, delay(100)])).resolves.toBe("blocked");
    expect(getQueueSize(lane)).toBe(2);

    expect(resetCommandLane(lane)).toBe(1);
    await expect(queued).resolves.toBe("drained");
  });

  it("aborts a stale idle embedded run from heartbeat without dropping queued follow-up work", async () => {
    vi.useFakeTimers();

    const sessionKey = "agent:main:idle-embedded-runtime-proof";
    const sessionId = "idle-embedded-runtime-proof-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);
    const events: DiagnosticEventPayload[] = [];
    const queuedMessages: string[] = [];
    let aborts = 0;
    let releaseActiveLane: (() => void) | undefined;

    const activeLaneTask = enqueueCommandInLane(
      lane,
      () =>
        new Promise<void>((resolve) => {
          releaseActiveLane = resolve;
        }),
      { warnAfterMs: Number.MAX_SAFE_INTEGER },
    );
    const queuedLaneTask = enqueueCommandInLane(
      lane,
      async () => {
        logSessionStateChange({
          sessionId,
          sessionKey,
          state: "processing",
          reason: "queued_followup_started",
        });
        logSessionStateChange({
          sessionId,
          sessionKey,
          state: "idle",
          reason: "queued_followup_completed",
        });
        return "follow-up-drained";
      },
      { warnAfterMs: Number.MAX_SAFE_INTEGER },
    );
    activeLaneTask.catch(() => {});
    queuedLaneTask.catch(() => {});

    const handle: EmbeddedPiQueueHandle = {
      queueMessage: async (text) => {
        queuedMessages.push(text);
      },
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {
        aborts += 1;
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      },
    };

    const unsubscribe = onDiagnosticEvent((event) => {
      events.push(event);
    });

    try {
      startDiagnosticHeartbeat(
        {
          diagnostics: {
            enabled: true,
            stuckSessionWarnMs: 30_000,
            stuckSessionAbortMs: 60_000,
          },
        },
        {
          emitMemorySample: () => ({
            rssBytes: 1,
            heapTotalBytes: 1,
            heapUsedBytes: 1,
            externalBytes: 0,
            arrayBuffersBytes: 0,
          }),
          sampleLiveness: () => null,
        },
      );
      setActiveEmbeddedRun(sessionId, handle, sessionKey);
      markDiagnosticRunProgressForTest({
        sessionId,
        sessionKey,
        reason: "codex_app_server:notification:item/completed",
      });
      logSessionStateChange({
        sessionId,
        sessionKey,
        state: "idle",
        reason: "run_completed_without_clear",
      });

      await vi.advanceTimersByTimeAsync(59_000);
      const queueOutcome = await queueEmbeddedPiMessageWithOutcomeAsync(
        sessionId,
        "queued follow-up",
        { steeringMode: "all" },
      );
      expect(queueOutcome).toMatchObject({
        queued: true,
        sessionId,
        target: "embedded_run",
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      unsubscribe();
    }

    expect(queuedMessages).toStrictEqual(["queued follow-up"]);
    expect(aborts).toBe(1);
    expect(isEmbeddedPiRunActive(sessionId)).toBe(false);
    expect(getDiagnosticSessionState({ sessionId, sessionKey }).queueDepth).toBe(1);
    expect(getQueueSize(lane)).toBe(2);

    requireMatchingEvent(
      events,
      {
        type: "session.stalled",
        sessionId,
        sessionKey,
        state: "idle",
        classification: "stalled_agent_run",
        reason: "active_work_without_progress",
        activeWorkKind: "embedded_run",
        queueDepth: 1,
      },
      "idle embedded-run stalled event",
    );
    requireMatchingEvent(
      events,
      {
        type: "session.recovery.requested",
        sessionId,
        sessionKey,
        state: "idle",
        activeWorkKind: "embedded_run",
        allowActiveAbort: true,
        queueDepth: 1,
      },
      "idle embedded-run recovery request",
    );
    requireMatchingEvent(
      events,
      {
        type: "session.recovery.completed",
        sessionId,
        sessionKey,
        state: "idle",
        status: "aborted",
        action: "abort_embedded_run",
        activeWorkKind: "embedded_run",
        queueDepth: 1,
      },
      "idle embedded-run recovery completion",
    );

    releaseActiveLane?.();
    await expect(activeLaneTask).resolves.toBeUndefined();
    await expect(queuedLaneTask).resolves.toBe("follow-up-drained");
    expect(getQueueSize(lane)).toBe(0);
    expect(getDiagnosticSessionState({ sessionId, sessionKey }).queueDepth).toBe(0);
  });

  it("does not leave phantom diagnostic queueDepth for handle-only queued steering", async () => {
    vi.useFakeTimers();

    const sessionKey = "agent:main:idle-embedded-handle-only";
    const sessionId = "idle-embedded-handle-only-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);
    const events: DiagnosticEventPayload[] = [];
    const queuedMessages: string[] = [];
    let aborts = 0;

    const handle: EmbeddedPiQueueHandle = {
      queueMessage: async (text) => {
        queuedMessages.push(text);
      },
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {
        aborts += 1;
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      },
    };

    const unsubscribe = onDiagnosticEvent((event) => {
      events.push(event);
    });

    try {
      startDiagnosticHeartbeat(
        {
          diagnostics: {
            enabled: true,
            stuckSessionWarnMs: 30_000,
            stuckSessionAbortMs: 60_000,
          },
        },
        {
          emitMemorySample: () => ({
            rssBytes: 1,
            heapTotalBytes: 1,
            heapUsedBytes: 1,
            externalBytes: 0,
            arrayBuffersBytes: 0,
          }),
          sampleLiveness: () => null,
        },
      );
      setActiveEmbeddedRun(sessionId, handle, sessionKey);
      markDiagnosticRunProgressForTest({
        sessionId,
        sessionKey,
        reason: "codex_app_server:notification:item/completed",
      });
      logSessionStateChange({
        sessionId,
        sessionKey,
        state: "idle",
        reason: "run_completed_without_clear",
      });

      await vi.advanceTimersByTimeAsync(59_000);
      const queueOutcome = await queueEmbeddedPiMessageWithOutcomeAsync(
        sessionId,
        "handle-only follow-up",
        { steeringMode: "all" },
      );
      expect(queueOutcome).toMatchObject({
        queued: true,
        sessionId,
        target: "embedded_run",
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      unsubscribe();
    }

    expect(queuedMessages).toStrictEqual(["handle-only follow-up"]);
    expect(aborts).toBe(1);
    expect(isEmbeddedPiRunActive(sessionId)).toBe(false);
    expect(getQueueSize(lane)).toBe(0);
    expect(getDiagnosticSessionState({ sessionId, sessionKey }).queueDepth).toBe(0);

    requireMatchingEvent(
      events,
      {
        type: "session.recovery.completed",
        sessionId,
        sessionKey,
        state: "idle",
        status: "aborted",
        action: "abort_embedded_run",
        activeWorkKind: "embedded_run",
        queueDepth: 1,
      },
      "handle-only idle embedded-run recovery completion",
    );
    requireMatchingEvent(
      events,
      {
        type: "session.state",
        sessionId,
        sessionKey,
        state: "idle",
        reason: "stuck_recovery:aborted",
        queueDepth: 0,
      },
      "handle-only idle embedded-run state clear",
    );
  });
});
