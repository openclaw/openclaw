import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, onTestFinished, test, vi } from "vitest";
import { createAgentCommandLifecycle } from "../agents/command/lifecycle.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  emitAgentEvent,
  emitAgentEventForOwner,
  emitAgentEventForRunContext,
  emitAgentEventIfCurrent,
  rotateAgentEventLifecycleGeneration,
  getAgentEventLifecycleGeneration,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
  reserveAgentTerminalEvent,
  withAgentRunLifecycleGeneration,
  type AgentEventRuntimePayload,
} from "./agent-events.js";
import {
  captureAgentRunCapacityWait,
  registerAgentRunCapacityWait,
} from "./agent-run-capacity-wait.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  resolveProjectedAgentRunModel,
  registerAgentRunContext,
  releaseAgentRunContext,
} from "./agent-run-registry.js";
import type { AgentRunContext } from "./agent-run-registry.types.js";

function emitModel(
  runId: string,
  owner: AgentRunContext,
  provider: string | null,
  model: string | null,
) {
  emitAgentEventForRunContext(
    { runId, stream: "lifecycle", data: { phase: "model", provider, model } },
    owner,
  );
}

function captureEvents({ publishedOnly = false } = {}) {
  const events: AgentEventRuntimePayload[] = [];
  onTestFinished(
    onAgentRuntimeEvent((event) => {
      if (!publishedOnly || (event.admitLifecyclePublication?.() ?? true)) {
        events.push(event);
      }
    }),
  );
  return events;
}

describe("agent event routing after cancellation", () => {
  beforeEach(() => resetAgentEventsForTest());

  it.each(["end", "error"])(
    "publishes one aborted %s and suppresses lifecycle events through cleanup",
    async (phase) => {
      const runId = "aborted-run";
      const generation = getAgentEventLifecycleGeneration();
      const events = captureEvents();
      const published = captureEvents({ publishedOnly: true });
      const emit = (data: Record<string, unknown>) =>
        emitAgentEventIfCurrent({ runId, stream: "lifecycle", data });
      await withAgentRunLifecycleGeneration(generation, async () => {
        registerAgentRunContext(runId, { sessionKey: "agent:main:aborted" });
        const owner = getAgentRunContext(runId)!;
        emit({ phase: "start", startedAt: 1 });
        emitModel(runId, owner, "provider", "model");
        onTestFinished(
          onAgentRuntimeEvent((event) => {
            if (event.runId === runId && event.data.phase === phase) {
              emit({ phase: "finishing" });
            }
          }),
        );
        // Cancellation publishes in another scope sharing the same registration.
        await withAgentRunLifecycleGeneration(generation, async () => {
          expect(emit({ phase, aborted: true, stopReason: "aborted" })).toBe(true);
        });
        emitModel(runId, owner, null, null);
        expect(owner.activeModel).toBeUndefined();
        clearAgentRunContext(runId);
        await Promise.resolve();
        expect(
          emit({ phase: "error", aborted: true, stopReason: "aborted", executionSettled: true }),
        ).toBe(true);
        expect(emit({ phase: "start", startedAt: 2 })).toBe(true);
        emitAgentEvent({ runId, stream: "tool", data: { phase: "result", toolCallId: "held" } });
      });
      expect(published.map((event) => [event.stream, event.data.phase])).toEqual([
        ["lifecycle", "start"],
        ["lifecycle", "model"],
        ["lifecycle", phase],
        ["tool", "result"],
      ]);
      expect(events.some((event) => event.data.executionSettled)).toBe(true);
    },
  );

  it("suppresses a lifecycle frame overtaken by a reentrant abort terminal", () => {
    const runId = "reentrant-abort";
    registerAgentRunContext(runId, {});
    onTestFinished(
      onAgentRuntimeEvent((event) => {
        if (event.runId === runId && event.data.phase === "start") {
          emitAgentEvent({
            runId,
            stream: "lifecycle",
            data: { phase: "end", aborted: true, stopReason: "aborted" },
          });
        }
      }),
    );
    const published = captureEvents({ publishedOnly: true });
    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start", startedAt: 1 } });
    expect(published.map((event) => event.data.phase)).toEqual(["end"]);
  });

  it("keeps retained sequences monotonic through cleanup and fresh registration", () => {
    const runId = "retained-sequence";
    const events = captureEvents();
    withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), () => {
      registerAgentRunContext(runId, {});
      const emit = () => emitAgentEvent({ runId, stream: "tool", data: { phase: "result" } });
      emit();
      emit();
      clearAgentRunContext(runId);
      emit();
      registerAgentRunContext(runId, {});
      emit();
      emit();
    });
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps terminal reservations bound to their admitted registration", () => {
    const runId = "reserved-owner";
    const published = captureEvents({ publishedOnly: true });
    registerAgentRunContext(runId, {});
    const stale = reserveAgentTerminalEvent({ runId, lifecycleGeneration: "stale" });
    stale({ phase: "end" });
    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start", startedAt: 1 } });
    const reserved = reserveAgentTerminalEvent({ runId });
    clearAgentRunContext(runId);
    registerAgentRunContext(runId, {});
    reserved({ phase: "end", aborted: true });
    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
    expect(published.map((event) => event.data)).toEqual([
      { phase: "start", startedAt: 1 },
      { phase: "end" },
    ]);
  });

  it("keeps retryable errors open until the fallback execution settles", () => {
    const runId = "retry-run";
    const events = captureEvents({ publishedOnly: true });
    registerAgentRunContext(runId, {});
    for (const data of [
      { phase: "start", startedAt: 1 },
      { phase: "error", error: "retryable failure" },
      { phase: "start", startedAt: 2 },
      { phase: "error", error: "final failure", executionSettled: true },
      { phase: "end" },
    ]) {
      emitAgentEvent({ runId, stream: "lifecycle", data });
    }
    expect(events.map((event) => event.data.phase)).toEqual(["start", "error", "start", "error"]);
  });

  test("capacity clocks and releases cannot borrow a same-epoch replacement context", () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const runId = "capacity-clock-run";
    const generation = getAgentEventLifecycleGeneration();
    const scope = {
      sessionKey: "agent:main:capacity",
      sessionId: "capacity-session",
      lifecycleGeneration: generation,
    };
    try {
      registerAgentRunContext(runId, scope);
      const oldClock = captureAgentRunCapacityWait(runId, generation);
      const oldRelease = registerAgentRunCapacityWait(runId, generation);
      now += 10_000;
      expect(oldClock()).toEqual({ waiting: true, elapsedMs: 10_000 });
      clearAgentRunContext(runId);
      registerAgentRunContext(runId, scope);
      const currentClock = captureAgentRunCapacityWait(runId, generation);
      const currentRelease = registerAgentRunCapacityWait(runId, generation);
      now += 5_000;
      oldRelease?.();
      expect(oldClock()).toBeUndefined();
      expect(currentClock()).toEqual({ waiting: true, elapsedMs: 5_000 });
      currentRelease?.();
      expect(currentClock()).toEqual({ waiting: false, elapsedMs: 5_000 });
    } finally {
      clearAgentRunContext(runId);
      clock.mockRestore();
    }
  });

  it.each([
    { name: "visible", hidden: false, messages: true },
    { name: "hidden private", hidden: true, messages: false },
    { name: "hidden session subscribers", hidden: true, messages: true },
  ])("keeps producer routing after context cleanup ($name)", async ({ hidden, messages }) => {
    const runId = "cancelled-run";
    const sessionKey = "agent:delivery:conversation";
    const generation = getAgentEventLifecycleGeneration();
    const events = captureEvents();
    await withAgentRunLifecycleGeneration(generation, async () => {
      registerAgentRunContext(runId, {
        agentId: "delivery",
        sessionKey,
        sessionId: "original-session",
        isControlUiVisible: !hidden,
        projectSessionMessages: messages,
        projectSessionLifecycle: false,
      });
      // Registration follows admission; compaction can rebind before the first event.
      await Promise.resolve();
      registerAgentRunContext(runId, { sessionId: "compacted-session" });
      const lifecycle = createAgentCommandLifecycle({
        runId,
        lifecycleGeneration: () => generation,
        startedAt: 1,
        state: {
          currentTurnUserMessagePersisted: true,
          lifecycleFinishing: false,
          lifecycleEnded: false,
        },
      });
      clearAgentRunContext(runId);
      expect(getAgentRunContext(runId)).toBeUndefined();
      emitAgentEvent({ runId, stream: "tool", data: { phase: "result", toolCallId: "held" } });
      lifecycle.emitBasicError(new Error("cancelled"), { aborted: true, stopReason: "rpc" });
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ agentId: "delivery", controlUiVisible: !hidden });
    expect(events[0]?.sessionKey).toBe(hidden ? undefined : sessionKey);
    expect(events[0]?.deliverySessionKey).toBe(hidden ? sessionKey : undefined);
    expect(events[0]?.projectSessionMessages).toBe(messages);
    const serialized = JSON.stringify(events[0]);
    const wire = JSON.parse(serialized);
    expect(wire).not.toHaveProperty("deliverySessionKey");
    if (hidden) {
      expect(wire).not.toHaveProperty("sessionKey");
    }
    expect(events[1]).toMatchObject({
      agentId: "delivery",
      sessionKey,
      sessionId: "compacted-session",
      controlUiVisible: !hidden,
      projectSessionMessages: messages,
      projectSessionLifecycle: false,
      data: { executionSettled: true, aborted: true, stopReason: "rpc" },
    });
    expect(getAgentRunContext(runId)).toBeUndefined();
    expect(Object.keys(events[1]!)).not.toContain("controlUiVisible");
    expect(Object.keys(events[1]!)).not.toContain("projectSessionMessages");
  });

  it("shares compaction updates across nested scopes without inheriting a reused run", async () => {
    const generation = getAgentEventLifecycleGeneration();
    const events = captureEvents();
    const emit = () =>
      emitAgentEventIfCurrent({ runId: "shared", stream: "lifecycle", data: { phase: "end" } });
    await withAgentRunLifecycleGeneration(generation, async () => {
      registerAgentRunContext("shared", {
        agentId: "first",
        sessionKey: "agent:first:one",
        sessionId: "before",
      });
      await withAgentRunLifecycleGeneration(generation, async () => {
        registerAgentRunContext("shared", { sessionId: "after-compaction" });
        await Promise.resolve();
      });
      clearAgentRunContext("shared");
      expect(emit()).toBe(true);
      await withAgentRunLifecycleGeneration(generation, async () => {
        registerAgentRunContext("shared", {
          agentId: "second",
          sessionKey: "agent:second:two",
          sessionId: "second-session",
        });
        expect(emit()).toBe(true);
      });
      // The old execution cannot stamp an event with its replacement's live identity.
      expect(emit()).toBe(false);
      clearAgentRunContext("shared");
    });
    await withAgentRunLifecycleGeneration(generation, async () => {
      expect(emit()).toBe(true);
    });
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ agentId: "first", sessionId: "after-compaction" });
    expect(events[1]).toMatchObject({ agentId: "second", sessionId: "second-session" });
    expect(events[2]?.agentId).toBeUndefined();
    expect(events[2]?.sessionKey).toBeUndefined();
  });

  it("never lets routing provenance revive a released claim or rotated execution", () => {
    const generation = getAgentEventLifecycleGeneration();
    const events = captureEvents();
    withAgentRunLifecycleGeneration(generation, () => {
      const claim = claimAgentRunContext(
        "owned",
        { agentId: "delivery", sessionKey: "agent:delivery:owned" },
        { exclusive: true, trackOwner: true, ownsContext: true },
      );
      expect(claim).toBeDefined();
      const event = { runId: "owned", stream: "tool", data: { phase: "result" } };
      emitAgentEventForOwner(event, claim!);
      clearAgentRunContext("owned", generation, claim);
      releaseAgentRunContext("owned", claim);
      expect(getAgentRunContext("owned")).toBeUndefined();
      emitAgentEventForOwner(event, claim!);
      rotateAgentEventLifecycleGeneration();
      expect(emitAgentEventIfCurrent(event)).toBe(false);
    });
    expect(events).toHaveLength(1);
  });

  it("extends a retained v2026.9.4 scope without replacing its execution owner", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    // Released updaters can retain this exact shape while loading current runtime aliases.
    const storage = resolveGlobalSingleton(
      Symbol.for("openclaw.agentEvents.executionContext"),
      () =>
        new AsyncLocalStorage<{
          lifecycleGeneration: string;
          onceByRun: Map<string, Promise<unknown>>;
        }>(),
    );
    const legacy = { lifecycleGeneration, onceByRun: new Map<string, Promise<unknown>>() };
    const events = captureEvents();
    await storage.run(legacy, async () => {
      registerAgentRunContext("updater", {
        agentId: "delivery",
        sessionKey: "agent:delivery:update",
      });
      await withAgentRunLifecycleGeneration(lifecycleGeneration, async () => {
        registerAgentRunContext("updater", { sessionId: "current-session" });
      });
      clearAgentRunContext("updater");
      emitAgentEvent({ runId: "updater", stream: "lifecycle", data: { phase: "end" } });
      expect(storage.getStore()).toBe(legacy);
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agentId: "delivery",
      sessionKey: "agent:delivery:update",
      sessionId: "current-session",
    });
  });

  it("routes outer settlement after an admitted queued generation handoff", async () => {
    const previousGeneration = getAgentEventLifecycleGeneration();
    const events = captureEvents();
    const accepted: boolean[] = [];
    await withAgentRunLifecycleGeneration(previousGeneration, async () => {
      registerAgentRunContext("queued", {
        agentId: "delivery",
        sessionKey: "agent:delivery:queued",
        sessionId: "queued-before",
      });
      const currentGeneration = rotateAgentEventLifecycleGeneration();
      await withAgentRunLifecycleGeneration(currentGeneration, async () => {
        claimAgentRunContext("queued", {
          agentId: "delivery",
          sessionKey: "agent:delivery:queued",
          sessionId: "admitted-after",
          lifecycleGeneration: currentGeneration,
        });
      });
      const terminal = {
        runId: "queued",
        lifecycleGeneration: currentGeneration,
        stream: "lifecycle",
        data: { phase: "end", executionSettled: true },
      };
      accepted.push(emitAgentEventIfCurrent(terminal));
      clearAgentRunContext("queued", currentGeneration);
      accepted.push(emitAgentEventIfCurrent(terminal));
      expect(emitAgentEventIfCurrent({ runId: "queued", stream: "tool", data: {} })).toBe(false);
    });
    expect(accepted).toEqual([true, true]);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({
        agentId: "delivery",
        sessionKey: "agent:delivery:queued",
        sessionId: "admitted-after",
      });
    }
  });
});

describe("live agent model projection", () => {
  beforeEach(() => resetAgentEventsForTest());
  test("projects only the executing model for an unscoped session key", () => {
    const scope = { agentId: "main", sessionId: "session", sessionKey: "global" };
    claimAgentRunContext("admission", scope);
    expect(resolveProjectedAgentRunModel(scope)).toBeNull();
    registerAgentRunContext("foreground", scope);
    emitModel("foreground", getAgentRunContext("foreground")!, "provider", "current");
    for (const [runId, extra] of [
      ["queued", {}],
      ["hidden", { isControlUiVisible: false }],
      ["maintenance", { projectSessionLifecycle: false }],
      ["reset", { sessionId: "previous" }],
      ["other-agent", { agentId: "other" }],
    ] as const) {
      registerAgentRunContext(runId, { ...scope, projectSessionActive: true, ...extra });
    }
    registerAgentRunCapacityWait("queued", getAgentEventLifecycleGeneration());
    expect(resolveProjectedAgentRunModel(scope)).toEqual({
      provider: "provider",
      model: "current",
    });
    registerAgentRunContext("overlap", { ...scope, projectSessionActive: true });
    expect(resolveProjectedAgentRunModel(scope)).toBeNull();
    clearAgentRunContext("overlap");
    clearAgentRunContext("foreground");
    expect(resolveProjectedAgentRunModel(scope)).toBeNull();
    clearAgentRunContext("queued");
    clearAgentRunContext("admission");
    expect(resolveProjectedAgentRunModel(scope)).toBeUndefined();
  });

  test("projects model events only into their current run owner", () => {
    const runId = "model-run";
    registerAgentRunContext(runId, {
      agentId: "main",
      sessionKey: "agent:main:chat",
      sessionId: "model-session",
      projectSessionActive: true,
    });
    const owner = getAgentRunContext(runId)!;
    const generation = getAgentEventLifecycleGeneration();
    emitModel(runId, owner, "primary", "first");
    expect(getAgentRunContext(runId)).toMatchObject({
      activeModel: { provider: "primary", model: "first" },
    });
    expect(resolveProjectedAgentRunModel({ agentId: "main", sessionId: "model-session" })).toEqual({
      provider: "primary",
      model: "first",
    });
    emitModel(runId, owner, "fallback", "second");
    expect(getAgentRunContext(runId)).toMatchObject({
      activeModel: { provider: "fallback", model: "second" },
    });
    emitModel(runId, owner, null, null);
    expect(getAgentRunContext(runId)).not.toHaveProperty("activeModel");

    rotateAgentEventLifecycleGeneration();
    clearAgentRunContext(runId, generation);
    registerAgentRunContext(runId, { sessionKey: "agent:main:replacement" });
    emitAgentEvent({
      runId,
      lifecycleGeneration: generation,
      stream: "lifecycle",
      data: { phase: "model", provider: "stale", model: "stale" },
    });
    expect(getAgentRunContext(runId)).not.toHaveProperty("activeModel");
  });

  test("ignores model callbacks from a replaced run in the same lifecycle generation", () => {
    const runId = "reused-model-run";
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:chat",
      sessionId: "model-session",
      projectSessionActive: true,
    };
    registerAgentRunContext(runId, scope);
    const replaced = getAgentRunContext(runId)!;
    clearAgentRunContext(runId);
    registerAgentRunContext(runId, scope);
    const replacement = getAgentRunContext(runId)!;
    emitModel(runId, replacement, "current-provider", "current-model");

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "model", provider: "unscoped-provider", model: "unscoped-model" },
    });

    for (const data of [
      { phase: "model", provider: "stale-provider", model: "stale-model" },
      { phase: "model", provider: null, model: null },
    ] as const) {
      emitAgentEventForRunContext({ runId, stream: "lifecycle", data }, replaced);
    }

    expect(getAgentRunContext(runId)).toMatchObject({
      activeModel: { provider: "current-provider", model: "current-model" },
    });
  });
});
