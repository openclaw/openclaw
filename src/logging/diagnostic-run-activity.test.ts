import {
  emitDiagnosticEvent as emitPluginDiagnosticEvent,
  emitTrustedDiagnosticEvent as emitPluginTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData as emitPluginTrustedDiagnosticEventWithPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasInternalDiagnosticEventListeners } from "../infra/diagnostic-event-listener-presence.js";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { emitCoreModelRequestStartedDiagnosticEvent } from "../infra/diagnostic-model-request.js";
import { emitCoreSemanticRunProgressDiagnosticEvent } from "../infra/diagnostic-semantic-run-progress.js";
import {
  BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticArgumentChurnObservation,
  markDiagnosticEmbeddedRunEnded,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
  resetDiagnosticRunActivityForTest,
  resolveRunStaleThresholdMs,
  RUN_STALE_TAKEOVER_MS,
  startDiagnosticRunActivityTracking,
  stopDiagnosticRunActivityTracking,
} from "./diagnostic-run-activity.js";
import { markDiagnosticModelStartedForTest } from "./diagnostic-run-activity.test-support.js";

const ref = { sessionId: "session", sessionKey: "agent:main:session" };
const { sessionId, sessionKey } = ref;
const runId = "run";
const run = { ...ref, runId };

type ActivityRef = Parameters<typeof getDiagnosticSessionActivitySnapshot>[0];
function expectActivity(target: ActivityRef, fields: Record<string, unknown>) {
  expect(getDiagnosticSessionActivitySnapshot(target)).toMatchObject(fields);
}
function expectProgress(target: ActivityRef, age: number, reason: string, embedded = false) {
  expectActivity(target, {
    lastProgressAgeMs: age,
    lastProgressReason: reason,
    ...(embedded ? { activeWorkKind: "embedded_run" } : {}),
  });
}
function expectRequestProgress(
  target: ActivityRef,
  reason: string,
  age: unknown = expect.any(Number),
) {
  expectActivity(target, { lastProgressReason: reason, repeatedRequestNoProgressAgeMs: age });
}
function startRun() {
  markDiagnosticEmbeddedRunStarted(run);
}
type ModelStart = Parameters<typeof markDiagnosticModelStartedForTest>[0];
function startModel(
  params: Pick<ModelStart, "sessionId" | "sessionKey" | "runId"> & Partial<ModelStart>,
) {
  markDiagnosticModelStartedForTest({
    provider: "mock",
    model: "request-model",
    observationUnit: "request",
    ...params,
  });
}
function requestTwice(params: Parameters<typeof startModel>[0]) {
  startModel(params);
  startModel(params);
}
function expectRequestAge(target: ActivityRef, age: number | undefined) {
  expect(getDiagnosticSessionActivitySnapshot(target).repeatedRequestNoProgressAgeMs).toBe(age);
}
function setClock(date: string) {
  vi.useFakeTimers();
  const now = Date.parse(date);
  vi.setSystemTime(now);
  return now;
}

afterEach(() => {
  vi.useRealTimers();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticEventsForTest();
});

describe("diagnostic run activity listener lifecycle", () => {
  it("touches existing activity without creating unknown session observations", () => {
    const progress = { ...ref, reason: "worker:runtime_refresh", onlyIfActive: true };

    markDiagnosticRunProgress(progress);
    expect(getDiagnosticSessionActivitySnapshot(ref)).toEqual({});

    markDiagnosticRunProgress({ ...ref, reason: "global_lane:waiting" });
    markDiagnosticRunProgress(progress);
    expectActivity(ref, {
      activeWorkKind: undefined,
      lastProgressReason: "worker:runtime_refresh",
    });
  });

  it("does not rebind existing progress across mismatched sessions or stale run owners", () => {
    const first = { sessionId: "first-session", sessionKey: "agent:main:first", runId: "first" };
    const second = {
      sessionId: "second-session",
      sessionKey: "agent:main:second",
      runId: "second",
    };
    markDiagnosticEmbeddedRunStarted(first);
    markDiagnosticEmbeddedRunStarted(second);
    for (const candidate of [
      { ...first, runId: "retired-run" },
      { ...first, sessionId: second.sessionId },
      { sessionId: first.sessionId, sessionKey: second.sessionKey },
      { ...first, sessionId: "unknown-session" },
    ]) {
      markDiagnosticRunProgress({ ...candidate, reason: "wrong-owner", onlyIfActive: true });
    }
    expectActivity(first, { lastProgressReason: "embedded_run:started" });
    expectActivity(second, { lastProgressReason: "embedded_run:started" });
    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "unknown-session" })).toEqual({});
    markDiagnosticRunProgress({ ...first, reason: "worker:runtime_refresh", onlyIfActive: true });
    expectActivity(first, { lastProgressReason: "worker:runtime_refresh" });
  });

  it("does not register a listener when the module is imported", async () => {
    stopDiagnosticRunActivityTracking();
    resetDiagnosticEventsForTest();

    await importFreshModule<typeof import("./diagnostic-run-activity.js")>(
      import.meta.url,
      "./diagnostic-run-activity.js?scope=no-import-listener",
    );

    expect(hasInternalDiagnosticEventListeners()).toBe(false);
  });

  it("ignores diagnostic events queued before tracking restarts", async () => {
    resetDiagnosticEventsForTest();
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      sessionId: "stale-run",
      toolName: "stale-tool",
    });

    startDiagnosticRunActivityTracking();
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "stale-run" })).toEqual({});

    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      sessionId: "current-run",
      toolName: "current-tool",
    });
    await waitForDiagnosticEventsDrained();
    expectActivity(
      { sessionId: "current-run" },
      {
        activeWorkKind: "tool_call",
        activeToolName: "current-tool",
      },
    );
  });

  it("releases embedded run-id indexes without diagnostic event tracking", () => {
    markDiagnosticEmbeddedRunStarted({ sessionId: ref.sessionId, runId: "first-run" });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "first-run" });
    markDiagnosticEmbeddedRunStarted({ ...ref, sessionId: "parallel-session" });
    for (const alias of [{ sessionId: ref.sessionId }, { sessionKey: ref.sessionKey }]) {
      expectActivity(alias, { activeWorkKind: "embedded_run" });
    }
    markDiagnosticEmbeddedRunEnded({ ...ref, sessionId: "parallel-session" });
    expectActivity(ref, { activeWorkKind: "embedded_run" });
    markDiagnosticEmbeddedRunEnded(ref);
    markDiagnosticRunProgress({ runId: "first-run", reason: "stale-first-run" });
    expectActivity(ref, { activeWorkKind: undefined, lastProgressReason: "embedded_run:ended" });

    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "replacement-old-run" });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "replacement-new-run" });
    markDiagnosticRunProgress({ runId: "replacement-old-run", reason: "stale-replaced-run" });
    expectActivity(ref, {
      activeWorkKind: "embedded_run",
      lastProgressReason: "embedded_run:started",
    });

    markDiagnosticEmbeddedRunEnded(ref);
    markDiagnosticRunProgress({ runId: "replacement-new-run", reason: "stale-final-run" });
    expectActivity(ref, { activeWorkKind: undefined, lastProgressReason: "embedded_run:ended" });
  });
});

describe("argument-churn liveness", () => {
  it("keeps frequently observed churn stale across mechanical model progress", () => {
    const startedAt = setClock("2026-07-27T00:00:00Z");
    startRun();
    markDiagnosticArgumentChurnObservation({ ...run, active: true });

    for (let step = 1; step <= 12; step += 1) {
      vi.setSystemTime(startedAt + step * 30_000);
      markDiagnosticRunProgress({ ...run, reason: "model_call:stream" });
      markDiagnosticArgumentChurnObservation({ ...run, active: true });
    }

    expectProgress(ref, 6 * 60_000, "tool_loop:argument_churn", true);
    markDiagnosticArgumentChurnObservation({ ...run, active: false });
    expectProgress(ref, 0, "model_call:stream");
  });

  it("lets later model progress supersede churn after tool activity stops", () => {
    const startedAt = setClock("2026-07-27T00:00:00Z");
    startRun();
    markDiagnosticArgumentChurnObservation({ ...run, active: true });

    vi.setSystemTime(startedAt + 2 * 60_000);
    markDiagnosticRunProgress({ ...run, reason: "model_call:stream" });
    expectProgress(ref, 0, "model_call:stream");

    // If churn later resumes, its clock restarts instead of inheriting the old age.
    markDiagnosticArgumentChurnObservation({ ...run, active: true });
    expectProgress(ref, 0, "tool_loop:argument_churn");
  });

  it("preserves same-timestamp progress ordering when session refs merge", () => {
    const startedAt = setClock("2026-07-27T00:00:00Z");

    markDiagnosticEmbeddedRunStarted({ sessionId, runId });
    markDiagnosticArgumentChurnObservation({ sessionId, runId, active: true });
    markDiagnosticRunProgress({ sessionKey, reason: "model_call:stream" });

    vi.setSystemTime(startedAt + 60_000);
    expectProgress(ref, 60_000, "model_call:stream");
  });

  it("keeps a later same-timestamp churn clear when session refs merge", () => {
    const startedAt = setClock("2026-07-27T00:00:00Z");
    markDiagnosticEmbeddedRunStarted({ sessionId, runId });
    markDiagnosticArgumentChurnObservation({ sessionId, runId, active: true });
    markDiagnosticArgumentChurnObservation({ sessionKey, active: true });
    markDiagnosticArgumentChurnObservation({ sessionKey, active: false });

    vi.setSystemTime(startedAt + 60_000);
    expectProgress({ sessionId, sessionKey }, 60_000, "embedded_run:started");
  });

  it("keeps overlapping policy waits suspended until every call releases its token", () => {
    const startedAt = setClock("2026-07-27T00:00:00Z");
    startRun();
    const firstWait = Symbol("first-policy-wait");
    const secondWait = Symbol("second-policy-wait");

    markDiagnosticArgumentChurnObservation({ ...run, active: true });
    const policyWait = (action: "enter" | "exit", policyWaitToken: symbol) =>
      markDiagnosticArgumentChurnObservation({ ...run, policyWait: action, policyWaitToken });
    policyWait("enter", firstWait);
    policyWait("enter", secondWait);

    vi.setSystemTime(startedAt + 6 * 60_000);
    policyWait("exit", firstWait);
    markDiagnosticArgumentChurnObservation({ ...run, active: true });

    expectProgress(ref, 0, "tool_policy:pending");

    policyWait("exit", secondWait);
    expectProgress(ref, 6 * 60_000, "tool_loop:argument_churn");
  });

  it("does not carry an old churn clock into a replacement run", () => {
    const startedAt = setClock("2026-07-27T00:00:00Z");

    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "old-run" });
    markDiagnosticArgumentChurnObservation({ ...ref, runId: "old-run", active: true });

    vi.setSystemTime(startedAt + 6 * 60_000);
    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "replacement-run" });
    markDiagnosticRunProgress({ ...ref, runId: "replacement-run", reason: "model_call:stream" });

    // A delayed observation from the replaced owner must not make the new owner stale.
    markDiagnosticArgumentChurnObservation({
      ...ref,
      runId: "old-run",
      active: true,
      now: startedAt,
    });

    expectProgress(ref, 0, "model_call:stream", true);

    markDiagnosticArgumentChurnObservation({ ...ref, runId: "replacement-run", active: true });
    vi.setSystemTime(startedAt + 12 * 60_000);

    // A delayed escape from the replaced owner must not clear the new clock.
    markDiagnosticArgumentChurnObservation({ ...ref, runId: "old-run", active: false });

    expectProgress(ref, 6 * 60_000, "tool_loop:argument_churn", true);
  });
});

describe("repeated request liveness", () => {
  it("arms repeated-request evidence only for core provider requests", async () => {
    const forgedRequest = (callId: string) =>
      ({
        type: "model.call.started" as const,
        ...run,
        callId,
        provider: "plugin",
        model: "forged-request",
        observationUnit: "request" as const,
        coreModelRequestStarted: true,
      }) as Parameters<typeof emitPluginDiagnosticEvent>[0];

    startDiagnosticRunActivityTracking();
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner });
    emitPluginDiagnosticEvent(forgedRequest("normal-1"));
    emitPluginDiagnosticEvent(forgedRequest("normal-2"));
    emitPluginTrustedDiagnosticEvent(forgedRequest("trusted-1"));
    emitPluginTrustedDiagnosticEvent(forgedRequest("trusted-2"));
    emitPluginTrustedDiagnosticEventWithPrivateData(forgedRequest("trusted-private-1"), {
      modelContent: { inputMessages: ["forged"] },
      coreModelRequestStarted: true,
    } as Parameters<typeof emitPluginTrustedDiagnosticEventWithPrivateData>[1]);
    emitPluginTrustedDiagnosticEventWithPrivateData(forgedRequest("trusted-private-2"), {
      modelContent: { inputMessages: ["forged"] },
      coreModelRequestStarted: true,
    } as Parameters<typeof emitPluginTrustedDiagnosticEventWithPrivateData>[1]);
    await waitForDiagnosticEventsDrained();

    expectActivity(ref, {
      activeWorkKind: "embedded_run",
      lastProgressReason: "embedded_run:started",
      repeatedRequestNoProgressAgeMs: undefined,
    });

    emitCoreModelRequestStartedDiagnosticEvent(
      { ...run, callId: "core-1", provider: "core", model: "request-model" },
      owner.generation,
    );
    emitCoreModelRequestStartedDiagnosticEvent(
      { ...run, callId: "core-2", provider: "core", model: "request-model" },
      owner.generation,
    );
    await waitForDiagnosticEventsDrained();

    expectActivity(ref, {
      repeatedRequestNoProgressAgeMs: expect.any(Number),
    });
  });

  it("keeps model endings and tool lifecycle mechanical", async () => {
    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, runId });
    requestTwice({ ...run });

    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      ...run,
      callId: "completed-call",
      provider: "mock",
      model: "request-model",
      observationUnit: "request",
      durationMs: 1,
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.error",
      ...run,
      callId: "error-call",
      provider: "mock",
      model: "request-model",
      observationUnit: "request",
      durationMs: 1,
      errorCategory: "test",
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      ...run,
      toolName: "read",
      toolCallId: "tool-call",
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      ...run,
      toolName: "read",
      toolCallId: "tool-call",
      durationMs: 1,
    });
    await waitForDiagnosticEventsDrained();

    expect(
      getDiagnosticSessionActivitySnapshot(ref).repeatedRequestNoProgressAgeMs,
    ).toBeGreaterThanOrEqual(0);
  });

  it("ignores turn observations and clears request evidence across owner lifecycle", async () => {
    const startedAt = setClock("2026-08-04T01:00:00Z");

    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "first-owner" });
    requestTwice({
      ...ref,
      runId: "first-owner",
      provider: "cli",
      model: "turn-model",
      observationUnit: "turn",
    });
    expectRequestAge(ref, undefined);

    requestTwice({ ...ref, runId: "first-owner" });
    vi.setSystemTime(startedAt + 6 * 60_000);
    expectRequestAge(ref, 6 * 60_000);

    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "replacement-owner" });
    startModel({ ...ref, runId: "first-owner", model: "delayed-request" });
    expectRequestAge(ref, undefined);

    requestTwice({ ...ref, runId: "replacement-owner" });
    vi.setSystemTime(startedAt + 7 * 60_000);
    emitCoreSemanticRunProgressDiagnosticEvent({
      ...ref,
      runId: "first-owner",
      reason: "delayed-old-owner-output",
    });
    await vi.advanceTimersByTimeAsync(0);
    await waitForDiagnosticEventsDrained();
    expectRequestAge(ref, 60_000);
    markDiagnosticEmbeddedRunEnded(ref);
    expectRequestAge(ref, undefined);
  });

  it("keeps replacement-owner evidence across delayed semantic event delivery", async () => {
    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "queued-old-owner" });
    emitCoreSemanticRunProgressDiagnosticEvent({
      ...ref,
      runId: "queued-old-owner",
      reason: "delayed-old-owner-output",
    });

    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "queued-new-owner" });
    requestTwice({ ...ref, runId: "queued-new-owner" });

    await waitForDiagnosticEventsDrained();

    expectRequestProgress(ref, "delayed-old-owner-output");
  });

  it("reserves active-owner semantic progress for the core result boundary", async () => {
    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, runId });
    requestTwice({ ...run });

    emitDiagnosticEvent({
      type: "run.progress",
      ...run,
      reason: "plugin:semantic",
      progressKind: "semantic",
    } as Parameters<typeof emitDiagnosticEvent>[0]);
    await waitForDiagnosticEventsDrained();

    expectRequestProgress(ref, "plugin:semantic");

    emitPluginTrustedDiagnosticEvent({
      type: "run.progress",
      ...run,
      reason: "plugin_trusted:semantic",
      progressKind: "semantic",
      coreSemanticRunProgress: true,
    } as Parameters<typeof emitPluginTrustedDiagnosticEvent>[0]);
    await waitForDiagnosticEventsDrained();

    expectRequestProgress(ref, "plugin_trusted:semantic");

    const obsoleteProvenanceKey = Symbol.for(
      "openclaw.diagnosticSemanticRunProgressProvenance.state.v1",
    );
    const previousObsoleteProvenance = Reflect.get(globalThis, obsoleteProvenanceKey);
    const forgedEvent = {
      type: "run.progress" as const,
      ...run,
      reason: "plugin_trusted:forged_global_semantic",
      progressKind: "semantic" as const,
    };
    const forgedEvents = new WeakSet<object>();
    forgedEvents.add(forgedEvent);
    Reflect.set(globalThis, obsoleteProvenanceKey, {
      marker: obsoleteProvenanceKey,
      events: forgedEvents,
    });
    try {
      emitPluginTrustedDiagnosticEvent(forgedEvent);
      await waitForDiagnosticEventsDrained();
    } finally {
      if (previousObsoleteProvenance === undefined) {
        Reflect.deleteProperty(globalThis, obsoleteProvenanceKey);
      } else {
        Reflect.set(globalThis, obsoleteProvenanceKey, previousObsoleteProvenance);
      }
    }

    expectRequestProgress(ref, "plugin_trusted:forged_global_semantic");

    emitCoreSemanticRunProgressDiagnosticEvent({ ...run, reason: "model_result:semantic" });
    await waitForDiagnosticEventsDrained();

    expectActivity(ref, {
      lastProgressReason: "model_result:semantic",
      repeatedRequestNoProgressAgeMs: undefined,
    });
  });

  it("preserves request evidence for ownerless liveness and blank semantic owners across aliases", async () => {
    const startedAt = setClock("2026-08-04T02:00:00Z");

    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ sessionId, runId });
    requestTwice({ sessionId, runId });
    markDiagnosticRunProgress({ sessionId, sessionKey, reason: "ownerless:liveness" });
    emitCoreSemanticRunProgressDiagnosticEvent({
      sessionId,
      sessionKey,
      runId: "   ",
      reason: "whitespace-owner:semantic",
    });
    await vi.advanceTimersByTimeAsync(0);
    await waitForDiagnosticEventsDrained();

    vi.setSystemTime(startedAt + 6 * 60_000);
    expectRequestProgress(ref, "whitespace-owner:semantic", 6 * 60_000);

    emitCoreSemanticRunProgressDiagnosticEvent({
      sessionKey,
      runId: `  ${runId}  `,
      reason: "owned:semantic",
    });
    await vi.advanceTimersByTimeAsync(0);
    await waitForDiagnosticEventsDrained();
    expectActivity(ref, {
      lastProgressReason: "owned:semantic",
      repeatedRequestNoProgressAgeMs: undefined,
    });
  });

  it("keeps repeated request evidence across same-logical-owner attempt rearming", async () => {
    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, runId });
    startModel({ ...run });

    markDiagnosticEmbeddedRunEnded(ref);
    expectActivity(ref, { activeWorkKind: undefined, repeatedRequestNoProgressAgeMs: undefined });

    emitTrustedDiagnosticEvent({
      type: "run.completed",
      ...run,
      durationMs: 1,
      outcome: "completed",
    });
    await waitForDiagnosticEventsDrained();
    markDiagnosticRunProgress({ runId, reason: "stale-completed-attempt" });
    expectActivity(ref, { lastProgressReason: "run:attempt_completed" });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId });
    startModel({ ...run });
    expectActivity(ref, { hasActiveEmbeddedRun: true });
    expect(
      getDiagnosticSessionActivitySnapshot(ref).repeatedRequestNoProgressAgeMs,
    ).toBeGreaterThanOrEqual(0);

    markDiagnosticEmbeddedRunEnded(ref);
    expectRequestAge(ref, undefined);

    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "successor-run" });
    startModel({ ...ref, runId: "successor-run" });
    expectRequestAge(ref, undefined);

    stopDiagnosticRunActivityTracking();
    startDiagnosticRunActivityTracking();
    expect(getDiagnosticSessionActivitySnapshot(ref)).toEqual({});
  });
});

it.each([
  ["embedded_run", RUN_STALE_TAKEOVER_MS],
  ["tool_call", Math.max(RUN_STALE_TAKEOVER_MS, BLOCKED_TOOL_CALL_ABORT_FLOOR_MS)],
] as const)("uses the stale window for %s", (activeWorkKind, expected) => {
  expect(resolveRunStaleThresholdMs({ activeWorkKind })).toBe(expected);
});
