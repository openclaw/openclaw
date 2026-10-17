import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../agents/embedded-agent-runner/runs.test-support.js";
import {
  createReplyOperation,
  runAfterReplyOperationClear,
} from "../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../auto-reply/reply/reply-run-registry.test-support.js";
import {
  onDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { enqueueCommandInLane, getQueueSize, resetCommandLane } from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createDiagnosticRunHandle,
  resetDiagnosticRecoveryState,
  recoverQueuedReply,
} from "./diagnostic-recovery.test-support.js";
import {
  beginDiagnosticBackendActivity,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticArgumentChurnObservation,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
} from "./diagnostic-run-activity.js";
import { markDiagnosticModelStartedForTest } from "./diagnostic-run-activity.test-support.js";
import { logMessageQueuedWithBacklogPolicy } from "./diagnostic-runtime.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";
import { logSessionStateChange, startGatewayDiagnosticHeartbeat } from "./diagnostic.js";
import { resetDiagnosticStateForTest } from "./diagnostic.test-support.js";

function enqueueQuiet<T>(lane: string, task: () => Promise<T>) {
  return enqueueCommandInLane(lane, task, { warnAfterMs: Number.MAX_SAFE_INTEGER });
}

function blockLane(lane: string) {
  const entered = createDeferred();
  const release = createDeferred();
  const active = enqueueQuiet(lane, () => {
    entered.resolve();
    return release.promise;
  });
  return { active, entered, release };
}

function createReplyFixture(name: string) {
  const sessionKey = `agent:main:${name}`;
  const sessionId = `${name}-session`;
  const lane = resolveEmbeddedSessionLane(sessionKey);
  const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  return { sessionKey, sessionId, lane, operation };
}

function startRecoveryHeartbeat(
  abortMs: number,
  config: Parameters<typeof startGatewayDiagnosticHeartbeat>[1] = {
    diagnostics: { enabled: true },
  },
) {
  startGatewayDiagnosticHeartbeat(createTestGatewayScheduler("fake-timers"), config, {
    recoverStuckSession: recoverStuckDiagnosticSession,
    testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: abortMs },
  });
}

function enqueueAbortableReply(lane: string, operation: ReturnType<typeof createReplyOperation>) {
  const entered = createDeferred();
  const active = enqueueQuiet(
    lane,
    () =>
      new Promise<"aborted">((resolve) => {
        entered.resolve();
        const finish = () => {
          operation.complete();
          resolve("aborted");
        };
        if (operation.abortSignal.aborted) {
          finish();
        } else {
          operation.abortSignal.addEventListener("abort", finish, { once: true });
        }
      }),
  );
  return { active, activeStarted: entered.promise };
}

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

afterEach(() => {
  embeddedRunTesting.resetActiveEmbeddedRuns();
  replyRunTesting.resetReplyRunRegistry();
  resetCommandQueueStateForTest();
  resetDiagnosticRecoveryState();
});

it("keeps queued work behind a live backend allowance and recovers once after expiry", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-08-04T03:00:00Z"));
  const sessionKey = "agent:main:backend-allowance";
  const sessionId = "backend-allowance-session";
  const lane = resolveEmbeddedSessionLane(sessionKey);
  const events: DiagnosticEventPayload[] = [];
  const unsubscribe = onDiagnosticEvent((event) => events.push(event));
  startRecoveryHeartbeat(60_000);
  const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  operation.setPhase("running");
  const abort = vi.fn<() => void>();
  const handle = createDiagnosticRunHandle({ sessionKey, sessionId, runId: sessionId }, abort);
  const owner = handle.diagnosticOwner;
  abort.mockImplementation(() => {
    clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    operation.complete();
    release.resolve();
  });
  setActiveEmbeddedRun(sessionId, handle, sessionKey);
  const backend = beginDiagnosticBackendActivity({
    owner,
    noOutputTimeoutMs: 180_000,
    assertCurrent: () => {},
  });
  const { active, entered, release } = blockLane(lane);
  const deliver = vi.fn(async () => "delivered");
  const queued = enqueueQuiet(lane, deliver);
  logMessageQueuedWithBacklogPolicy({ sessionId, sessionKey, source: "test" }, true);
  try {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(120_000);

    // The queued-work entry point must respect the same allowance as heartbeat recovery.
    await expect(
      recoverStuckDiagnosticSession({
        sessionId,
        sessionKey,
        ageMs: 120_000,
        queueDepth: 1,
        staleActiveProgressAbortMs: 60_000,
      }),
    ).resolves.toMatchObject({ status: "skipped" });
    expect(abort).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(getQueueSize(lane)).toBe(2);

    await vi.advanceTimersByTimeAsync(60_000);
    await active;
    await expect(queued).resolves.toBe("delivered");
    await vi.advanceTimersByTimeAsync(30_000);

    expect(abort).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledOnce();
    expect(getQueueSize(lane)).toBe(0);
    expect(events.filter((event) => event.type === "session.recovery.requested")).toHaveLength(1);
    expect(
      getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey })
        .activeBackendLivenessDeadlineAtMs,
    ).toBeUndefined();
  } finally {
    backend.close();
    clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    operation.complete();
    release.resolve();
    await Promise.allSettled([active, queued]);
    unsubscribe();
    resetDiagnosticStateForTest();
    vi.useRealTimers();
  }
});

it("gives a long request one bounded retry window before recovering queued delivery once", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-08-04T03:00:00Z"));
  const { sessionKey, sessionId, lane, operation } = createReplyFixture("repeated-requests");
  operation.setPhase("running");
  const { active, activeStarted } = enqueueAbortableReply(lane, operation);
  let deliveries = 0;
  const queued = enqueueQuiet(lane, async () => {
    deliveries += 1;
    return "delivered";
  });
  await activeStarted;

  const events: DiagnosticEventPayload[] = [];
  const unsubscribe = onDiagnosticEvent((event) => events.push(event));
  startRecoveryHeartbeat(90_000);
  logSessionStateChange({ sessionId, sessionKey, state: "processing" });
  markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey, runId: sessionId });
  markDiagnosticModelStartedForTest({
    sessionId,
    sessionKey,
    runId: sessionId,
    provider: "mock",
    model: "repeated-request-model",
    observationUnit: "request",
  });
  // A long first response can exhaust its output limit before the corrective retry starts.
  for (let chunk = 0; chunk < 32; chunk += 1) {
    markDiagnosticRunProgress({ sessionId, sessionKey, reason: "model_call:stream_progress" });
    await vi.advanceTimersByTimeAsync(30_000);
  }
  expect(events.filter((event) => event.type === "session.recovery.requested")).toHaveLength(0);
  for (let attempt = 2; attempt <= 4; attempt += 1) {
    markDiagnosticModelStartedForTest({
      sessionId,
      sessionKey,
      runId: sessionId,
      provider: "mock",
      model: "repeated-request-model",
      observationUnit: "request",
    });
    expect(events.filter((event) => event.type === "session.recovery.requested")).toHaveLength(0);
    expect(deliveries).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
  }
  await Promise.resolve();

  await expect(active).resolves.toBe("aborted");
  await expect(queued).resolves.toBe("delivered");
  await vi.advanceTimersByTimeAsync(1);
  expect(deliveries).toBe(1);
  expect(getQueueSize(lane)).toBe(0);
  expect(events.filter((event) => event.type === "session.recovery.requested")).toHaveLength(1);
  expect(events.find((event) => event.type === "session.recovery.completed")).toMatchObject({
    status: "aborted",
    action: "abort_embedded_run",
  });
  unsubscribe();
});

it.each(["preflight_compacting", "memory_flushing"] as const)(
  "keeps real queued turns behind healthy %s work",
  async (phase) => {
    const sessionKey = `agent:main:healthy-${phase}`;
    const sessionId = `healthy-${phase}-session`;
    const lane = resolveEmbeddedSessionLane(sessionKey);
    const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    operation.setPhase(phase);
    const handle = {
      queueMessage: async () => {},
      isStreaming: () => false,
      isCompacting: () => phase === "preflight_compacting",
      abort: () => {},
    };
    setActiveEmbeddedRun(sessionId, handle, sessionKey);

    const { active, entered, release } = blockLane(lane);
    const queued = enqueueQuiet(lane, async () => "delivered");
    await entered.promise;
    operation.abortSignal.addEventListener(
      "abort",
      () => {
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
        operation.complete();
        release.resolve();
      },
      { once: true },
    );

    try {
      const outcome = await recoverStuckDiagnosticSession({
        sessionId,
        sessionKey,
        ageMs: 720_000,
        queueDepth: 1,
        compactionSafetyTimeoutMs: 900_000,
        allowActiveAbort: true,
      });

      expect(operation.abortSignal.aborted).toBe(false);
      expect(outcome.status).toBe("skipped");
      await expectPendingAfterEventLoopTurn(queued);
      expect(getQueueSize(lane)).toBe(2);
    } finally {
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      operation.complete();
      release.resolve();
      await active;
      await queued;
    }
  },
);

it.each([true, false])(
  "keeps a blocked lane while registered=%s work is active",
  async (registered) => {
    const sessionKey = registered ? "agent:main:active-reply" : "agent:main:unregistered-work";
    const sessionId = registered ? "active-reply-session" : "unregistered-work-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);
    void enqueueQuiet(lane, () => new Promise<never>(() => {}));
    const queued = enqueueQuiet(lane, async () => "drained");
    const operation = registered
      ? createReplyOperation({ sessionKey, sessionId, resetTriggered: false })
      : undefined;
    expect(getQueueSize(lane)).toBe(2);
    await recoverStuckDiagnosticSession({ sessionId, sessionKey, ageMs: 180_000, queueDepth: 1 });
    await expectPendingAfterEventLoopTurn(queued);
    expect(getQueueSize(lane)).toBe(2);
    operation?.complete();
    expect(resetCommandLane(lane)).toBe(1);
    await expect(queued).resolves.toBe("drained");
  },
);

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
  void enqueueQuiet(lane, () => new Promise<never>(() => {}));
  const queued = enqueueQuiet(lane, async () => "drained");

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
  const { sessionKey, sessionId, lane, operation } = createReplyFixture("active-pre-run");
  const { active, activeStarted } = enqueueAbortableReply(lane, operation);
  const queued = enqueueQuiet(lane, async () => "drained");

  expect(getQueueSize(lane)).toBe(2);
  await activeStarted;

  const outcome = await recoverQueuedReply(sessionId, sessionKey);

  await expect(active).resolves.toBe("aborted");
  await expect(queued).resolves.toBe("drained");
  expect(outcome.status).toBe("aborted");
  expect(getQueueSize(lane)).toBe(0);
});

it.each(["abortByUser", "supersede"] as const)(
  "protects queued preflight until intentional %s cancellation",
  async (cancel) => {
    const { sessionKey, sessionId, lane, operation } = createReplyFixture("active-preflight");
    operation.setPhase("preflight_compacting");
    const { active, activeStarted } = enqueueAbortableReply(lane, operation);
    const queued = enqueueQuiet(lane, async () => "drained");
    await activeStarted;

    const outcome = await recoverQueuedReply(sessionId, sessionKey, {
      // Session age must not stand in for time spent in preflight.
      ageMs: 30 * 60_000,
      compactionSafetyTimeoutMs: 10 * 60_000,
    });

    expect(outcome).toMatchObject({
      status: "skipped",
      action: "keep_lane",
      reason: "active_reply_work",
      activeSessionId: sessionId,
    });
    expect(operation.abortSignal.aborted).toBe(false);
    await expectPendingAfterEventLoopTurn(active);
    await expectPendingAfterEventLoopTurn(queued);
    expect(getQueueSize(lane)).toBe(2);

    // Intentional cancellation remains owned by the reply operation.
    expect(operation[cancel]()).toBe(true);
    if (cancel === "supersede") {
      expect(operation.abortSignal.aborted).toBe(true);
      expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_supersession" });
    }
    await expect(active).resolves.toBe("aborted");
    await expect(queued).resolves.toBe("drained");
  },
);

it("keeps fresh preflight compaction through the queued-session heartbeat watchdog", async () => {
  vi.useFakeTimers();
  const events: DiagnosticEventPayload[] = [];
  const unsubscribe = onDiagnosticEvent((event) => events.push(event));
  try {
    const sessionKey = "agent:main:heartbeat-preflight";
    const sessionId = "heartbeat-preflight-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);
    const startMs = Date.parse("2026-08-18T12:00:00Z");
    vi.setSystemTime(startMs);
    setDiagnosticsEnabledForProcess(true);
    logSessionStateChange({ sessionId, sessionKey, state: "processing" });
    logMessageQueuedWithBacklogPolicy({ sessionId, sessionKey, source: "test" }, true);
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey });

    // The diagnostic owner is old, but preflight starts only now.
    vi.setSystemTime(startMs + 12 * 60_000);
    const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    operation.setPhase("preflight_compacting");
    const { active, activeStarted } = enqueueAbortableReply(lane, operation);
    const queued = enqueueQuiet(lane, async () => "drained");
    await activeStarted;

    startRecoveryHeartbeat(90_000, {
      diagnostics: { enabled: true },
      agents: { defaults: { compaction: { timeoutSeconds: 600 } } },
    });
    await vi.advanceTimersByTimeAsync(90_000);
    await Promise.resolve();

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.recovery.requested",
        sessionId,
        sessionKey,
        queueDepth: 1,
        allowActiveAbort: true,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.recovery.completed",
        sessionId,
        sessionKey,
        status: "skipped",
        action: "keep_lane",
        outcomeReason: "active_reply_work",
      }),
    );
    expect(operation.abortSignal.aborted).toBe(false);
    expect(getQueueSize(lane)).toBe(2);

    // Restart remains an intentional, immediate cancellation source.
    expect(operation.abortForRestart()).toBe(true);
    await expect(active).resolves.toBe("aborted");
    await expect(queued).resolves.toBe("drained");
  } finally {
    unsubscribe();
    resetDiagnosticStateForTest();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  }
});

it("keeps queued lane work behind reply-only force-clear settlement", async () => {
  vi.useFakeTimers();
  try {
    const { sessionKey, sessionId, lane, operation } = createReplyFixture("reply-only-force-clear");
    operation.attachBackend({
      kind: "embedded",
      cancel: () => {},
      isStreaming: () => true,
    });
    operation.setPhase("running");
    let ownerCleared = false;
    runAfterReplyOperationClear(operation, () => {
      ownerCleared = true;
    });

    void enqueueQuiet(lane, () => new Promise<never>(() => {}));
    const queued = enqueueQuiet(lane, async () => {
      expect(ownerCleared).toBe(true);
      return "drained";
    });

    const recovery = recoverQueuedReply(sessionId, sessionKey);
    // The shared deadline can leave the owner-settlement clamp's final 100 ms.
    await vi.advanceTimersByTimeAsync(15_100);

    await expect(recovery).resolves.toMatchObject({
      status: "aborted",
      action: "abort_embedded_run",
      aborted: false,
      drained: false,
      forceCleared: true,
    });
    await expect(queued).resolves.toBe("drained");
    expect(ownerCleared).toBe(true);
    expect(getQueueSize(lane)).toBe(0);
  } finally {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  }
});

it("leaves committed reply finalization to its existing lease before releasing queued work", async () => {
  vi.useFakeTimers();
  const { sessionKey, sessionId, lane, operation } = createReplyFixture("committed-finalization");
  operation.setPhase("running");
  let ownerCleared = false;
  runAfterReplyOperationClear(operation, () => {
    ownerCleared = true;
  });
  const { active, entered, release } = blockLane(lane);
  operation.abortSignal.addEventListener("abort", () => release.resolve(), { once: true });
  const deliver = vi.fn(async () => {
    expect(ownerCleared).toBe(true);
    return "delivered";
  });
  const queued = enqueueQuiet(lane, deliver);
  try {
    await entered.promise;
    operation.freezeAbort();

    await expect(recoverQueuedReply(sessionId, sessionKey)).resolves.toMatchObject({
      status: "skipped",
      action: "keep_lane",
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(operation.result).toBeNull();
    expect(operation.abortSignal.aborted).toBe(false);
    expect(deliver).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await active;
    await expect(queued).resolves.toBe("delivered");
    expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(operation.staleExpiryReason).toBe("finalization_stalled");
    expect(deliver).toHaveBeenCalledOnce();
  } finally {
    operation.complete();
    release.resolve();
    await Promise.allSettled([active, queued]);
    vi.useRealTimers();
  }
});

it("reclaims continuous argument churn after its semantic progress clock becomes stale", async () => {
  const { sessionKey, sessionId, lane, operation } = createReplyFixture("argument-churn");
  const { active, activeStarted } = enqueueAbortableReply(lane, operation);
  const queued = enqueueQuiet(lane, async () => "drained");
  await activeStarted;

  const proofNow = Date.now();
  vi.useFakeTimers();
  vi.setSystemTime(proofNow - 6 * 60_000);
  markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey });
  markDiagnosticArgumentChurnObservation({
    sessionId,
    sessionKey,
    runId: sessionId,
    active: true,
  });
  for (let step = 1; step <= 12; step += 1) {
    vi.setSystemTime(proofNow - 6 * 60_000 + step * 30_000);
    markDiagnosticRunProgress({
      sessionId,
      sessionKey,
      runId: sessionId,
      reason: "model_call:stream_progress",
    });
    markDiagnosticArgumentChurnObservation({
      sessionId,
      sessionKey,
      runId: sessionId,
      active: true,
    });
  }
  vi.useRealTimers();
  expect(getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey })).toMatchObject({
    activeWorkKind: "embedded_run",
    lastProgressReason: "tool_loop:argument_churn",
  });

  const outcome = await recoverStuckDiagnosticSession({
    sessionId,
    sessionKey,
    ageMs: 6 * 60_000,
    queueDepth: 1,
    staleActiveProgressAbortMs: 5 * 60_000,
  });

  await expect(active).resolves.toBe("aborted");
  await expect(queued).resolves.toBe("drained");
  expect(outcome).toMatchObject({ status: "aborted", action: "abort_embedded_run" });
  expect(getQueueSize(lane)).toBe(0);
});

it("releases a wedged lane after a clean abort when session work remains queued (#91700)", async () => {
  const { sessionKey, sessionId, lane, operation } = createReplyFixture("wedged-delivery");
  operation.setPhase("running");
  // Cancel settles the registry (clean abort+drain) while the lane task that
  // hosted the run stays wedged, mirroring a hang past the run's own cleanup.
  operation.attachBackend({
    kind: "embedded",
    cancel: () => queueMicrotask(() => operation.complete()),
    isStreaming: () => false,
  });
  void enqueueQuiet(lane, () => new Promise<never>(() => {}));
  expect(getQueueSize(lane)).toBe(1);

  const outcome = await recoverQueuedReply(sessionId, sessionKey);

  expect(outcome).toMatchObject({
    status: "aborted",
    action: "abort_embedded_run",
    aborted: true,
    drained: true,
    forceCleared: false,
    released: 1,
  });
  const queued = enqueueQuiet(lane, async () => "drained");
  await expect(queued).resolves.toBe("drained");
});

it("does not reset a lane that unwedged and started a queued turn during the abort (#91700)", async () => {
  const { sessionKey, sessionId, lane, operation } = createReplyFixture("unwedged-during-abort");
  operation.setPhase("running");
  let markHostStarted!: () => void;
  const hostStarted = new Promise<void>((resolve) => {
    markHostStarted = resolve;
  });
  // Host task frees the lane on abort; the queued turn then pumps to active
  // and only it settles the registry, so the drain resolves with fresh work
  // already running — the race the queueDepth reset must not clobber.
  const host = enqueueQuiet(
    lane,
    () =>
      new Promise<"aborted">((resolve) => {
        markHostStarted();
        operation.abortSignal.addEventListener("abort", () => resolve("aborted"), {
          once: true,
        });
      }),
  );
  let releaseFreshTurn!: (value: "done") => void;
  const freshTurn = enqueueQuiet(lane, () => {
    operation.complete();
    return new Promise<"done">((resolve) => {
      releaseFreshTurn = resolve;
    });
  });
  await hostStarted;

  const outcome = await recoverQueuedReply(sessionId, sessionKey);

  await expect(host).resolves.toBe("aborted");
  expect(outcome).toMatchObject({
    status: "aborted",
    aborted: true,
    drained: true,
    released: 0,
  });
  // The fresh turn still owns the lane slot: later work must wait for it.
  const third = enqueueQuiet(lane, async () => "third");
  await expectPendingAfterEventLoopTurn(third);
  expect(getQueueSize(lane)).toBe(2);
  releaseFreshTurn("done");
  await expect(freshTurn).resolves.toBe("done");
  await expect(third).resolves.toBe("third");
});
