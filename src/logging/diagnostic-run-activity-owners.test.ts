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
      activeModelCallRequestTimeoutMs: 300_000,
      lastProgressReason: "model_call:started",
    });
  });

  it("fences queued old starts and delayed terminals without erasing a same-run replacement", async () => {
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
      activeModelCallRequestTimeoutMs: 420_000,
    });
  });
});
