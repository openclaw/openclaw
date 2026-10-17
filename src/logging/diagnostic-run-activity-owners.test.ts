import { emitTrustedDiagnosticEvent as emitPluginTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

type Owner = ReturnType<typeof createDiagnosticEmbeddedRunOwner>;
function markOwner(owner: Owner) {
  markDiagnosticEmbeddedRunStarted({ ...owner, owner });
}
const snapshot = getDiagnosticSessionActivitySnapshot;
const startedAt = Date.parse("2026-10-04T00:00:00.000Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(startedAt);
});

function startRequest(owner: Owner, callId: string, timeoutMs?: number, model = "slow-model") {
  const { sessionId, sessionKey, runId } = owner;
  emitCoreModelRequestStartedDiagnosticEvent(
    { sessionId, sessionKey, runId, callId, provider: "core", model },
    owner.generation,
    timeoutMs,
  );
}

function startTool(owner: Owner, toolName: string, toolCallId: string) {
  const { sessionId, sessionKey, runId } = owner;
  const ref = { sessionId, sessionKey, runId };
  emitDiagnosticEvent({ type: "tool.execution.started", ...ref, toolName, toolCallId });
}

afterEach(() => {
  vi.useRealTimers();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticEventsForTest();
});

it("keeps sliding quiet protection after the start-relative recovery allowance", async () => {
  const ref = {
    sessionId: "quiet-owner",
    sessionKey: "agent:main:quiet-owner",
    runId: "quiet-run",
  };
  const owner = createDiagnosticEmbeddedRunOwner(ref);
  startDiagnosticRunActivityTracking();
  markOwner(owner);
  startRequest(owner, "quiet-call", 900_000, "request-model");
  await waitForDiagnosticEventsDrained();
  vi.setSystemTime(startedAt + 800_000);
  markDiagnosticRunProgress({ ...ref, reason: "model_call:stream_progress" });
  vi.setSystemTime(startedAt + 1_160_000);
  const activity = snapshot(ref);
  expect(activity).toMatchObject({
    lastProgressAgeMs: 360_000,
    repeatedRequestNoProgressAgeMs: undefined,
    activeModelCallRecoveryDeadlineAtMs: startedAt + 900_000,
    activeModelCallRequestTimeoutMs: 900_000,
  });
  // Quiet protection slides even after the start-relative recovery allowance expires.
  expect(resolveRunStaleThresholdMs(activity, 360_000, 360_000)).toBe(900_000);
  closeDiagnosticEmbeddedRunOwner(owner);
});

it.each([false, true])(
  "releases drained run fences without losing idle progress (merged: %s)",
  async (merge) => {
    const ref = { sessionId: "fenced-session", sessionKey: "agent:main:fenced" };
    const target = { sessionId: "merged-session", sessionKey: ref.sessionKey };
    startDiagnosticRunActivityTracking();
    if (merge) {
      markDiagnosticRunProgress({ sessionId: target.sessionId, reason: "prior-progress" });
    }
    for (let index = 0; index < 32; index++) {
      const runId = `completed-run-${index}`;
      const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
      markOwner(owner);
      startTool(owner, "stale-tool", runId);
      closeDiagnosticEmbeddedRunOwner(owner);
    }
    const observedRef = merge ? target : ref;
    const observedAt = Date.now();
    const beforeDrain = snapshot(observedRef, observedAt);
    const cutoffs = resolveSessionActivity(observedRef)?.recoveredOwnerStartEventCutoffs;
    expect(cutoffs?.has("completed-run-0")).toBe(true);
    expect(beforeDrain).toMatchObject({
      activeWorkKind: undefined,
      lastProgressReason: "embedded_run:ended",
    });
    expect(activityByRunId.size).toBe(0);

    await waitForDiagnosticEventsDrained();

    expect(snapshot(observedRef, observedAt)).toEqual(beforeDrain);
    expect(cutoffs?.size).toBe(0);
    expect(activityByRunId.size).toBe(0);
  },
);

it("preserves a newer fence while an earlier diagnostic prefix drains", async () => {
  const ref = { sessionId: "overlapping-fences", sessionKey: "agent:main:fences" };
  let newerFenceAtDelivery: boolean | undefined;
  onInternalDiagnosticEvent(
    (event) => {
      if (event.type !== "tool.execution.started") {
        return;
      }
      if (event.toolCallId === "first-start") {
        const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId: "second-run" });
        markOwner(owner);
        startTool(owner, "second-stale-tool", "second-start");
        closeDiagnosticEmbeddedRunOwner(owner);
      } else if (event.toolCallId === "second-start") {
        newerFenceAtDelivery =
          resolveSessionActivity(ref)?.recoveredOwnerStartEventCutoffs.has("second-run");
      }
    },
    { include: ["tool.execution.started"] },
  );
  startDiagnosticRunActivityTracking();
  const first = createDiagnosticEmbeddedRunOwner({ ...ref, runId: "first-run" });
  markOwner(first);
  startTool(first, "first-stale-tool", "first-start");
  closeDiagnosticEmbeddedRunOwner(first);

  await waitForDiagnosticEventsDrained();
  // The first batch enqueues the second owner's start behind its captured prefix.
  await waitForDiagnosticEventsDrained();

  expect(newerFenceAtDelivery).toBe(true);
  expect(snapshot(ref)).toMatchObject({
    activeWorkKind: undefined,
    activeToolName: undefined,
    lastProgressReason: "embedded_run:ended",
  });
  expect(resolveSessionActivity(ref)?.recoveredOwnerStartEventCutoffs.size).toBe(0);
  expect(activityByRunId.size).toBe(0);

  const replacement = createDiagnosticEmbeddedRunOwner({ ...ref, runId: "replacement-run" });
  markOwner(replacement);
  startTool(replacement, "replacement-tool", "replacement-start");
  await waitForDiagnosticEventsDrained();
  expect(snapshot(ref)).toMatchObject({
    activeWorkKind: "tool_call",
    activeToolName: "replacement-tool",
  });
  expect(activityByRunId.has("replacement-run")).toBe(true);
});

it("keeps the newest run's clocks when an earlier work key is rearmed", async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ now: startedAt });
  const ref = { sessionId: "rearmed-session", sessionKey: "agent:main:rearmed" };
  const earlier = { ...ref, runId: "earlier-run", workKey: "first" };
  const later = { ...ref, runId: "later-run", workKey: "second" };
  const earlierOwner = createDiagnosticEmbeddedRunOwner(earlier);
  const laterOwner = createDiagnosticEmbeddedRunOwner(later);
  startDiagnosticRunActivityTracking();
  markOwner(earlierOwner);
  markOwner(laterOwner);
  markOwner(earlierOwner);
  markDiagnosticArgumentChurnObservation({ ...ref, runId: earlier.runId, active: true });
  for (const callId of ["request-1", "request-2"]) {
    startRequest(earlierOwner, callId, undefined, "request-model");
  }
  await vi.advanceTimersByTimeAsync(0);
  await waitForDiagnosticEventsDrained();

  expect(snapshot(ref, startedAt + 30_000)).toMatchObject({
    activeWorkKind: "model_call",
    lastProgressReason: "tool_loop:argument_churn",
    lastProgressAgeMs: 30_000,
    repeatedRequestNoProgressAgeMs: 30_000,
  });

  closeDiagnosticEmbeddedRunOwner(earlierOwner);
  expect(snapshot(ref, startedAt + 30_000)).toMatchObject({
    activeWorkKind: "embedded_run",
    hasActiveEmbeddedRun: true,
    lastProgressReason: "embedded_run:ended",
    repeatedRequestNoProgressAgeMs: undefined,
  });
  closeDiagnosticEmbeddedRunOwner(laterOwner);
});

it("keeps exact-call recovery policy intact across forged terminals and run completion", async () => {
  const ref = { sessionId: "core-owner-session", sessionKey: "agent:main:core-owner" };
  const runId = "core-owner-run";
  const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
  startDiagnosticRunActivityTracking();
  markOwner(owner);
  startRequest(owner, "call-1", 300_000, "slow-model");
  await waitForDiagnosticEventsDrained();

  emitPluginTrustedDiagnosticEvent({
    type: "model.call.completed",
    ...ref,
    runId,
    callId: "call-1",
    provider: "core",
    model: "slow-model",
    durationMs: 1,
  });
  emitDiagnosticEvent({
    type: "run.completed",
    ...ref,
    runId,
    durationMs: 1,
    outcome: "completed",
  });
  await waitForDiagnosticEventsDrained();

  expect(snapshot(ref)).toMatchObject({
    activeWorkKind: "model_call",
    hasActiveEmbeddedRun: true,
    activeModelCallRecoveryDeadlineAtMs: startedAt + 300_000,
    lastProgressReason: "model_call:started",
  });
});

it("fences queued old starts and delayed terminals without erasing a same-run replacement", async () => {
  const ref = { sessionId: "generation-session", sessionKey: "agent:main:generation" };
  const runId = "reused-run";
  const ownerA = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
  startDiagnosticRunActivityTracking();
  markOwner(ownerA);
  startRequest(ownerA, "old-call", 300_000, "slow-model");
  closeDiagnosticEmbeddedRunOwner(ownerA);

  const ownerB = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
  markOwner(ownerB);
  const currentRequestStartedAt = startedAt + 100;
  vi.setSystemTime(currentRequestStartedAt);
  startRequest(ownerB, "new-call", 420_000, "replacement-model");
  markOwner(ownerA);
  startRequest(ownerA, "resurrected-old-call", 600_000, "stale-model");
  await waitForDiagnosticEventsDrained();
  emitCoreModelRequestEndedDiagnosticEvent(
    {
      type: "model.call.completed",
      ...ref,
      runId,
      callId: "old-call",
      provider: "core",
      model: "slow-model",
      durationMs: 1,
    },
    ownerA.generation,
  );
  await waitForDiagnosticEventsDrained();

  expect(snapshot(ref)).toMatchObject({
    activeWorkKind: "model_call",
    hasActiveEmbeddedRun: true,
    activeModelCallRecoveryDeadlineAtMs: currentRequestStartedAt + 420_000,
  });
});

it("projects only the current owner generation request deadline", async () => {
  const ref = { sessionId: "deadline-session", sessionKey: "agent:main:deadline" };
  const makeOwner = (runId: string, workKey: string) =>
    createDiagnosticEmbeddedRunOwner({ ...ref, runId, workKey });
  const oldOwner = makeOwner("long-prior-request", "prior-owner");
  const currentOwner = makeOwner("current-request", "current-owner");
  startDiagnosticRunActivityTracking();
  try {
    markOwner(oldOwner);
    startRequest(oldOwner, "prior-long-call", 600_000, "slow-prior-model");
    await waitForDiagnosticEventsDrained();

    const currentRequestStartedAt = startedAt + 100;
    vi.setSystemTime(currentRequestStartedAt);
    markOwner(currentOwner);
    startRequest(currentOwner, "current-short-call", 100_000, "current-model");
    await waitForDiagnosticEventsDrained();

    expect(snapshot(ref).activeModelCallRecoveryDeadlineAtMs).toBe(
      currentRequestStartedAt + 100_000,
    );
  } finally {
    closeDiagnosticEmbeddedRunOwner(oldOwner);
    closeDiagnosticEmbeddedRunOwner(currentOwner);
  }
});
