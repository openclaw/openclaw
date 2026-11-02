import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, test, vi } from "vitest";
import { createAgentCommandLifecycle } from "../agents/command/lifecycle.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getAgentEventExecutionContext } from "./agent-event-execution-context.js";
import {
  type AgentAssistantSourceReceipt,
  type AgentEventPayload,
  type AgentEventRuntimePayload,
  captureAgentRunLifecycleGeneration,
  emitAgentAuditEvent,
  emitAgentEvent,
  emitAgentEventForRunContext,
  emitAgentEventIfCurrent,
  emitAgentEventWithAssistantSourceIfCurrent,
  emitAgentEventForOwner,
  emitAgentRunOutputTokens,
  getAgentEventLifecycleGeneration as readGeneration,
  onAgentAuditEvent,
  onAgentEvent,
  onAgentEventForRun,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
  reserveAgentTerminalEvent,
  rotateAgentEventLifecycleGeneration as rotateGeneration,
  runOncePerAgentRun,
  withAgentRunLifecycleGeneration as withGeneration,
} from "./agent-events.js";
import { registerAgentRunCapacityWait } from "./agent-run-capacity-wait.js";
import {
  claimAgentRunContext as claimRun,
  clearAgentRunContext as clearRun,
  getAgentRunContext as getRun,
  listAgentRunsForSession,
  registerAgentRunContext as registerRun,
  resolveProjectedAgentRunModel,
  releaseAgentRunContext as releaseRun,
  retainQueuedAgentRunContext,
  sweepStaleRunContexts,
} from "./agent-run-registry.js";
import type { AgentRunContext } from "./agent-run-registry.types.js";
import { emitAgentRunStatusEvent } from "./agent-run-status-events.js";

type AgentEventsModule = {
  events: typeof import("./agent-events.js");
  registry: typeof import("./agent-run-registry.js");
};
const agentEventsModuleUrl = new URL("./agent-events.ts", import.meta.url).href;
const agentRunRegistryModuleUrl = new URL("./agent-run-registry.ts", import.meta.url).href;
async function importAgentEventsModule(cacheBust: string): Promise<AgentEventsModule> {
  const [events, registry] = await Promise.all([
    import(`${agentEventsModuleUrl}?t=${cacheBust}`),
    import(`${agentRunRegistryModuleUrl}?t=${cacheBust}`),
  ]);
  return { events, registry };
}

function captureEvents(subscribe = onAgentEvent, publishedOnly = false) {
  const events: AgentEventRuntimePayload[] = [];
  onTestFinished(
    subscribe((event: AgentEventRuntimePayload) => {
      if (!publishedOnly || (event.admitLifecyclePublication?.() ?? true)) {
        events.push(event);
      }
    }),
  );
  return events;
}

function sendEvent(
  runId: string,
  stream: AgentEventPayload["stream"] = "assistant",
  data: Record<string, unknown> = {},
  metadata: Pick<AgentEventPayload, "sessionKey" | "lifecycleGeneration"> = {},
) {
  return emitAgentEventIfCurrent({ runId, stream, data, ...metadata });
}

beforeEach(() => resetAgentEventsForTest());
afterEach(() => {
  vi.restoreAllMocks();
  resetAgentEventsForTest();
});

test("emits typed run startup status with run context", () => {
  registerRun("run", { sessionKey: "session", agentId: "main" });
  const events = captureEvents();
  emitAgentRunStatusEvent({ runId: "run", phase: "preparing_workspace" });
  expect(events).toEqual([
    expect.objectContaining({
      runId: "run",
      seq: 1,
      stream: "run_status",
      sessionKey: "session",
      agentId: "main",
      data: { phase: "preparing_workspace" },
    }),
  ]);
});

test("publishes only projection-relevant run context changes", () => {
  const changed = vi.fn();
  onTestFinished(sessionChanges.subscribe(changed));
  registerRun("run", {
    projectSessionActive: true,
    sessionId: "session-id",
    sessionKey: "agent:main:projected",
  });
  changed.mockClear();
  registerRun("run", { verboseLevel: "full", lastActiveAt: 12_345 });
  expect(changed).not.toHaveBeenCalled();
  expect(getRun("run")).toMatchObject({
    sessionKey: "agent:main:projected",
    verboseLevel: "full",
    lastActiveAt: 12_345,
  });
  for (const update of [{ isControlUiVisible: false }, { projectSessionLifecycle: false }]) {
    registerRun("run", update);
    expect(changed).toHaveBeenCalledExactlyOnceWith({
      sessionKey: "agent:main:projected",
      agentId: undefined,
      scope: "runtime",
    });
    changed.mockClear();
    registerRun("run", update);
    expect(changed).not.toHaveBeenCalled();
  }
});

test("guards cleanup by generation and clears sequences even without a context", () => {
  registerRun("run", { sessionKey: "main" });
  const generation = readGeneration();
  const seen = captureEvents();
  sendEvent("run");
  clearRun("run", "pre-restart");
  expect(getRun("run")?.lifecycleGeneration).toBe(generation);
  sendEvent("run");
  clearRun("run", generation);
  expect(getRun("run")).toBeUndefined();
  sendEvent("run");
  clearRun("run", generation);
  sendEvent("run");
  expect(seen.map((event) => event.seq)).toEqual([1, 2, 1, 1]);
});

test("accumulates output usage across attempts and resets with run context", () => {
  const lifecycleGeneration = readGeneration();
  registerRun("run", { sessionKey: "main", lifecycleGeneration });
  const seen = captureEvents();
  const usage = (outputTokens: number, generation = lifecycleGeneration) =>
    emitAgentRunOutputTokens({ runId: "run", lifecycleGeneration: generation, outputTokens });
  expect(usage(12)).toEqual({ outputTokens: 12 });
  registerRun("run", { sessionKey: "main", lifecycleGeneration });
  usage(8);
  clearRun("run", lifecycleGeneration);
  registerRun("run", { sessionKey: "main", lifecycleGeneration });
  usage(3);
  const nextGeneration = rotateGeneration();
  claimRun("run", { sessionKey: "main", lifecycleGeneration: nextGeneration });
  expect(usage(100)).toBeUndefined();
  usage(4, nextGeneration);
  expect(seen.map((event) => event.data.outputTokens)).toEqual([12, 20, 3, 4]);
});

test("keeps audit-only events private and releases their terminal sequence state", () => {
  const shared = captureEvents();
  const audit = captureEvents(onAgentAuditEvent);
  for (const data of [
    { phase: "start", startedAt: 1_000 },
    { phase: "end" },
    { phase: "start", startedAt: 1_000 },
  ]) {
    emitAgentAuditEvent({
      runId: "audit",
      sessionKey: "agent:main:acp:session",
      stream: "lifecycle",
      data,
    });
  }
  expect(shared).toEqual([]);
  expect(audit.map((event) => event.data.phase)).toEqual(["start", "end", "start"]);
  expect(audit.map((event) => event.seq)).toEqual([1, 2, 1]);
  expect(audit[0]).toMatchObject({
    runId: "audit",
    sessionKey: "agent:main:acp:session",
    stream: "lifecycle",
  });
});

test("preserves sequences through an inner reclaim until the tracked owner exits", () => {
  const context = { sessionKey: "main", lifecycleGeneration: readGeneration() };
  const owner = claimRun("run", context, { trackOwner: true });
  const seen = captureEvents();
  sendEvent("run");
  claimRun("run", { ...context, verboseLevel: "off" });
  sendEvent("run");
  releaseRun("run", owner);
  expect(getRun("run")).toBeUndefined();
  sendEvent("run");
  expect(seen.map((event) => event.seq)).toEqual([1, 2, 1]);
});

test("defers clearing an existing context until all overlapping owners exit", () => {
  const context = { sessionKey: "main", lifecycleGeneration: readGeneration() };
  registerRun("run", context);
  const first = claimRun("run", context, { trackOwner: true });
  const second = claimRun("run", context, { trackOwner: true });
  clearRun("run", context.lifecycleGeneration);
  releaseRun("run", first);
  expect(getRun("run")).toBeDefined();
  releaseRun("run", second);
  expect(getRun("run")).toBeUndefined();
});

test("reserves exclusive run ids for owner-only delivery and cleanup", () => {
  withGeneration(readGeneration(), () => {
    const claimId = claimRun(
      "run",
      { sessionKey: "worker" },
      { exclusive: true, trackOwner: true },
    )!;
    expect(claimRun("run", { sessionKey: "local" }, { trackOwner: true })).toBeUndefined();
    const seen: unknown[] = [];
    onAgentEventForRun("run", ({ data }) => seen.push(data.text));
    const event = (text: string) => ({ runId: "run", stream: "assistant", data: { text } });
    emitAgentEventIfCurrent(event("local"));
    emitAgentEventForOwner(event("worker"), claimId);
    clearRun("run", readGeneration());
    expect(getRun("run")?.sessionKey).toBe("worker");
    releaseRun("run", claimId);
    expect(getRun("run")).toBeUndefined();
    emitAgentEventForOwner(event("late"), claimId);
    expect(seen).toEqual(["worker"]);
    rotateGeneration();
    expect(emitAgentEventIfCurrent(event("rotated"))).toBe(false);
  });
});

test("rejects inherited stale ownership and cannot reclaim the admitted replacement", () => {
  const oldGeneration = readGeneration();
  claimRun("run", { sessionKey: "main", lifecycleGeneration: oldGeneration });
  const seen = captureEvents();
  const lifecycleGeneration = rotateGeneration();
  withGeneration(oldGeneration, () => {
    expect(captureAgentRunLifecycleGeneration("descendant")).toBe(oldGeneration);
    sendEvent("run");
    expect(
      emitAgentEventWithAssistantSourceIfCurrent(
        { runId: "run", stream: "assistant", data: { text: "stale" } },
        {},
      ),
    ).toBe(false);
  });
  claimRun("run", { sessionKey: "new-session", lifecycleGeneration });
  registerRun("run", {
    sessionKey: "old-session",
    lifecycleGeneration: oldGeneration,
    isControlUiVisible: false,
  });
  expect(getRun("run")).toMatchObject({
    sessionKey: "new-session",
    lifecycleGeneration,
  });
  expect(getRun("run")?.isControlUiVisible).toBeUndefined();
  withGeneration(lifecycleGeneration, () => sendEvent("run", "tool", { name: "current" }));
  expect(seen).toMatchObject([{ seq: 1, stream: "tool" }]);
});

test("shares operations across nested fallbacks but not separate admissions", async () => {
  const generation = readGeneration();
  const operation = vi.fn(async () => "claimed");
  const once = () => runOncePerAgentRun("run", "before_agent_reply", operation);
  const results = await withGeneration(generation, async () => [
    await once(),
    await withGeneration(generation, once),
  ]);
  expect(results).toEqual(["claimed", "claimed"]);
  expect(operation).toHaveBeenCalledTimes(1);
  await withGeneration(generation, once);
  expect(operation).toHaveBeenCalledTimes(2);
});

test("lists only runs owned by the current lifecycle", () => {
  claimRun("stale", { sessionKey: "main" });
  const lifecycleGeneration = rotateGeneration();
  claimRun("current", { sessionKey: "main", lifecycleGeneration });
  expect(listAgentRunsForSession({ sessionKey: "main" })).toEqual([
    { runId: "current", lifecycleGeneration },
  ]);
});

test("stamps lifecycle session identity and refreshes it after rotation (#88538)", () => {
  registerRun("run", { sessionKey: "main", sessionId: "old-session" });
  const seen = captureEvents();
  sendEvent("run", "lifecycle", { phase: "error" });
  sendEvent("run", "item");
  registerRun("run", { sessionId: "rotated-session" });
  sendEvent("run", "lifecycle", { phase: "end" });
  expect(seen.map((event) => [event.stream, event.sessionId])).toEqual([
    ["lifecycle", "old-session"],
    ["item", undefined],
    ["lifecycle", "rotated-session"],
  ]);
});

test("rejects lifecycle starts without a finite producer timestamp", () => {
  const seen = captureEvents();
  sendEvent("missing", "lifecycle", { phase: "start" });
  sendEvent("invalid", "lifecycle", { phase: "start", startedAt: Number.NaN });
  sendEvent("valid", "lifecycle", { phase: "start", startedAt: 1_234 });
  expect(seen).toMatchObject([{ runId: "valid", data: { phase: "start", startedAt: 1_234 } }]);
});

test("stamps each overlapping run's own start onto its terminal event", () => {
  registerRun("older", { sessionKey: "shared" });
  registerRun("newer", { sessionKey: "shared" });
  const seen = captureEvents();
  sendEvent("older", "lifecycle", { phase: "start", startedAt: 1_000 });
  sendEvent("newer", "lifecycle", { phase: "start", startedAt: 2_000 });
  sendEvent("older", "lifecycle", { phase: "error", endedAt: 3_000 });
  sendEvent("newer", "lifecycle", { phase: "end", endedAt: 4_000 });
  expect(seen.map((event) => event.runId)).toEqual(["older", "newer", "older", "newer"]);
  expect(seen.map((event) => event.data.phase)).toEqual(["start", "start", "error", "end"]);
  expect(seen.map((event) => event.data.startedAt)).toEqual([1_000, 2_000, 1_000, 2_000]);
});

test("does not invent or replace producer-owned lifecycle start timestamps", () => {
  registerRun("unstarted", { sessionKey: "shared" });
  registerRun("started", { sessionKey: "shared" });
  const seen = captureEvents();
  sendEvent("unstarted", "lifecycle", { phase: "end" });
  sendEvent("started", "lifecycle", { phase: "start", startedAt: 1_000 });
  sendEvent("started", "lifecycle", { phase: "end", startedAt: 1_500 });
  expect(seen[0]?.data).toEqual({ phase: "end" });
  expect(seen[2]?.data.startedAt).toBe(1_500);
});

test("keeps hidden routing private while preserving lifecycle persistence identity", () => {
  const collectDescriptors = vi.spyOn(Object, "defineProperties");
  const defineProperty = vi.spyOn(Object, "defineProperty");
  const privateRouting = {
    mainSessionRestartRecovery: true,
    projectSessionLifecycle: false,
    projectSessionMessages: false,
  } as const;
  registerRun("run", {
    ...privateRouting,
    sessionKey: "main",
    isControlUiVisible: false,
  });
  const received: AgentEventRuntimePayload[] = [];
  onAgentRuntimeEvent((event) => received.push(event));
  const data = { text: "private" };
  const assistantSource: AgentAssistantSourceReceipt = {};
  const assistantProjection = { itemId: "item", text: "display", replace: false };
  const source = { runId: "run", stream: "assistant", data, sessionKey: "main" };
  emitAgentEventWithAssistantSourceIfCurrent(source, assistantSource, assistantProjection);
  const native = { ...source, assistantSource, assistantProjection };
  emitAgentEventIfCurrent(native);
  sendEvent("run", "lifecycle", { phase: "start", startedAt: 1_234 }, { sessionKey: "main" });
  sendEvent("run", "lifecycle", { phase: "error" });
  expect(received.map((event) => event.sessionKey)).toEqual([undefined, undefined, "main", "main"]);
  expect(received[0]?.assistantSource).toBe(assistantSource);
  expect(received[0]?.assistantProjection).toBe(assistantProjection);
  expect(received[1]?.assistantSource).toBeUndefined();
  expect(received[1]?.assistantProjection).toBeUndefined();
  for (const key of ["assistantSource", "assistantProjection"]) {
    expect({ ...received[0] }).not.toHaveProperty(key);
    expect({ ...received[1] }).not.toHaveProperty(key);
  }
  const event = received[2]!;
  expect(event).toMatchObject({
    ...privateRouting,
    lifecycleGeneration: readGeneration(),
  });
  for (const key of ["lifecycleGeneration", ...Object.keys(privateRouting)]) {
    expect(Object.keys(event)).not.toContain(key);
  }
  // Fixed metadata must not allocate an intermediate descriptor collection per delta.
  expect(
    collectDescriptors.mock.calls.filter(([target]) => received.some((entry) => entry === target)),
  ).toHaveLength(0);
  for (const target of received) {
    const descriptors = defineProperty.mock.calls
      .filter(
        ([definedEvent, key]) => definedEvent === target && key !== "admitLifecyclePublication",
      )
      .map((call) => call[2]);
    expect(new Set(descriptors).size).toBe(1);
  }
});

test("shares context, listeners, and sequences across duplicate module instances", async () => {
  const first = await importAgentEventsModule("first");
  const second = await importAgentEventsModule("second");
  first.registry.registerAgentRunContext("run", { sessionKey: "session" });
  const seen = captureEvents(first.events.onAgentEvent);
  const event = { runId: "run", stream: "assistant", data: {}, sessionKey: "   " };
  second.events.emitAgentEvent(event);
  first.events.emitAgentEvent(event);
  expect(second.registry.getAgentRunContext("run")?.sessionKey).toBe("session");
  expect(seen.map((received) => received.seq)).toEqual([1, 2]);
  expect(seen.map((received) => received.sessionKey)).toEqual(["session", "session"]);
});

test("sweeps stale contexts and sequences without clearing active runs", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100);
  registerRun("stale", { sessionKey: "stale", registeredAt: 100 });
  registerRun("active", { sessionKey: "active", registeredAt: 100 });
  clock.mockReturnValue(200);
  sendEvent("stale");
  clock.mockReturnValue(900);
  sendEvent("active");
  clock.mockReturnValue(1_000);
  expect(sweepStaleRunContexts(500)).toBe(1);
  expect(getRun("stale")).toBeUndefined();
  expect(getRun("active")?.sessionKey).toBe("active");
  const seen = captureEvents();
  sendEvent("stale");
  sendEvent("active");
  expect(seen.map((event) => event.runId)).toEqual(["stale", "active"]);
  expect(seen.map((event) => event.seq)).toEqual([1, 2]);
});

test("protects active queue leases while tracked and abandoned owners expire", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100);
  const lifecycleGeneration = readGeneration();
  registerRun("queued", { lifecycleGeneration, registeredAt: 100 });
  registerRun("abandoned", { lifecycleGeneration, registeredAt: 100 });
  claimRun(
    "tracked",
    { lifecycleGeneration, registeredAt: 100 },
    { exclusive: true, ownsContext: true, trackOwner: true },
  );
  const changed = vi.fn();
  onTestFinished(sessionChanges.subscribe(changed));
  const first = retainQueuedAgentRunContext("queued", lifecycleGeneration);
  const second = retainQueuedAgentRunContext("queued", lifecycleGeneration);
  expect(first).toBeTypeOf("function");
  expect(second).toBeTypeOf("function");
  expect(retainQueuedAgentRunContext("missing", lifecycleGeneration)).toBeUndefined();
  expect(retainQueuedAgentRunContext("queued", "stale-generation")).toBeUndefined();
  expect(changed).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "agent-runs" });
  changed.mockClear();
  clock.mockReturnValue(1_000);
  expect(sweepStaleRunContexts(500)).toBe(2);
  expect(changed).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "agent-runs" });
  expect(getRun("queued")).toBeDefined();
  expect(getRun("abandoned")).toBeUndefined();
  expect(getRun("tracked")).toBeUndefined();
  changed.mockClear();
  first?.("admitted");
  first?.("abandoned");
  expect(getRun("queued")?.lastActiveAt).toBe(1_000);
  expect(changed).not.toHaveBeenCalled();
  clock.mockReturnValue(1_501);
  expect(sweepStaleRunContexts(500)).toBe(0);
  expect(changed).not.toHaveBeenCalled();
  second?.("abandoned");
  expect(changed).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "agent-runs" });
  changed.mockClear();
  expect(sweepStaleRunContexts(500)).toBe(1);
  expect(changed).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "agent-runs" });
  expect(getRun("queued")).toBeUndefined();
});

test("never protects a retired lifecycle or refreshes a recycled context", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100);
  const original = readGeneration();
  registerRun("run", { lifecycleGeneration: original, registeredAt: 100 });
  const release = retainQueuedAgentRunContext("run", original);
  clock.mockReturnValue(1_000);
  expect(sweepStaleRunContexts(500)).toBe(0);
  const lifecycleGeneration = rotateGeneration();
  expect(sweepStaleRunContexts(500)).toBe(1);
  claimRun("run", { lifecycleGeneration, registeredAt: 100 });
  release?.("admitted");
  expect(getRun("run")).toMatchObject({ lifecycleGeneration, registeredAt: 100 });
  expect(getRun("run")?.lastActiveAt).toBeUndefined();
  expect(sweepStaleRunContexts(500)).toBe(1);
});

test("shares queue leases across duplicate modules without leaking through resets", async () => {
  const first = await importAgentEventsModule("queued-first");
  const second = await importAgentEventsModule("queued-second");
  const clock = vi.spyOn(Date, "now").mockReturnValue(100);
  const lifecycleGeneration = first.events.getAgentEventLifecycleGeneration();
  first.registry.registerAgentRunContext("run", { lifecycleGeneration, registeredAt: 100 });
  const release = second.registry.retainQueuedAgentRunContext("run", lifecycleGeneration);
  clock.mockReturnValue(1_000);
  expect(first.registry.sweepStaleRunContexts(500)).toBe(0);
  first.events.resetAgentEventsForTest();
  first.registry.registerAgentRunContext("run", { lifecycleGeneration, registeredAt: 100 });
  release?.("admitted");
  expect(first.registry.getAgentRunContext("run")?.lastActiveAt).toBeUndefined();
  expect(first.registry.sweepStaleRunContexts(500)).toBe(1);
});

test("filters by run and keeps a new subscription alive after a stale unsubscribe", () => {
  registerRun("a", { sessionKey: "a" });
  registerRun("b", { sessionKey: "b" });
  const seen: number[] = [];
  const stop = onAgentEventForRun("a", (event) => seen.push(event.seq));
  sendEvent("a");
  sendEvent("b");
  sendEvent("a");
  stop();
  sendEvent("a");
  expect(seen).toEqual([1, 2]);
  onAgentEventForRun("a", (event) => seen.push(event.seq));
  stop();
  sendEvent("a");
  expect(seen).toEqual([1, 2, 4]);
});

test("starts new subscriptions on the next event even when their creator throws", () => {
  const order: string[] = [];
  onAgentEventForRun("run", () => {
    order.push("first");
    onAgentEvent(() => order.push("late"));
    throw new Error("listener failed after registering its successor");
  });
  sendEvent("run");
  expect(order).toEqual(["first"]);
  sendEvent("run");
  expect(order).toEqual(["first", "first", "late"]);
});

test.each(["global", "run"] as const)(
  "deduplicates %s callbacks and preserves unsubscribe handles",
  (scope) => {
    const subscribe = (listener: () => void) =>
      scope === "global" ? onAgentEvent(listener) : onAgentEventForRun("run", listener);
    const seen: string[] = [];
    const listener = () => seen.push("event");
    subscribe(() => {});
    const stopFirst = subscribe(listener);
    const stopDuplicate = subscribe(listener);
    sendEvent("run");
    stopFirst();
    sendEvent("run");
    subscribe(listener);
    stopFirst();
    sendEvent("run");
    stopDuplicate();
    expect(seen).toEqual(["event"]);
  },
);

test("does not reroute an event when a callback changes its run id", () => {
  const order: string[] = [];
  onAgentEventForRun("b", () => order.push("earlier-b"));
  onAgentEventForRun("a", () => order.push("first-a"));
  onAgentEvent((event) => {
    order.push("global");
    event.runId = "b";
  });
  onAgentEventForRun("a", () => order.push("later-a"));
  onAgentEventForRun("b", () => order.push("later-b"));
  sendEvent("a");
  expect(order).toEqual(["first-a", "global", "later-a"]);
});

test("retains independent listener cohorts through nested emissions", () => {
  const order: string[] = [];
  onAgentEventForRun("run", (event) => {
    order.push(`first:${String(event.data.text)}`);
    if (event.data.text === "outer") {
      sendEvent("run", "assistant", { text: "inner" });
    } else {
      onAgentEventForRun("run", (next) => order.push(`new-run:${String(next.data.text)}`));
      onAgentEvent((next) => order.push(`new-global:${String(next.data.text)}`));
    }
  });
  onAgentEvent((event) => order.push(`global:${String(event.data.text)}`));
  sendEvent("run", "assistant", { text: "outer" });
  expect(order).toEqual(["first:outer", "first:inner", "global:inner", "global:outer"]);
});

test("captures runtime delivery before listeners and independently for nested emissions", () => {
  let owner = {};
  const seen: string[] = [];
  const capture = () => {
    const original = owner;
    return () => owner === original;
  };
  onAgentEvent((event) => {
    if (event.data.text === "outer") {
      owner = {};
      onAgentRuntimeEvent((next) => seen.push(`late:${String(next.data.text)}`), capture);
      sendEvent("run", "lifecycle", { phase: "end", text: "inner" });
    }
  });
  onAgentRuntimeEvent((event) => seen.push(`original:${String(event.data.text)}`), capture);
  sendEvent("run", "lifecycle", { phase: "end", text: "outer" });
  expect(seen).toEqual(["original:inner", "late:inner"]);
});

test("skips a removed registration while its replacement starts with the next event", () => {
  const seen: number[] = [];
  const listener = (event: AgentEventPayload) => seen.push(event.seq);
  // Keep the bucket alive when the original registration is removed.
  onAgentEventForRun("run", () => {});
  const remove = onAgentEventForRun("run", listener);
  onAgentRuntimeEvent(
    () => {},
    (event) => {
      if (event.seq === 1) {
        remove();
        onAgentEventForRun("run", listener);
      }
      return () => true;
    },
  );
  sendEvent("run");
  expect(seen).toEqual([]);
  sendEvent("run");
  expect(seen).toEqual([2]);
});

test.each(["capture", "delivery"])("isolates runtime %s failures from other listeners", (phase) => {
  const blocked = vi.fn();
  const seen = captureEvents();
  onAgentRuntimeEvent(blocked, () => {
    const fail = () => {
      throw new Error("retired registration");
    };
    return phase === "capture" ? fail() : fail;
  });
  const later = captureEvents();
  expect(sendEvent("run")).toBe(true);
  expect(blocked).not.toHaveBeenCalled();
  expect(seen).toHaveLength(1);
  expect(later).toHaveLength(1);
});
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

describe("agent event routing after cancellation", () => {
  it.each(["end", "error"])(
    "publishes one aborted %s and suppresses lifecycle events through cleanup",
    async (phase) => {
      const runId = "aborted-run";
      const generation = readGeneration();
      const events = captureEvents(onAgentRuntimeEvent);
      const published = captureEvents(onAgentRuntimeEvent, true);
      const emit = (data: Record<string, unknown>) =>
        emitAgentEventIfCurrent({ runId, stream: "lifecycle", data });
      await withGeneration(generation, async () => {
        registerRun(runId, { sessionKey: "agent:main:aborted" });
        const owner = getRun(runId)!;
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
        await withGeneration(generation, async () => {
          expect(emit({ phase, aborted: true, stopReason: "aborted" })).toBe(true);
        });
        emitModel(runId, owner, null, null);
        expect(owner.activeModel).toBeUndefined();
        clearRun(runId);
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
    registerRun(runId, {});
    onTestFinished(
      onAgentRuntimeEvent((event) => {
        if (event.runId === runId && event.data.phase === "start") {
          sendEvent(runId, "lifecycle", { phase: "end", aborted: true, stopReason: "aborted" });
        }
      }),
    );
    const published = captureEvents(onAgentRuntimeEvent, true);
    sendEvent(runId, "lifecycle", { phase: "start", startedAt: 1 });
    expect(published.map((event) => event.data.phase)).toEqual(["end"]);
  });

  it("keeps retained sequences monotonic through cleanup and fresh registration", () => {
    const runId = "retained-sequence";
    const events = captureEvents(onAgentRuntimeEvent);
    withGeneration(readGeneration(), () => {
      registerRun(runId, {});
      const emit = () => emitAgentEvent({ runId, stream: "tool", data: { phase: "result" } });
      emit();
      emit();
      clearRun(runId);
      emit();
      registerRun(runId, {});
      emit();
      emit();
    });
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps terminal reservations bound to their admitted registration", () => {
    const runId = "reserved-owner";
    const published = captureEvents(onAgentRuntimeEvent, true);
    registerRun(runId, {});
    const stale = reserveAgentTerminalEvent({ runId, lifecycleGeneration: "stale" });
    stale.publish({ phase: "end" });
    sendEvent(runId, "lifecycle", { phase: "start", startedAt: 1 });
    const reserved = reserveAgentTerminalEvent({ runId });
    clearRun(runId);
    registerRun(runId, {});
    reserved.publish({ phase: "end", aborted: true });
    sendEvent(runId, "lifecycle", { phase: "end" });
    expect(published.map((event) => event.data)).toEqual([
      { phase: "start", startedAt: 1 },
      { phase: "end" },
    ]);
  });

  it("keeps retryable errors open until the fallback execution settles", () => {
    const runId = "retry-run";
    const events = captureEvents(onAgentRuntimeEvent, true);
    registerRun(runId, {});
    for (const data of [
      { phase: "start", startedAt: 1 },
      { phase: "error", error: "retryable failure" },
      { phase: "start", startedAt: 2 },
      { phase: "error", error: "final failure", executionSettled: true },
      { phase: "end" },
    ]) {
      sendEvent(runId, "lifecycle", data);
    }
    expect(events.map((event) => event.data.phase)).toEqual(["start", "error", "start", "error"]);
  });

  it.each([
    { name: "visible", hidden: false, messages: true },
    { name: "hidden private", hidden: true, messages: false },
    { name: "hidden session subscribers", hidden: true, messages: true },
  ])("keeps producer routing after context cleanup ($name)", async ({ hidden, messages }) => {
    const runId = "cancelled-run";
    const sessionKey = "agent:delivery:conversation";
    const generation = readGeneration();
    const events = captureEvents(onAgentRuntimeEvent);
    await withGeneration(generation, async () => {
      registerRun(runId, {
        agentId: "delivery",
        sessionKey,
        sessionId: "original-session",
        isControlUiVisible: !hidden,
        projectSessionMessages: messages,
        projectSessionLifecycle: false,
      });
      // Registration follows admission; compaction can rebind before the first event.
      await Promise.resolve();
      registerRun(runId, { sessionId: "compacted-session" });
      const lifecycle = createAgentCommandLifecycle({
        runId,
        lifecycleGeneration: () => generation,
        startedAt: 1,
        state: {
          lifecycleFinishing: false,
          lifecycleEnded: false,
        },
      });
      clearRun(runId);
      expect(getRun(runId)).toBeUndefined();
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
    expect(getRun(runId)).toBeUndefined();
    expect(Object.keys(events[1]!)).not.toContain("controlUiVisible");
    expect(Object.keys(events[1]!)).not.toContain("projectSessionMessages");
  });

  it("shares compaction updates across nested scopes without inheriting a reused run", async () => {
    const generation = readGeneration();
    const events = captureEvents(onAgentRuntimeEvent);
    const emit = () =>
      emitAgentEventIfCurrent({ runId: "shared", stream: "lifecycle", data: { phase: "end" } });
    await withGeneration(generation, async () => {
      registerRun("shared", {
        agentId: "first",
        sessionKey: "agent:first:one",
        sessionId: "before",
      });
      const routing = getAgentEventExecutionContext()
        .getStore()!
        .routingByRun!.get("shared")!.routing;
      for (let index = 0; index < 3; index++) {
        sendEvent("shared", "assistant", { delta: "streamed" });
        expect(
          getAgentEventExecutionContext().getStore()!.routingByRun!.get("shared")!.routing,
        ).toBe(routing);
      }
      events.length = 0;
      await withGeneration(generation, async () => {
        registerRun("shared", { sessionId: "after-compaction" });
        await Promise.resolve();
      });
      clearRun("shared");
      expect(emit()).toBe(true);
      await withGeneration(generation, async () => {
        registerRun("shared", {
          agentId: "second",
          sessionKey: "agent:second:two",
          sessionId: "second-session",
        });
        expect(emit()).toBe(true);
      });
      // The old execution cannot stamp an event with its replacement's live identity.
      expect(emit()).toBe(false);
      clearRun("shared");
    });
    await withGeneration(generation, async () => {
      expect(emit()).toBe(true);
    });
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ agentId: "first", sessionId: "after-compaction" });
    expect(events[1]).toMatchObject({ agentId: "second", sessionId: "second-session" });
    expect(events[2]?.agentId).toBeUndefined();
    expect(events[2]?.sessionKey).toBeUndefined();
  });

  it("extends a retained v2026.9.4 scope without replacing its execution owner", async () => {
    const lifecycleGeneration = readGeneration();
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
    const events = captureEvents(onAgentRuntimeEvent);
    await storage.run(legacy, async () => {
      registerRun("updater", {
        agentId: "delivery",
        sessionKey: "agent:delivery:update",
      });
      await withGeneration(lifecycleGeneration, async () => {
        registerRun("updater", { sessionId: "current-session" });
      });
      clearRun("updater");
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
    const previousGeneration = readGeneration();
    const events = captureEvents(onAgentRuntimeEvent);
    const accepted: boolean[] = [];
    await withGeneration(previousGeneration, async () => {
      registerRun("queued", {
        agentId: "delivery",
        sessionKey: "agent:delivery:queued",
        sessionId: "queued-before",
      });
      const currentGeneration = rotateGeneration();
      await withGeneration(currentGeneration, async () => {
        claimRun("queued", {
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
      clearRun("queued", currentGeneration);
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
  const sessionIdentity = { agentId: "main", sessionId: "model-session" };
  const modelScope = {
    ...sessionIdentity,
    sessionKey: "agent:main:chat",
    projectSessionActive: true,
  } satisfies AgentRunContext;

  test("projects only the executing model for an unscoped session key", () => {
    const scope = { agentId: "main", sessionId: "session", sessionKey: "global" };
    claimRun("admission", scope);
    expect(resolveProjectedAgentRunModel(scope)).toBeNull();
    registerRun("foreground", scope);
    emitModel("foreground", getRun("foreground")!, "provider", "current");
    for (const [runId, extra] of [
      ["queued", {}],
      ["hidden", { isControlUiVisible: false }],
      ["maintenance", { projectSessionLifecycle: false }],
      ["reset", { sessionId: "previous" }],
      ["other-agent", { agentId: "other" }],
    ] as const) {
      registerRun(runId, { ...scope, projectSessionActive: true, ...extra });
    }
    registerAgentRunCapacityWait("queued", readGeneration());
    expect(resolveProjectedAgentRunModel(scope)).toEqual({
      provider: "provider",
      model: "current",
    });
    registerRun("overlap", { ...scope, projectSessionActive: true });
    expect(resolveProjectedAgentRunModel(scope)).toBeNull();
    clearRun("overlap");
    clearRun("foreground");
    expect(resolveProjectedAgentRunModel(scope)).toBeNull();
    clearRun("queued");
    clearRun("admission");
    expect(resolveProjectedAgentRunModel(scope)).toBeUndefined();
  });

  test("projects model events only into their current run owner", () => {
    const runId = "model-run";
    registerRun(runId, modelScope);
    const owner = getRun(runId)!;
    const generation = readGeneration();
    for (const [provider, model] of [
      ["primary", "first"],
      ["fallback", "second"],
    ] as const) {
      emitModel(runId, owner, provider, model);
      expect(getRun(runId)?.activeModel).toEqual({ provider, model });
      expect(resolveProjectedAgentRunModel(sessionIdentity)).toEqual({ provider, model });
    }
    emitModel(runId, owner, null, null);
    expect(getRun(runId)).not.toHaveProperty("activeModel");

    rotateGeneration();
    clearRun(runId, generation);
    registerRun(runId, { sessionKey: "agent:main:replacement" });
    expect(
      emitAgentEventIfCurrent({
        runId,
        lifecycleGeneration: generation,
        stream: "lifecycle",
        data: { phase: "model", provider: "stale", model: "stale" },
      }),
    ).toBe(false);
    expect(getRun(runId)).not.toHaveProperty("activeModel");
  });

  test("ignores model callbacks from a replaced run in the same lifecycle generation", () => {
    const runId = "reused-model-run";
    registerRun(runId, modelScope);
    const replaced = getRun(runId)!;
    clearRun(runId);
    registerRun(runId, modelScope);
    const replacement = getRun(runId)!;
    emitModel(runId, replacement, "current-provider", "current-model");

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "model", provider: "unscoped-provider", model: "unscoped-model" },
    });

    emitModel(runId, replaced, "stale-provider", "stale-model");
    emitModel(runId, replaced, null, null);

    expect(getRun(runId)).toMatchObject({
      activeModel: { provider: "current-provider", model: "current-model" },
    });
  });
});
