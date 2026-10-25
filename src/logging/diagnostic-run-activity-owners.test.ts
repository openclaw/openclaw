import { emitTrustedDiagnosticEvent as emitPluginTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  emitCoreModelRequestEndedDiagnosticEvent,
  emitCoreModelRequestStartedDiagnosticEvent,
} from "../infra/diagnostic-model-request.js";
import { resolveRunStaleThresholdMs } from "./diagnostic-run-activity-snapshot.js";
import { activityByRunId, resolveSessionActivity } from "./diagnostic-run-activity-state.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticArgumentChurnObservation,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "./diagnostic-run-activity.js";

const ref = { sessionId: "owner-session", sessionKey: "agent:main:owner" };

afterEach(() => {
  vi.useRealTimers();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticEventsForTest();
});

function startOwner(run: Parameters<typeof createDiagnosticEmbeddedRunOwner>[0]) {
  const owner = createDiagnosticEmbeddedRunOwner(run);
  startDiagnosticRunActivityTracking();
  markDiagnosticEmbeddedRunStarted({ ...run, owner });
  return owner;
}

function setClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = Date.parse("2026-10-04T00:00:00Z");
  vi.setSystemTime(now);
  return now;
}

function completedRequest(
  { sessionId, sessionKey, runId }: ReturnType<typeof createDiagnosticEmbeddedRunOwner>,
  callId: string,
) {
  return {
    type: "model.call.completed" as const,
    sessionId,
    sessionKey,
    runId,
    callId,
    provider: "core",
    model: "slow-model",
    durationMs: 1,
  };
}

function startRequest(
  owner: ReturnType<typeof createDiagnosticEmbeddedRunOwner>,
  callId: string,
  timeout?: number,
  model = "request-model",
) {
  const { sessionId, sessionKey, runId } = owner;
  emitCoreModelRequestStartedDiagnosticEvent(
    { sessionId, sessionKey, runId, callId, provider: "core", model },
    owner.generation,
    timeout,
  );
}

function startTool(
  run: Parameters<typeof createDiagnosticEmbeddedRunOwner>[0],
  toolCallId: string,
  toolName = "stale-tool",
) {
  const { sessionId, sessionKey, runId } = run;
  emitDiagnosticEvent({
    type: "tool.execution.started",
    sessionId,
    sessionKey,
    runId,
    toolCallId,
    toolName,
  });
}

describe("core model owner generations", () => {
  it("keeps sliding quiet protection after the start-relative recovery allowance", async () => {
    const startedAt = setClock();
    const run = { ...ref, runId: "quiet-run" };
    const owner = startOwner(run);
    startRequest(owner, "quiet-call", 900_000);
    await waitForDiagnosticEventsDrained();
    vi.setSystemTime(startedAt + 800_000);
    markDiagnosticRunProgress({ ...run, reason: "model_call:stream_progress" });
    vi.setSystemTime(startedAt + 1_160_000);
    const activity = getDiagnosticSessionActivitySnapshot(ref);
    expect(activity).toMatchObject({
      lastProgressAgeMs: 360_000,
      repeatedRequestNoProgressAgeMs: undefined,
      activeModelCallRequestTimeoutMs: 900_000,
    });
    expect(resolveRunStaleThresholdMs(activity, 360_000, 360_000)).toBe(900_000);
    closeDiagnosticEmbeddedRunOwner(owner);
  });

  it.each([false, true])(
    "releases drained run fences without losing idle progress (merged: %s)",
    async (merge) => {
      const target = { sessionId: "merged-session", sessionKey: ref.sessionKey };
      startDiagnosticRunActivityTracking();
      if (merge) {
        markDiagnosticRunProgress({ sessionId: target.sessionId, reason: "prior-progress" });
      }
      for (let index = 0; index < 32; index++) {
        const runId = `completed-run-${index}`;
        const owner = startOwner({ ...ref, runId });
        startTool({ ...ref, runId }, runId);
        closeDiagnosticEmbeddedRunOwner(owner);
      }
      const observedRef = merge ? target : ref;
      const observedAt = Date.now();
      const beforeDrain = getDiagnosticSessionActivitySnapshot(observedRef, observedAt);
      const cutoffs = resolveSessionActivity(observedRef)?.recoveredOwnerStartEventCutoffs;
      expect(cutoffs?.has("completed-run-0")).toBe(true);
      expect(beforeDrain).toMatchObject({
        activeWorkKind: undefined,
        lastProgressReason: "embedded_run:ended",
      });
      expect(activityByRunId.size).toBe(0);

      await waitForDiagnosticEventsDrained();

      expect(getDiagnosticSessionActivitySnapshot(observedRef, observedAt)).toEqual(beforeDrain);
      expect(cutoffs?.size).toBe(0);
      expect(activityByRunId.size).toBe(0);
    },
  );

  it("preserves a newer fence while an earlier diagnostic prefix drains", async () => {
    let newerFenceAtDelivery: boolean | undefined;
    onInternalDiagnosticEvent(
      (event) => {
        if (event.type !== "tool.execution.started") {
          return;
        }
        if (event.toolCallId === "first-start") {
          const owner = startOwner({ ...ref, runId: "second-run" });
          startTool(owner, "second-start", "second-stale-tool");
          closeDiagnosticEmbeddedRunOwner(owner);
        } else if (event.toolCallId === "second-start") {
          newerFenceAtDelivery =
            resolveSessionActivity(ref)?.recoveredOwnerStartEventCutoffs.has("second-run");
        }
      },
      { include: ["tool.execution.started"] },
    );
    const first = startOwner({ ...ref, runId: "first-run" });
    startTool(first, "first-start", "first-stale-tool");
    closeDiagnosticEmbeddedRunOwner(first);

    await waitForDiagnosticEventsDrained();
    // The first batch enqueues the second owner's start behind its captured prefix.
    await waitForDiagnosticEventsDrained();

    expect(newerFenceAtDelivery).toBe(true);
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: undefined,
      activeToolName: undefined,
      lastProgressReason: "embedded_run:ended",
    });
    expect(resolveSessionActivity(ref)?.recoveredOwnerStartEventCutoffs.size).toBe(0);
    expect(activityByRunId.size).toBe(0);

    const replacement = startOwner({ ...ref, runId: "replacement-run" });
    startTool(replacement, "replacement-start", "replacement-tool");
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: "tool_call",
      activeToolName: "replacement-tool",
    });
    expect(activityByRunId.has("replacement-run")).toBe(true);
  });

  it("keeps the newest run's clocks when an earlier work key is rearmed", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-09-04T00:00:00Z");
    vi.setSystemTime(startedAt);
    const earlier = { ...ref, runId: "earlier-run", workKey: "first" };
    const later = { ...ref, runId: "later-run", workKey: "second" };
    const earlierOwner = createDiagnosticEmbeddedRunOwner(earlier);
    const laterOwner = createDiagnosticEmbeddedRunOwner(later);
    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...earlier, owner: earlierOwner });
    markDiagnosticEmbeddedRunStarted({ ...later, owner: laterOwner });
    markDiagnosticEmbeddedRunStarted({ ...earlier, owner: earlierOwner });
    markDiagnosticArgumentChurnObservation({ ...ref, runId: earlier.runId, active: true });
    for (const callId of ["request-1", "request-2"]) {
      startRequest(earlierOwner, callId);
    }
    await vi.advanceTimersByTimeAsync(0);
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticSessionActivitySnapshot(ref, startedAt + 30_000)).toMatchObject({
      activeWorkKind: "model_call",
      lastProgressReason: "tool_loop:argument_churn",
      lastProgressAgeMs: 30_000,
      repeatedRequestNoProgressAgeMs: 30_000,
    });

    closeDiagnosticEmbeddedRunOwner(earlierOwner);
    expect(getDiagnosticSessionActivitySnapshot(ref, startedAt + 30_000)).toMatchObject({
      activeWorkKind: "embedded_run",
      hasActiveEmbeddedRun: true,
      lastProgressReason: "embedded_run:ended",
      repeatedRequestNoProgressAgeMs: undefined,
    });
    closeDiagnosticEmbeddedRunOwner(laterOwner);
  });

  it("keeps exact-call recovery policy intact across forged terminals and run completion", async () => {
    setClock();
    const runId = "core-owner-run";
    const owner = startOwner({ ...ref, runId });
    startRequest(owner, "call-1", 300_000, "slow-model");
    await waitForDiagnosticEventsDrained();

    emitPluginTrustedDiagnosticEvent(completedRequest(owner, "call-1"));
    emitDiagnosticEvent({
      type: "run.completed",
      ...ref,
      runId,
      durationMs: 1,
      outcome: "completed",
    });
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: "model_call",
      hasActiveEmbeddedRun: true,
      activeModelCallRequestTimeoutMs: 300_000,
      lastProgressReason: "model_call:started",
    });
  });

  it("fences queued old starts and delayed terminals without erasing a same-run replacement", async () => {
    const startedAt = setClock();
    const runId = "reused-run";
    const ownerA = startOwner({ ...ref, runId });
    startRequest(ownerA, "old-call", 300_000, "slow-model");
    closeDiagnosticEmbeddedRunOwner(ownerA);

    const ownerB = startOwner({ ...ref, runId });
    vi.setSystemTime(startedAt + 100);
    startRequest(ownerB, "new-call", 420_000, "replacement-model");
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner: ownerA });
    startRequest(ownerA, "resurrected-old-call", 600_000, "stale-model");
    await waitForDiagnosticEventsDrained();
    emitCoreModelRequestEndedDiagnosticEvent(
      completedRequest(ownerA, "old-call"),
      ownerA.generation,
    );
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: "model_call",
      hasActiveEmbeddedRun: true,
      activeModelCallRequestTimeoutMs: 420_000,
    });
  });

  it("projects only the current owner generation request timeout", async () => {
    const startedAt = setClock();
    const oldRunId = "long-prior-request";
    const currentRunId = "current-request";
    const oldOwner = createDiagnosticEmbeddedRunOwner({
      ...ref,
      runId: oldRunId,
      workKey: "prior-owner",
    });
    const currentOwner = createDiagnosticEmbeddedRunOwner({
      ...ref,
      runId: currentRunId,
      workKey: "current-owner",
    });
    startDiagnosticRunActivityTracking();
    try {
      markDiagnosticEmbeddedRunStarted({ ...oldOwner, owner: oldOwner });
      startRequest(oldOwner, "prior-long-call", 600_000, "slow-prior-model");
      await waitForDiagnosticEventsDrained();

      vi.setSystemTime(startedAt + 100);
      markDiagnosticEmbeddedRunStarted({ ...currentOwner, owner: currentOwner });
      startRequest(currentOwner, "current-short-call", 100_000, "current-model");
      await waitForDiagnosticEventsDrained();

      const requestTimeoutMs =
        getDiagnosticSessionActivitySnapshot(ref).activeModelCallRequestTimeoutMs;
      expect(requestTimeoutMs).toBe(100_000);
    } finally {
      closeDiagnosticEmbeddedRunOwner(oldOwner);
      closeDiagnosticEmbeddedRunOwner(currentOwner);
    }
  });
});
