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

afterEach(() => {
  vi.useRealTimers();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticEventsForTest();
});

describe("core model owner generations", () => {
  it("keeps sliding quiet protection after the start-relative recovery allowance", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.parse("2026-10-04T00:00:00Z");
    vi.setSystemTime(startedAt);
    const ref = {
      sessionId: "quiet-owner",
      sessionKey: "agent:main:quiet-owner",
      runId: "quiet-run",
    };
    const owner = createDiagnosticEmbeddedRunOwner(ref);
    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, owner });
    emitCoreModelRequestStartedDiagnosticEvent(
      { ...ref, callId: "quiet-call", provider: "core", model: "request-model" },
      owner.generation,
      900_000,
    );
    await waitForDiagnosticEventsDrained();
    vi.setSystemTime(startedAt + 800_000);
    markDiagnosticRunProgress({ ...ref, reason: "model_call:stream_progress" });
    vi.setSystemTime(startedAt + 1_160_000);
    const activity = getDiagnosticSessionActivitySnapshot(ref);
    expect(activity.lastProgressAgeMs).toBe(360_000);
    expect(activity.repeatedRequestNoProgressAgeMs).toBeUndefined();
    expect(activity.activeModelCallRecoveryDeadlineAtMs).toBe(startedAt + 900_000);
    expect(activity.activeModelCallRequestTimeoutMs).toBe(900_000);
    expect(
      // The unchanged generic guard still honors the full sliding quiet allowance,
      // even though the separate start-relative eligibility time has expired.
      resolveRunStaleThresholdMs(activity, 360_000, 360_000),
    ).toBe(900_000);
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
        markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner });
        emitDiagnosticEvent({
          type: "tool.execution.started",
          ...ref,
          runId,
          toolName: "stale-tool",
          toolCallId: runId,
        });
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
    const ref = { sessionId: "overlapping-fences", sessionKey: "agent:main:fences" };
    let newerFenceAtDelivery: boolean | undefined;
    onInternalDiagnosticEvent(
      (event) => {
        if (event.type !== "tool.execution.started") {
          return;
        }
        if (event.toolCallId === "first-start") {
          const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId: "second-run" });
          markDiagnosticEmbeddedRunStarted({ ...ref, runId: "second-run", owner });
          emitDiagnosticEvent({
            type: "tool.execution.started",
            ...ref,
            runId: "second-run",
            toolName: "second-stale-tool",
            toolCallId: "second-start",
          });
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
    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "first-run", owner: first });
    emitDiagnosticEvent({
      type: "tool.execution.started",
      ...ref,
      runId: "first-run",
      toolName: "first-stale-tool",
      toolCallId: "first-start",
    });
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

    const replacement = createDiagnosticEmbeddedRunOwner({ ...ref, runId: "replacement-run" });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "replacement-run", owner: replacement });
    emitDiagnosticEvent({
      type: "tool.execution.started",
      ...ref,
      runId: "replacement-run",
      toolName: "replacement-tool",
      toolCallId: "replacement-start",
    });
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
    const ref = { sessionId: "rearmed-session", sessionKey: "agent:main:rearmed" };
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
      emitCoreModelRequestStartedDiagnosticEvent(
        { ...ref, runId: earlier.runId, callId, provider: "core", model: "request-model" },
        earlierOwner.generation,
      );
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
    vi.useFakeTimers({ toFake: ["Date"] });
    const requestStartedAt = Date.parse("2026-10-04T00:00:00.000Z");
    vi.setSystemTime(requestStartedAt);
    const ref = { sessionId: "core-owner-session", sessionKey: "agent:main:core-owner" };
    const runId = "core-owner-run";
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner });
    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...ref,
        runId,
        callId: "call-1",
        provider: "core",
        model: "slow-model",
      },
      owner.generation,
      300_000,
    );
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

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: "model_call",
      hasActiveEmbeddedRun: true,
      activeModelCallRecoveryDeadlineAtMs: requestStartedAt + 300_000,
      lastProgressReason: "model_call:started",
    });
  });

  it("fences queued old starts and delayed terminals without erasing a same-run replacement", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.parse("2026-10-04T00:00:00.000Z");
    vi.setSystemTime(startedAt);
    const ref = { sessionId: "generation-session", sessionKey: "agent:main:generation" };
    const runId = "reused-run";
    const ownerA = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner: ownerA });
    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...ref,
        runId,
        callId: "old-call",
        provider: "core",
        model: "slow-model",
      },
      ownerA.generation,
      300_000,
    );
    closeDiagnosticEmbeddedRunOwner(ownerA);

    const ownerB = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner: ownerB });
    const currentRequestStartedAt = startedAt + 100;
    vi.setSystemTime(currentRequestStartedAt);
    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...ref,
        runId,
        callId: "new-call",
        provider: "core",
        model: "replacement-model",
      },
      ownerB.generation,
      420_000,
    );
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner: ownerA });
    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...ref,
        runId,
        callId: "resurrected-old-call",
        provider: "core",
        model: "stale-model",
      },
      ownerA.generation,
      600_000,
    );
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

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: "model_call",
      hasActiveEmbeddedRun: true,
      activeModelCallRecoveryDeadlineAtMs: currentRequestStartedAt + 420_000,
    });
  });

  it("projects only the current owner generation request deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.parse("2026-10-04T00:00:00.000Z");
    vi.setSystemTime(startedAt);
    const ref = {
      sessionId: "deadline-generation-session",
      sessionKey: "agent:main:deadline-generation",
    };
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
      markDiagnosticEmbeddedRunStarted({
        ...ref,
        runId: oldRunId,
        workKey: oldOwner.workKey,
        owner: oldOwner,
      });
      emitCoreModelRequestStartedDiagnosticEvent(
        {
          ...ref,
          runId: oldRunId,
          callId: "prior-long-call",
          provider: "core",
          model: "slow-prior-model",
        },
        oldOwner.generation,
        600_000,
      );
      await waitForDiagnosticEventsDrained();

      const currentRequestStartedAt = startedAt + 100;
      vi.setSystemTime(currentRequestStartedAt);
      markDiagnosticEmbeddedRunStarted({
        ...ref,
        runId: currentRunId,
        workKey: currentOwner.workKey,
        owner: currentOwner,
      });
      emitCoreModelRequestStartedDiagnosticEvent(
        {
          ...ref,
          runId: currentRunId,
          callId: "current-short-call",
          provider: "core",
          model: "current-model",
        },
        currentOwner.generation,
        100_000,
      );
      await waitForDiagnosticEventsDrained();

      const deadlineAtMs =
        getDiagnosticSessionActivitySnapshot(ref).activeModelCallRecoveryDeadlineAtMs;
      expect(deadlineAtMs).toBe(currentRequestStartedAt + 100_000);
      expect(deadlineAtMs).toBeLessThan(startedAt + 600_000);
    } finally {
      closeDiagnosticEmbeddedRunOwner(oldOwner);
      closeDiagnosticEmbeddedRunOwner(currentOwner);
    }
  });
});
