import { afterEach, describe, expect, it } from "vitest";
import { resolveEmbeddedSessionLane } from "../agents/pi-embedded-runner/lanes.js";
import {
  __testing as replyRunTesting,
  createReplyOperation,
} from "../auto-reply/reply/reply-run-registry.js";
import {
  enqueueCommandInLane,
  getQueueSize,
  resetCommandLane,
  resetCommandQueueStateForTest,
} from "../process/command-queue.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "./diagnostic-session-state.js";
import {
  __testing as recoveryTesting,
  recoverStuckDiagnosticSession,
} from "./diagnostic-stuck-session-recovery.runtime.js";

function delay(ms: number): Promise<"blocked"> {
  return new Promise((resolve) => setTimeout(() => resolve("blocked"), ms));
}

describe("stuck session recovery integration", () => {
  afterEach(() => {
    recoveryTesting.resetRecoveriesInFlight();
    replyRunTesting.resetReplyRunRegistry();
    resetCommandQueueStateForTest();
    resetDiagnosticSessionStateForTest();
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

  it("clears stale diagnostic processing state when no lane work remains", async () => {
    const sessionKey = "agent:main:diagnostic-only";
    const sessionId = "diagnostic-only-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);
    const state = getDiagnosticSessionState({ sessionId, sessionKey });
    state.state = "processing";
    state.queueDepth = 1;
    state.lastStuckWarnAgeMs = 120_000;

    await recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      ageMs: 180_000,
      queueDepth: 1,
    });

    expect(getQueueSize(lane)).toBe(0);
    expect(state.state).toBe("idle");
    expect(state.queueDepth).toBe(0);
    expect(state.lastStuckWarnAgeMs).toBeUndefined();
  });
});
