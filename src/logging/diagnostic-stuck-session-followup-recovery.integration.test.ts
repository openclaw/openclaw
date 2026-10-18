import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../agents/embedded-agent-runner/runs.test-support.js";
import {
  enqueueFollowupRun,
  type FollowupRun,
  type QueueSettings,
} from "../auto-reply/reply/queue.js";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import { clearFollowupDrainCallback } from "../auto-reply/reply/queue/drain.js";
import { clearFollowupQueue } from "../auto-reply/reply/queue/state.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../auto-reply/reply/reply-run-registry.test-support.js";
import {
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  emitCoreModelRequestEndedDiagnosticEvent,
  emitCoreModelRequestStartedDiagnosticEvent,
} from "../infra/diagnostic-model-request.js";
import { emitCoreSemanticRunProgressDiagnosticEvent } from "../infra/diagnostic-semantic-run-progress.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import {
  createDiagnosticRunHandle,
  resetDiagnosticRecoveryState,
  recoverQueuedReply,
  createQueuedRecoveryHeartbeat,
  diagnosticTimerTypes,
} from "./diagnostic-recovery.test-support.js";
import {
  beginDiagnosticBackendActivity,
  markDiagnosticOwnedToolActivity,
  startDiagnosticRunActivityTracking,
} from "./diagnostic-run-activity.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";
import { stopGatewayDiagnosticHeartbeat } from "./diagnostic.js";

// These queue-only fixtures have no persisted session; force-clear persistence has its own suite.
vi.mock("../agents/embedded-agent-runner/force-clear-session-state.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../agents/embedded-agent-runner/force-clear-session-state.js")
  >()),
  tryLoadForceClearSessionSnapshot: async () => undefined,
}));

const queueKeys = new Set<string>();

function followups(key: string, mode: QueueSettings["mode"] = "followup", blockSecond = false) {
  queueKeys.add(key);
  const calls: string[] = [];
  const first = { entered: createDeferred(), release: createDeferred() };
  const second = { entered: createDeferred(), release: createDeferred() };
  const settings: QueueSettings = { mode, debounceMs: 0, cap: 50 };
  const runFollowup = async (run: FollowupRun) => {
    calls.push(run.prompt);
    const gate =
      calls.length === 1 ? first : blockSecond && calls.length === 2 ? second : undefined;
    if (gate) {
      gate.entered.resolve();
      await gate.release.promise;
    }
  };
  const enqueue = (run: string | FollowupRun) => {
    const item = typeof run === "string" ? createQueueTestRun({ prompt: run }) : run;
    return enqueueFollowupRun(key, item, settings, "none", runFollowup);
  };
  return { calls, enqueue, first, second };
}

function recoverWedgedReply(sessionKey: string, sessionId: string) {
  const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  operation.attachBackend({ kind: "embedded", cancel: () => {}, isStreaming: () => true });
  operation.setPhase("running");
  return recoverQueuedReply(sessionId, sessionKey);
}

afterEach(() => {
  for (const key of queueKeys) {
    clearFollowupQueue(key);
    clearFollowupDrainCallback(key);
  }
  queueKeys.clear();
  embeddedRunTesting.resetActiveEmbeddedRuns();
  replyRunTesting.resetReplyRunRegistry();
  resetCommandQueueStateForTest();
  resetDiagnosticRecoveryState();
});

it.each([
  { allowance: "model request", requestTimeoutMs: 150_000, progress: "none" },
  { allowance: "backend bytes", requestTimeoutMs: undefined, progress: "none" },
  { allowance: "semantic progress", requestTimeoutMs: undefined, progress: "semantic" },
  { allowance: "owned tool deadline", requestTimeoutMs: undefined, progress: "tool-deadline" },
  { allowance: "deadline-less tool", requestTimeoutMs: undefined, progress: "tool-no-deadline" },
  { allowance: "overlapping tools", requestTimeoutMs: undefined, progress: "overlapping-tools" },
  { allowance: "mixed tool deadlines", requestTimeoutMs: undefined, progress: "mixed-tools" },
])(
  "rechecks repeated requests before releasing a lane with $allowance",
  async ({ progress, requestTimeoutMs }) => {
    vi.useFakeTimers({ toFake: [...diagnosticTimerTypes, "performance"] });
    // Keep request expiry aligned with the scheduler's maintenance slots.
    vi.setSystemTime(0);
    setDiagnosticsEnabledForProcess(true);
    startDiagnosticRunActivityTracking();
    const ref = { sessionId: "s", sessionKey: "agent:main:s", runId: "r" };
    const activeEntered = createDeferred();
    const releaseActive = createDeferred();
    const { dispatch, outcomes, recover, start } = createQueuedRecoveryHeartbeat();
    const abort = vi.fn(() => {
      clearActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
      releaseActive.resolve();
    });
    const handle = createDiagnosticRunHandle(ref, abort);
    const owner = handle.diagnosticOwner;
    const startTool = (toolCallId: string, deadlineAtMs?: number) =>
      markDiagnosticOwnedToolActivity(owner, {
        phase: "start",
        toolName: "exec",
        toolCallId,
        ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
      });
    const lane = resolveEmbeddedSessionLane(ref.sessionKey);
    const active = enqueueCommandInLane(lane, async () => {
      setActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
      activeEntered.resolve();
      await releaseActive.promise;
    });
    await activeEntered.promise;
    const backend = beginDiagnosticBackendActivity({
      owner,
      noOutputTimeoutMs: 150_000,
      assertCurrent: () => {},
    });
    let queued: Promise<void> | undefined;
    try {
      for (let attempt = 0; attempt <= 8; attempt++) {
        const request = {
          ...ref,
          callId: `request-${attempt}`,
          provider: "mock",
          model: "retrying",
        };
        emitCoreModelRequestStartedDiagnosticEvent(request, owner.generation, requestTimeoutMs);
        await waitForDiagnosticEventsDrained();
        backend.observeOutput(false);
        if (attempt < 8) {
          await vi.advanceTimersByTimeAsync(50_000);
          emitCoreModelRequestEndedDiagnosticEvent(
            { ...request, type: "model.call.error", durationMs: 50_000, errorCategory: "retry" },
            owner.generation,
          );
          await waitForDiagnosticEventsDrained();
        }
      }
      const ranQueued = vi.fn(async () => {});
      const waits: number[] = [];
      queued = enqueueCommandInLane(lane, ranQueued, {
        warnAfterMs: 0,
        onWait: (waitedMs) => waits.push(waitedMs),
      });
      start();
      await vi.advanceTimersByTimeAsync(30_000);
      const recoveryWaitMs = requestTimeoutMs ?? 30_000;
      if (recoveryWaitMs > 30_000) {
        expect(recover).not.toHaveBeenCalled();
        expect(abort).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(recoveryWaitMs - 30_000);
      }
      expect(recover).toHaveBeenCalledOnce();
      if (progress === "semantic") {
        emitCoreSemanticRunProgressDiagnosticEvent({ ...ref, reason: "assistant:progress" });
        await waitForDiagnosticEventsDrained();
      } else if (progress === "tool-deadline" || progress === "tool-no-deadline") {
        startTool("owned-process", progress === "tool-deadline" ? Date.now() + 150_000 : undefined);
      } else if (progress === "overlapping-tools" || progress === "mixed-tools") {
        startTool("old-process", progress === "mixed-tools" ? Date.now() + 900_000 : undefined);
        vi.setSystemTime(Date.now() + 14 * 60_000);
        startTool("fresh-process");
        vi.setSystemTime(Date.now() + 2 * 60_000);
      }
      dispatch.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await recover.mock.results[0]?.value;
      if (progress !== "none") {
        expect(outcomes).toMatchObject([{ status: "skipped" }]);
        expect(abort).not.toHaveBeenCalled();
        expect(ranQueued).not.toHaveBeenCalled();
      } else {
        expect(outcomes).toMatchObject([{ status: "aborted", action: "abort_embedded_run" }]);
        expect(abort).toHaveBeenCalledOnce();
        expect(ranQueued).toHaveBeenCalledOnce();
        expect(waits).toEqual([recoveryWaitMs]);
      }
    } finally {
      stopGatewayDiagnosticHeartbeat();
      dispatch.resolve();
      releaseActive.resolve();
      backend.close();
      clearActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
      await active;
      await queued;
      vi.useRealTimers();
    }
  },
);

it.each([
  { mode: "followup", ownerless: false },
  { mode: "collect", ownerless: false },
  { mode: "followup", ownerless: true },
] as const)(
  "continues $mode work after recovery with ownerless=$ownerless",
  async ({ mode, ownerless }) => {
    if (!ownerless) {
      vi.useFakeTimers();
    }
    const sessionKey = "agent:main:wedged-" + mode;
    const sessionId = "wedged-" + mode + "-session";
    const { calls, enqueue, first } = followups(sessionKey, mode);
    const activeSettled = vi.fn();
    const laneEntered = createDeferred();
    const releaseLane = createDeferred();
    const laneTask = ownerless
      ? enqueueCommandInLane(resolveEmbeddedSessionLane(sessionKey), () => {
          laneEntered.resolve();
          return releaseLane.promise;
        })
      : undefined;
    try {
      if (ownerless) {
        await laneEntered.promise;
      }
      const active = createQueueTestRun({ prompt: "active" });
      if (!ownerless) {
        active.turnAdoptionLifecycle = { onAdopted: async () => {}, onSettled: activeSettled };
      }
      enqueue(active);
      await first.entered.promise;
      enqueue("pending");
      if (ownerless) {
        await expect(
          recoverStuckDiagnosticSession({ sessionId, sessionKey, ageMs: 300_000, queueDepth: 1 }),
        ).resolves.toMatchObject({
          status: "released",
          action: "release_lane",
          reason: "stale_lane_task",
        });
        await vi.waitFor(() => expect(calls).toEqual(["active", "pending"]));
      } else {
        const recovery = recoverWedgedReply(sessionKey, sessionId);
        await vi.advanceTimersByTimeAsync(15_100);
        await expect(recovery).resolves.toMatchObject({
          status: "aborted",
          action: "abort_embedded_run",
          forceCleared: true,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toEqual([
          expect.stringContaining("active"),
          expect.stringContaining("pending"),
        ]);
        expect(activeSettled).toHaveBeenCalledOnce();
      }
      first.release.resolve();
      if (ownerless) {
        await vi.waitFor(() => expect(calls).toEqual(["active", "pending"]));
      } else {
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(2);
        expect(activeSettled).toHaveBeenCalledOnce();
      }
    } finally {
      first.release.resolve();
      releaseLane.resolve();
      await laneTask;
      if (!ownerless) {
        await vi.runOnlyPendingTimersAsync();
        vi.useRealTimers();
      }
    }
  },
);
it("does not retire a fresh source that became active while recovery was settling", async () => {
  vi.useFakeTimers();
  const sessionKey = "agent:main:fresh-followup-owner";
  const sessionId = "fresh-followup-owner-session";
  const { calls, enqueue, first, second } = followups(sessionKey, "followup", true);

  try {
    enqueue("stale");
    await first.entered.promise;
    enqueue("fresh");

    const recovery = recoverWedgedReply(sessionKey, sessionId);
    first.release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await second.entered.promise;
    await vi.advanceTimersByTimeAsync(15_100);

    await expect(recovery).resolves.toMatchObject({ forceCleared: true });
    expect(calls).toEqual(["stale", "fresh"]);
    second.release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["stale", "fresh"]);
  } finally {
    first.release.resolve();
    second.release.resolve();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  }
});
