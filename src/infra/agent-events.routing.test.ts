import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it } from "vitest";
import { createAgentCommandLifecycle } from "../agents/command/lifecycle.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  emitAgentEvent,
  emitAgentEventForOwner,
  emitAgentEventIfCurrent,
  rotateAgentEventLifecycleGeneration,
  getAgentEventLifecycleGeneration,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
  withAgentRunLifecycleGeneration,
  type AgentEventRuntimePayload,
} from "./agent-events.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunContext,
} from "./agent-run-registry.js";

describe("agent event routing after cancellation", () => {
  beforeEach(() => resetAgentEventsForTest());

  it.each([
    { name: "visible", hidden: false, messages: true },
    { name: "hidden private", hidden: true, messages: false },
    { name: "hidden session subscribers", hidden: true, messages: true },
  ])("keeps producer routing after context cleanup ($name)", async ({ hidden, messages }) => {
    const runId = "cancelled-run";
    const sessionKey = "agent:delivery:conversation";
    const generation = getAgentEventLifecycleGeneration();
    const events: AgentEventRuntimePayload[] = [];
    const unsubscribe = onAgentRuntimeEvent((event) => events.push(event));
    try {
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
    } finally {
      unsubscribe();
    }
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
    const events: AgentEventRuntimePayload[] = [];
    const unsubscribe = onAgentRuntimeEvent((event) => events.push(event));
    const emit = () =>
      emitAgentEventIfCurrent({ runId: "shared", stream: "lifecycle", data: { phase: "end" } });
    try {
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
    } finally {
      unsubscribe();
    }
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ agentId: "first", sessionId: "after-compaction" });
    expect(events[1]).toMatchObject({ agentId: "second", sessionId: "second-session" });
    expect(events[2]?.agentId).toBeUndefined();
    expect(events[2]?.sessionKey).toBeUndefined();
  });

  it("never lets routing provenance revive a released claim or rotated execution", () => {
    const generation = getAgentEventLifecycleGeneration();
    const events: AgentEventRuntimePayload[] = [];
    const unsubscribe = onAgentRuntimeEvent((event) => events.push(event));
    try {
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
    } finally {
      unsubscribe();
    }
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
    const events: AgentEventRuntimePayload[] = [];
    const unsubscribe = onAgentRuntimeEvent((event) => events.push(event));
    try {
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
    } finally {
      unsubscribe();
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agentId: "delivery",
      sessionKey: "agent:delivery:update",
      sessionId: "current-session",
    });
  });

  it("routes outer settlement after an admitted queued generation handoff", async () => {
    const previousGeneration = getAgentEventLifecycleGeneration();
    const events: AgentEventRuntimePayload[] = [];
    const unsubscribe = onAgentRuntimeEvent((event) => events.push(event));
    const accepted: boolean[] = [];
    try {
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
    } finally {
      unsubscribe();
    }
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
