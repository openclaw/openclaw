// Stuck session recovery integration tests cover end-to-end recovery diagnostics.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import type { EmbeddedAgentQueueHandle } from "../agents/embedded-agent-runner/run-state.js";
import {
  testing as embeddedRunTesting,
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { FailoverError } from "../agents/failover-error.js";
import { runWithModelFallback } from "../agents/model-fallback.js";
import { makeModelFallbackCfg } from "../agents/test-helpers/model-fallback-config-fixture.js";
import {
  testing as replyRunTesting,
  createReplyOperation,
} from "../auto-reply/reply/reply-run-registry.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  getQueueSize,
  resetCommandLane,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import {
  testing as recoveryTesting,
  recoverStuckDiagnosticSession,
} from "./diagnostic-stuck-session-recovery.runtime.js";

function delay(ms: number): Promise<"blocked"> {
  return new Promise((resolve) => {
    setTimeout(() => resolve("blocked"), ms);
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("stuck session recovery integration", () => {
  afterEach(() => {
    recoveryTesting.resetRecoveriesInFlight();
    embeddedRunTesting.resetActiveEmbeddedRuns();
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
    await expect(Promise.race([queued, delay(100)])).resolves.toBe("drained");
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
    await expect(Promise.race([third, delay(100)])).resolves.toBe("blocked");
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

    await expect(Promise.race([queued, delay(100)])).resolves.toBe("blocked");
    expect(getQueueSize(lane)).toBe(2);

    expect(resetCommandLane(lane)).toBe(1);
    await expect(queued).resolves.toBe("drained");
  });

  it("keeps queued turns behind a reply that continues through model fallback", async () => {
    const sessionKey = `agent:main:stuck-lane-${Date.now()}`;
    const sessionId = `session-stuck-lane-${Date.now()}`;
    const lane = resolveEmbeddedSessionLane(sessionKey);
    setCommandLaneConcurrency(lane, 1);

    const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    operation.setPhase("running");

    const primaryStarted = deferred();
    const primaryCancelled = deferred();
    const fallbackStarted = deferred();
    const finishFallback = deferred();
    const events: string[] = [];

    const primaryBackend = {
      kind: "embedded" as const,
      cancel: vi.fn((reason?: string) => {
        events.push(`primary-cancel:${reason ?? "unknown"}`);
        operation.detachBackend(primaryBackend);
        clearActiveEmbeddedRun(sessionId, primaryHandle, sessionKey, undefined, "stuck_recovery");
        primaryCancelled.resolve();
      }),
      isStreaming: () => true,
    };
    const primaryHandle: EmbeddedAgentQueueHandle = {
      queueMessage: async () => {},
      isStreaming: primaryBackend.isStreaming,
      isCompacting: () => false,
      cancel: primaryBackend.cancel,
      abort: primaryBackend.cancel,
    };
    operation.attachBackend(primaryBackend);
    setActiveEmbeddedRun(sessionId, primaryHandle, sessionKey);

    const fallbackBackend = {
      kind: "embedded" as const,
      cancel: vi.fn(),
      isStreaming: () => true,
    };
    const fallbackHandle: EmbeddedAgentQueueHandle = {
      queueMessage: async () => {},
      isStreaming: fallbackBackend.isStreaming,
      isCompacting: () => false,
      cancel: fallbackBackend.cancel,
      abort: fallbackBackend.cancel,
    };

    const run = vi.fn(async (provider: string, model: string) => {
      if (provider === "probe" && model === "primary") {
        primaryStarted.resolve();
        await primaryCancelled.promise;
        throw new FailoverError("primary model stalled", {
          provider,
          model,
          reason: "timeout",
        });
      }
      operation.attachBackend(fallbackBackend);
      setActiveEmbeddedRun(sessionId, fallbackHandle, sessionKey);
      events.push("fallback-started");
      fallbackStarted.resolve();
      await finishFallback.promise;
      clearActiveEmbeddedRun(sessionId, fallbackHandle, sessionKey);
      operation.detachBackend(fallbackBackend);
      events.push("fallback-completed");
      return "fallback ok";
    });

    const activeReply = enqueueCommandInLane(lane, async () => {
      try {
        const result = await runWithModelFallback({
          cfg: makeModelFallbackCfg({
            agents: {
              defaults: {
                model: {
                  primary: "probe/primary",
                  fallbacks: ["probe/fallback"],
                },
              },
            },
          }),
          provider: "probe",
          model: "primary",
          abortSignal: operation.abortSignal,
          run,
        });
        return result.result;
      } finally {
        operation.complete();
      }
    });

    await primaryStarted.promise;
    const queuedTurn = enqueueCommandInLane(lane, async () => {
      events.push("queued-turn-started");
      return "queued ok";
    });
    expect(getCommandLaneSnapshot(lane)).toMatchObject({ activeCount: 1, queuedCount: 1 });

    let queuedStartedBeforeFallbackCompleted = false;
    let recoveryReleased = -1;
    try {
      const recovery = await recoverStuckDiagnosticSession({
        sessionId,
        sessionKey,
        ageMs: 180_000,
        queueDepth: 1,
        allowActiveAbort: true,
      });
      recoveryReleased = recovery && "released" in recovery ? recovery.released : 0;
      await fallbackStarted.promise;
      queuedStartedBeforeFallbackCompleted = events.includes("queued-turn-started");
    } finally {
      finishFallback.resolve();
    }

    await expect(activeReply).resolves.toBe("fallback ok");
    await expect(queuedTurn).resolves.toBe("queued ok");
    expect(recoveryReleased).toBe(0);
    expect(queuedStartedBeforeFallbackCompleted).toBe(false);
    expect(events.indexOf("queued-turn-started")).toBeGreaterThan(
      events.indexOf("fallback-completed"),
    );
  });
});
