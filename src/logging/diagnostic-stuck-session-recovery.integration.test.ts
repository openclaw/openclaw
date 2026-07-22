// Stuck session recovery integration tests cover end-to-end recovery diagnostics.
import { afterEach, describe, expect, it } from "vitest";
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../agents/embedded-agent-runner/runs.test-support.js";
import {
  REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS,
  type ReplyOperation,
  createReplyOperation,
} from "../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../auto-reply/reply/reply-run-registry.test-support.js";
import { enqueueCommandInLane, getQueueSize, resetCommandLane } from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { resetDiagnosticRunActivityForTest } from "./diagnostic-run-activity.js";
import {
  testing as recoveryTesting,
  recoverStuckDiagnosticSession,
} from "./diagnostic-stuck-session-recovery.runtime.js";
import {
  requestStuckSessionRecoveryOutcome,
  resetDiagnosticSessionRecoveryCoordinatorForTest,
} from "./diagnostic-session-recovery-coordinator.js";
import type { SessionAttentionClassification } from "./diagnostic-session-attention.js";
import { logSessionStateChange, logMessageQueued } from "./diagnostic.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "./diagnostic-session-state.js";

async function expectPendingAfterEventLoopTurn(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(settled).toBe(false);
}

function delay(ms: number): Promise<"blocked"> {
  return new Promise((resolve) => {
    setTimeout(() => resolve("blocked"), ms);
  });
}

describe("stuck session recovery integration", () => {
  afterEach(() => {
    recoveryTesting.resetRecoveriesInFlight();
    embeddedRunTesting.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    resetCommandQueueStateForTest();
    resetDiagnosticSessionRecoveryCoordinatorForTest();
    resetDiagnosticSessionStateForTest();
    resetDiagnosticRunActivityForTest();
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

    await expectPendingAfterEventLoopTurn(queued);
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
    await expectPendingAfterEventLoopTurn(queued);
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

  it("releases a wedged lane after a clean abort when session work remains queued (#91700)", async () => {
    const sessionKey = "agent:main:wedged-delivery";
    const sessionId = "wedged-delivery-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);
    const operation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    operation.setPhase("running");
    // Cancel settles the registry (clean abort+drain) while the lane task that
    // hosted the run stays wedged, mirroring a hang past the run's own cleanup.
    operation.attachBackend({
      kind: "embedded",
      cancel: () => queueMicrotask(() => operation.complete()),
      isStreaming: () => false,
    });
    void enqueueCommandInLane(lane, () => new Promise<never>(() => {}), {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    expect(getQueueSize(lane)).toBe(1);

    const outcome = await recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      ageMs: 720_000,
      queueDepth: 1,
      allowActiveAbort: true,
    });

    expect(outcome).toMatchObject({
      status: "aborted",
      action: "abort_embedded_run",
      aborted: true,
      drained: true,
      forceCleared: false,
      released: 1,
    });
    const queued = enqueueCommandInLane(lane, async () => "drained", {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    await expect(queued).resolves.toBe("drained");
  });

  it("does not reset a lane that unwedged and started a queued turn during the abort (#91700)", async () => {
    const sessionKey = "agent:main:unwedged-during-abort";
    const sessionId = "unwedged-during-abort-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);
    const operation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    operation.setPhase("running");
    let markHostStarted!: () => void;
    const hostStarted = new Promise<void>((resolve) => {
      markHostStarted = resolve;
    });
    // Host task frees the lane on abort; the queued turn then pumps to active
    // and only it settles the registry, so the drain resolves with fresh work
    // already running — the race the queueDepth reset must not clobber.
    const host = enqueueCommandInLane(
      lane,
      () =>
        new Promise<"aborted">((resolve) => {
          markHostStarted();
          operation.abortSignal.addEventListener("abort", () => resolve("aborted"), {
            once: true,
          });
        }),
      { warnAfterMs: Number.MAX_SAFE_INTEGER },
    );
    let releaseFreshTurn!: (value: "done") => void;
    const freshTurn = enqueueCommandInLane(
      lane,
      () => {
        operation.complete();
        return new Promise<"done">((resolve) => {
          releaseFreshTurn = resolve;
        });
      },
      { warnAfterMs: Number.MAX_SAFE_INTEGER },
    );
    await hostStarted;

    const outcome = await recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      ageMs: 720_000,
      queueDepth: 1,
      allowActiveAbort: true,
    });

    await expect(host).resolves.toBe("aborted");
    expect(outcome).toMatchObject({
      status: "aborted",
      aborted: true,
      drained: true,
      released: 0,
    });
    // The fresh turn still owns the lane slot: later work must wait for it.
    const third = enqueueCommandInLane(lane, async () => "third", {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    await expectPendingAfterEventLoopTurn(third);
    expect(getQueueSize(lane)).toBe(2);
    releaseFreshTurn("done");
    await expect(freshTurn).resolves.toBe("done");
    await expect(third).resolves.toBe("third");
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

    await expectPendingAfterEventLoopTurn(queued);
    expect(getQueueSize(lane)).toBe(2);

    expect(resetCommandLane(lane)).toBe(1);
    await expect(queued).resolves.toBe("drained");
  });

  describe("terminal-phase reclaim (#105712)", () => {
    // Phantom terminal-phase reply operations stay in the registry when:
    // - fail() + retainFailureUntilComplete (failed phase, retained until complete())
    // - abortByUser() on a running operation (aborted phase, 60s settle window)
    // complete() calls clearState() immediately, so "completed" phantoms
    // are never in the registry at recovery time. Only "failed" (with
    // retainFailureUntilComplete) and "aborted" (post-backend abortByUser)
    // remain registered.
    // The recovery sees isEmbeddedAgentRunActive=true via the reply-run registry.
    //
    // E2E reclaim proof: clears diagnostic activity to simulate a stale phantom
    // (no recent progress events). The terminal settle window guard then falls
    // back to params.ageMs (> 60s), allowing the reclaim path to fire.

    async function runReclaimProof(
      label: string,
      setup: (op: ReplyOperation) => void,
    ): Promise<void> {
      const sessionKey = `agent:main:e2e-${label}`;
      const sessionId = `e2e-${label}-session`;
      const lane = resolveEmbeddedSessionLane(sessionKey);
      const operation = createReplyOperation({
        sessionKey,
        sessionId,
        resetTriggered: false,
      });

      setup(operation);

      // Simulate stale diagnostic state: clear activity so the settle window
      // guard falls back to params.ageMs (> 60s → reclaim).
      resetDiagnosticRunActivityForTest();

      // Queue a message that should be delivered after reclaim
      const queued = enqueueCommandInLane(lane, async () => "drained", {
        warnAfterMs: Number.MAX_SAFE_INTEGER,
      });

      const outcome = await recoverStuckDiagnosticSession({
        sessionId,
        sessionKey,
        ageMs: REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS + 1000,
        queueDepth: 1,
      });

      // Type-narrow the discriminated union before accessing variant-only fields
      expect(outcome.status).toBe("aborted");
      expect(outcome.action).toBe("abort_embedded_run");
      if (outcome.status === "aborted") {
        expect(outcome.aborted).toBe(true);
        expect(outcome.drained).toBe(true);
      }

      const result = await Promise.race([
        queued,
        new Promise<string>((r) => {
          setTimeout(() => r("TIMEOUT"), 5000);
        }),
      ]);
      expect(result).toBe("drained");
    }

    it("reclaims a terminal failed phantom (retainFailureUntilComplete) and delivers queued messages", async () => {
      await runReclaimProof("failed", (op) => {
        op.retainFailureUntilComplete();
        op.fail("run_failed", new Error("e2e phantom"));
      });
    });

    it("reclaims a terminal aborted phantom (running → abortByUser) and delivers queued messages", async () => {
      await runReclaimProof("aborted", (op) => {
        op.setPhase("running");
        op.abortByUser();
      });
    });

    it("keeps the lane when a terminal reply operation is still within the settle window", async () => {
      const sessionKey = "agent:main:terminal-settle";
      const sessionId = "terminal-settle-session";
      const lane = resolveEmbeddedSessionLane(sessionKey);
      const operation = createReplyOperation({
        sessionKey,
        sessionId,
        resetTriggered: false,
      });
      // fail with retainFailureUntilComplete keeps the operation in the registry
      operation.retainFailureUntilComplete();
      operation.fail("run_failed", new Error("simulated failure"));

      // Block the lane with an unresponsive task
      void enqueueCommandInLane(lane, () => new Promise<never>(() => {}), {
        warnAfterMs: Number.MAX_SAFE_INTEGER,
      });
      const queued = enqueueCommandInLane(lane, async () => "drained", {
        warnAfterMs: Number.MAX_SAFE_INTEGER,
      });
      expect(getQueueSize(lane)).toBe(2);

      // Session age is well within the 60s settle window → recovery should NOT reclaim
      await recoverStuckDiagnosticSession({
        sessionId,
        sessionKey,
        ageMs: 30_000,
        queueDepth: 1,
      });

      // Lane should still be blocked (settle window not expired)
      await expect(Promise.race([queued, delay(100)])).resolves.toBe("blocked");
      expect(getQueueSize(lane)).toBe(2);
    });
  });

  describe("stuck session recovery coordinator integration", () => {
    const sessionKey = "agent:main:coordinator-test";
    const sessionId = "coordinator-test-session";

    const staleClassification: SessionAttentionClassification = {
      eventType: "session.stuck",
      reason: "stale_session_state",
      classification: "stale_session_state",
      activeWorkKind: "embedded_run",
      recoveryEligible: true,
    };

    it("reclaims a terminal-phase reply operation through the full coordinator pipeline and updates diagnostic state", async () => {
      // 1. Create diagnostic session state: "processing"
      logSessionStateChange({ sessionId, sessionKey, state: "processing" });
      logMessageQueued({ sessionId, sessionKey, source: "test" });

      // 2. Create phantom reply operation (terminal phase)
      const operation = createReplyOperation({
        sessionKey,
        sessionId,
        resetTriggered: false,
      });
      operation.retainFailureUntilComplete();
      operation.fail("run_failed", new Error("coordinator phantom"));

      // Clear diagnostic activity so the terminal settle guard falls back to ageMs
      resetDiagnosticRunActivityForTest();

      // 3. Call through the coordinator with the real runtime function
      const outcome = await requestStuckSessionRecoveryOutcome({
        recover: (params) =>
          recoverStuckDiagnosticSession({
            ...params,
            sessionId,
          }),
        request: {
          sessionId,
          sessionKey,
          ageMs: REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS + 1000,
          queueDepth: 1,
          expectedState: "processing",
        },
        classification: staleClassification,
      });

      // 4. Verify outcome was returned from the runtime+coordinator pipeline
      expect(outcome).toBeDefined();
      expect(outcome?.status).toBe("aborted");
      expect(outcome?.action).toBe("abort_embedded_run");

      // 5. Verify: diagnostic session state was updated to "idle" by the coordinator
      const state = getDiagnosticSessionState({ sessionId, sessionKey });
      expect(state.state).toBe("idle");
    });
  });
});
