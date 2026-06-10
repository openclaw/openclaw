// Stuck session recovery integration tests cover end-to-end recovery diagnostics.
import { afterEach, describe, expect, it } from "vitest";
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import {
  testing as embeddedRunTesting,
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunHandleActive,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import {
  testing as replyRunTesting,
  createReplyOperation,
} from "../auto-reply/reply/reply-run-registry.js";
import {
  enqueueCommandInLane,
  getQueueSize,
  resetCommandLane,
  resetCommandQueueStateForTest,
} from "../process/command-queue.js";
import { markDiagnosticEmbeddedRunStarted } from "./diagnostic-run-activity.js";
import {
  testing as recoveryTesting,
  recoverStuckDiagnosticSession,
} from "./diagnostic-stuck-session-recovery.runtime.js";
import { logSessionStateChange, resetDiagnosticStateForTest } from "./diagnostic.js";

function delay(ms: number): Promise<"blocked"> {
  return new Promise((resolve) => {
    setTimeout(() => resolve("blocked"), ms);
  });
}

describe("stuck session recovery integration", () => {
  afterEach(() => {
    recoveryTesting.resetRecoveriesInFlight();
    embeddedRunTesting.resetActiveEmbeddedRuns();
    resetDiagnosticStateForTest();
    replyRunTesting.resetReplyRunRegistry();
    resetCommandQueueStateForTest();
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

  it("does not reset sibling-key lane work while the same session file has an active embedded run", async () => {
    const activeSessionKey = "agent:main:visible";
    const fallbackSessionKey = "agent:main:fallback";
    const activeSessionId = "active-session-file-run";
    const fallbackSessionId = "fallback-session-file-run";
    const sessionFile = "/tmp/openclaw-diagnostic-shared-session.jsonl";
    const lane = resolveEmbeddedSessionLane(fallbackSessionKey);
    const handle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    };

    setActiveEmbeddedRun(activeSessionId, handle, activeSessionKey, sessionFile);
    void enqueueCommandInLane(lane, () => new Promise<never>(() => {}), {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    const queued = enqueueCommandInLane(lane, async () => "drained", {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: fallbackSessionId,
      sessionKey: fallbackSessionKey,
      sessionFile,
      ageMs: 180_000,
      queueDepth: 1,
    });

    expect(outcome).toMatchObject({
      status: "skipped",
      action: "observe_only",
      reason: "active_embedded_run",
      activeSessionId,
    });
    await expect(Promise.race([queued, delay(100)])).resolves.toBe("blocked");
    expect(getQueueSize(lane)).toBe(2);

    clearActiveEmbeddedRun(activeSessionId, handle, activeSessionKey, sessionFile);
    expect(resetCommandLane(lane)).toBe(1);
    await expect(queued).resolves.toBe("drained");
  });

  it("aborts registered pre-run lane work and drains queued messages", async () => {
    const sessionKey = "agent:main:active-pre-run";
    const sessionId = "active-pre-run-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);
    const operation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    let markActiveStarted!: () => void;
    const activeStarted = new Promise<void>((resolve) => {
      markActiveStarted = resolve;
    });

    const active = enqueueCommandInLane(
      lane,
      () =>
        new Promise<"aborted">((resolve) => {
          markActiveStarted();
          if (operation.abortSignal.aborted) {
            resolve("aborted");
            return;
          }
          operation.abortSignal.addEventListener("abort", () => resolve("aborted"), { once: true });
        }),
      { warnAfterMs: Number.MAX_SAFE_INTEGER },
    );
    const queued = enqueueCommandInLane(lane, async () => "drained", {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });

    expect(getQueueSize(lane)).toBe(2);
    await activeStarted;

    const outcome = await recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      ageMs: 720_000,
      queueDepth: 1,
      allowActiveAbort: true,
    });

    await expect(active).resolves.toBe("aborted");
    await expect(queued).resolves.toBe("drained");
    expect(outcome.status).toBe("aborted");
    expect(getQueueSize(lane)).toBe(0);
  });

  it("force-clears a zombie ACTIVE_EMBEDDED_RUNS entry when recovery runs with allowActiveAbort on an idle session", async () => {
    const sessionKey = "agent:main:zombie-idle";
    const sessionId = "zombie-idle-session";
    let selfCleared = false;
    const handle = {
      queueMessage: async () => {},
      isStreaming: () => false,
      isCompacting: () => false,
      abort: () => {
        // Simulate the run's abort handler completing and self-clearing
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
        selfCleared = true;
      },
    };

    // Zombie: run registered but never cleared (handle mismatch scenario)
    logSessionStateChange({ sessionId, sessionKey, state: "processing", reason: "run_started" });
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey });
    setActiveEmbeddedRun(sessionId, handle, sessionKey);
    // Dispatcher marks the session idle (clearActiveEmbeddedRun was skipped)
    logSessionStateChange({ sessionId, sessionKey, state: "idle", reason: "message_completed" });

    expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(true);

    const outcome = await recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      ageMs: 420_000,
      queueDepth: 0,
      allowActiveAbort: true,
      expectedState: "idle",
    });

    expect(outcome.status).toBe("aborted");
    expect(selfCleared).toBe(true);
    expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(false);
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
});
