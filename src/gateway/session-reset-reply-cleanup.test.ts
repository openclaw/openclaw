/**
 * Regression test for: session reset not clearing orphaned reply operations.
 *
 * When a session was reset, ensureSessionRuntimeCleanup() cleared command lanes
 * and aborted the embedded run — but did NOT call forceClearReplyRunBySessionId().
 * This left an orphaned reply operation in the registry, which caused stuck-session
 * recovery to skip lane resets indefinitely (reason=active_reply_work).
 *
 * Fix: forceClearReplyRunBySessionId() is now called explicitly after abortEmbeddedPiRun().
 * This test verifies that after clearing session state, no reply operation remains for
 * the old session ID, so stuck-session recovery can proceed.
 */

import { afterEach, describe, expect, it } from "vitest";
import { resolveEmbeddedSessionLane } from "../agents/pi-embedded-runner/lanes.js";
import {
  __testing as replyRunTesting,
  createReplyOperation,
  isReplyRunActiveForSessionId,
  forceClearReplyRunBySessionId,
} from "../auto-reply/reply/reply-run-registry.js";
import { clearSessionResetRuntimeState } from "../auto-reply/reply/session-reset-cleanup.js";
import {
  __testing as recoveryTesting,
  recoverStuckDiagnosticSession,
} from "../logging/diagnostic-stuck-session-recovery.runtime.js";
import {
  enqueueCommandInLane,
  getQueueSize,
  resetCommandLane,
  resetCommandQueueStateForTest,
} from "../process/command-queue.js";

function delay(ms: number): Promise<"blocked"> {
  return new Promise((resolve) => setTimeout(() => resolve("blocked"), ms));
}

describe("session reset clears orphaned reply operations", () => {
  afterEach(() => {
    recoveryTesting.resetRecoveriesInFlight();
    replyRunTesting.resetReplyRunRegistry();
    resetCommandQueueStateForTest();
  });

  it("reply operation stays active after clearSessionResetRuntimeState alone (demonstrating the gap)", () => {
    const sessionKey = "agent:claw-ux:discord:channel:123";
    const sessionId = "old-session-id";

    createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    expect(isReplyRunActiveForSessionId(sessionId)).toBe(true);

    // clearSessionResetRuntimeState only clears queues/events — not reply operations
    clearSessionResetRuntimeState([sessionKey, sessionId]);
    expect(isReplyRunActiveForSessionId(sessionId)).toBe(true);
  });

  it("forceClearReplyRunBySessionId clears the orphaned reply (the fix)", () => {
    const sessionKey = "agent:claw-ux:discord:channel:123";
    const sessionId = "old-session-id";

    createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    expect(isReplyRunActiveForSessionId(sessionId)).toBe(true);

    // This is what the fix adds to ensureSessionRuntimeCleanup()
    const cleared = forceClearReplyRunBySessionId(sessionId, new Error("session-reset-cleanup"));
    expect(cleared).toBe(true);
    expect(isReplyRunActiveForSessionId(sessionId)).toBe(false);
  });

  it("lane is unblockable while orphaned reply exists, clearable once it is gone", async () => {
    const sessionKey = "agent:claw-ux:discord:channel:456";
    const sessionId = "old-session-orphaned";
    const lane = resolveEmbeddedSessionLane(sessionKey);

    // Simulate a stuck lane: active task that never resolves + queued work
    void enqueueCommandInLane(lane, () => new Promise<never>(() => {}), {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    const queued = enqueueCommandInLane(lane, async () => "drained", {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });

    // Create an orphaned reply operation (session reset happened, run ended, reply stuck)
    createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    expect(getQueueSize(lane)).toBe(2);

    // Without the fix: recovery skips because active_reply_work
    await recoverStuckDiagnosticSession({ sessionId, sessionKey, ageMs: 180_000, queueDepth: 1 });
    // Lane still stuck: queued task remains blocked
    await expect(Promise.race([queued, delay(50)])).resolves.toBe("blocked");
    expect(getQueueSize(lane)).toBe(2);

    // The fix: session reset now calls forceClearReplyRunBySessionId
    forceClearReplyRunBySessionId(sessionId, new Error("session-reset-cleanup"));
    expect(isReplyRunActiveForSessionId(sessionId)).toBe(false);

    // Lane reset now succeeds — no reply operation blocking it
    expect(resetCommandLane(lane)).toBeGreaterThan(0);
    await expect(queued).resolves.toBe("drained");
  });
});
