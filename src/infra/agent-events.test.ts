import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  type AgentEventPayload,
  type AgentEventRuntimePayload,
  captureAgentRunLifecycleGeneration,
  emitAgentAuditEvent,
  emitAgentEventIfCurrent,
  emitAgentEventForOwner,
  emitAgentRunOutputTokens,
  getAgentEventLifecycleGeneration,
  onAgentAuditEvent,
  onAgentEvent,
  onAgentEventForRun,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
  runOncePerAgentRun,
  withAgentRunLifecycleGeneration,
} from "./agent-events.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  listAgentRunsForSession,
  registerAgentRunContext,
  releaseAgentRunContext,
  retainQueuedAgentRunContext,
  sweepStaleRunContexts,
} from "./agent-run-registry.js";
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

function captureEvents(subscribe = onAgentEvent) {
  const events: AgentEventPayload[] = [];
  onTestFinished(subscribe((event) => events.push(event)));
  return events;
}

function emit(
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
  registerAgentRunContext("run", { sessionKey: "session", agentId: "main" });
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
  registerAgentRunContext("run", {
    projectSessionActive: true,
    sessionId: "session-id",
    sessionKey: "agent:main:projected",
  });
  changed.mockClear();
  registerAgentRunContext("run", { verboseLevel: "full", isHeartbeat: true, lastActiveAt: 12_345 });
  expect(changed).not.toHaveBeenCalled();
  expect(getAgentRunContext("run")).toMatchObject({
    sessionKey: "agent:main:projected",
    verboseLevel: "full",
    isHeartbeat: true,
    lastActiveAt: 12_345,
  });
  for (const update of [{ isControlUiVisible: false }, { projectSessionLifecycle: false }]) {
    registerAgentRunContext("run", update);
    expect(changed).toHaveBeenCalledExactlyOnceWith({
      sessionKey: "agent:main:projected",
      agentId: undefined,
      scope: "runtime",
    });
    changed.mockClear();
    registerAgentRunContext("run", update);
    expect(changed).not.toHaveBeenCalled();
  }
});

test("guards cleanup by generation and clears sequences even without a context", () => {
  registerAgentRunContext("run", { sessionKey: "main" });
  const generation = getAgentEventLifecycleGeneration();
  const seen = captureEvents();
  emit("run");
  clearAgentRunContext("run", "pre-restart");
  expect(getAgentRunContext("run")?.lifecycleGeneration).toBe(generation);
  emit("run");
  clearAgentRunContext("run", generation);
  expect(getAgentRunContext("run")).toBeUndefined();
  emit("run");
  clearAgentRunContext("run", generation);
  emit("run");
  expect(seen.map((event) => event.seq)).toEqual([1, 2, 1, 1]);
});

test("accumulates output usage across attempts and resets with run context", () => {
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  registerAgentRunContext("run", { sessionKey: "main", lifecycleGeneration });
  const seen = captureEvents();
  const usage = (outputTokens: number, generation = lifecycleGeneration) =>
    emitAgentRunOutputTokens({ runId: "run", lifecycleGeneration: generation, outputTokens });
  expect(usage(12)).toEqual({ outputTokens: 12 });
  registerAgentRunContext("run", { sessionKey: "main", lifecycleGeneration });
  usage(8);
  clearAgentRunContext("run", lifecycleGeneration);
  registerAgentRunContext("run", { sessionKey: "main", lifecycleGeneration });
  usage(3);
  const nextGeneration = rotateAgentEventLifecycleGeneration();
  claimAgentRunContext("run", { sessionKey: "main", lifecycleGeneration: nextGeneration });
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
  expect(audit.map((event) => [event.data.phase, event.seq])).toEqual([
    ["start", 1],
    ["end", 2],
    ["start", 1],
  ]);
  expect(audit[0]).toMatchObject({
    runId: "audit",
    sessionKey: "agent:main:acp:session",
    stream: "lifecycle",
  });
});

test("preserves sequences through an inner reclaim until the tracked owner exits", () => {
  const context = { sessionKey: "main", lifecycleGeneration: getAgentEventLifecycleGeneration() };
  const owner = claimAgentRunContext("run", context, { trackOwner: true });
  const seen = captureEvents();
  emit("run");
  claimAgentRunContext("run", { ...context, verboseLevel: "off" });
  emit("run");
  releaseAgentRunContext("run", owner);
  expect(getAgentRunContext("run")).toBeUndefined();
  emit("run");
  expect(seen.map((event) => event.seq)).toEqual([1, 2, 1]);
});

test("defers clearing an existing context until all overlapping owners exit", () => {
  const context = { sessionKey: "main", lifecycleGeneration: getAgentEventLifecycleGeneration() };
  registerAgentRunContext("run", context);
  const first = claimAgentRunContext("run", context, { trackOwner: true });
  const second = claimAgentRunContext("run", context, { trackOwner: true });
  clearAgentRunContext("run", context.lifecycleGeneration);
  releaseAgentRunContext("run", first);
  expect(getAgentRunContext("run")).toBeDefined();
  releaseAgentRunContext("run", second);
  expect(getAgentRunContext("run")).toBeUndefined();
});

test("reserves exclusive run ids for owner-only delivery and cleanup", () => {
  const claimId = claimAgentRunContext(
    "run",
    { sessionKey: "worker" },
    { exclusive: true, trackOwner: true },
  )!;
  expect(
    claimAgentRunContext("run", { sessionKey: "local" }, { trackOwner: true }),
  ).toBeUndefined();
  const seen: unknown[] = [];
  onAgentEventForRun("run", ({ data }) => seen.push(data.text));
  const event = (text: string) => ({ runId: "run", stream: "assistant", data: { text } });
  emitAgentEventIfCurrent(event("local"));
  emitAgentEventForOwner(event("worker"), claimId);
  clearAgentRunContext("run", getAgentEventLifecycleGeneration());
  expect(getAgentRunContext("run")?.sessionKey).toBe("worker");
  releaseAgentRunContext("run", claimId);
  expect(getAgentRunContext("run")).toBeUndefined();
  emitAgentEventForOwner(event("late"), claimId);
  expect(seen).toEqual(["worker"]);
});

test("explicitly adopts only an unowned same-generation context", () => {
  const context = {
    agentId: "main",
    isControlUiVisible: false,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    sessionId: "session-adopted",
    sessionKey: "agent:main:adopted",
  };
  registerAgentRunContext("run", context);
  const options = {
    adoptExistingUnowned: true,
    exclusive: true,
    ownsContext: true,
    trackOwner: true,
  };
  const claim = claimAgentRunContext("run", context, options);
  expect(claim).toBeDefined();
  expect(claimAgentRunContext("run", context, options)).toBeUndefined();
  releaseAgentRunContext("run", claim);
  expect(getAgentRunContext("run")).toBeUndefined();
});

test("drops stale explicit-generation events before shared listeners", () => {
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  registerAgentRunContext("run", { sessionKey: "main", lifecycleGeneration });
  const seen = captureEvents();
  expect(emit("run", "lifecycle", { phase: "end" }, { lifecycleGeneration: "pre-restart" })).toBe(
    false,
  );
  expect(
    emit("run", "lifecycle", { phase: "start", startedAt: 1_000 }, { lifecycleGeneration }),
  ).toBe(true);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ seq: 1, data: { phase: "start" } });
});

test("rejects inherited stale ownership and cannot reclaim the admitted replacement", () => {
  const oldGeneration = getAgentEventLifecycleGeneration();
  claimAgentRunContext("run", { sessionKey: "main", lifecycleGeneration: oldGeneration });
  const seen = captureEvents();
  const lifecycleGeneration = rotateAgentEventLifecycleGeneration();
  withAgentRunLifecycleGeneration(oldGeneration, () => {
    expect(captureAgentRunLifecycleGeneration("descendant")).toBe(oldGeneration);
    emit("run");
  });
  claimAgentRunContext("run", { sessionKey: "new-session", lifecycleGeneration });
  registerAgentRunContext("run", {
    sessionKey: "old-session",
    lifecycleGeneration: oldGeneration,
    isControlUiVisible: false,
  });
  expect(getAgentRunContext("run")).toMatchObject({
    sessionKey: "new-session",
    lifecycleGeneration,
  });
  expect(getAgentRunContext("run")?.isControlUiVisible).toBeUndefined();
  withAgentRunLifecycleGeneration(lifecycleGeneration, () =>
    emit("run", "tool", { name: "current" }),
  );
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ seq: 1, stream: "tool" });
});

test("shares operations across nested fallbacks but not separate admissions", async () => {
  const generation = getAgentEventLifecycleGeneration();
  const operation = vi.fn(async () => "claimed");
  const once = () => runOncePerAgentRun("run", "before_agent_reply", operation);
  const results = await withAgentRunLifecycleGeneration(generation, async () => [
    await once(),
    await withAgentRunLifecycleGeneration(generation, once),
  ]);
  expect(results).toEqual(["claimed", "claimed"]);
  expect(operation).toHaveBeenCalledTimes(1);
  await withAgentRunLifecycleGeneration(generation, once);
  expect(operation).toHaveBeenCalledTimes(2);
});

test("lists only runs owned by the current lifecycle", () => {
  claimAgentRunContext("stale", { sessionKey: "main" });
  const lifecycleGeneration = rotateAgentEventLifecycleGeneration();
  claimAgentRunContext("current", { sessionKey: "main", lifecycleGeneration });
  expect(listAgentRunsForSession({ sessionKey: "main" })).toEqual([
    { runId: "current", lifecycleGeneration },
  ]);
});

test("stamps lifecycle session identity and refreshes it after rotation (#88538)", () => {
  registerAgentRunContext("run", { sessionKey: "main", sessionId: "old-session" });
  const seen = captureEvents();
  emit("run", "lifecycle", { phase: "error" });
  emit("run", "item");
  registerAgentRunContext("run", { sessionId: "rotated-session" });
  emit("run", "lifecycle", { phase: "end" });
  expect(seen.map((event) => [event.stream, event.sessionId])).toEqual([
    ["lifecycle", "old-session"],
    ["item", undefined],
    ["lifecycle", "rotated-session"],
  ]);
});

test("rejects lifecycle starts without a finite producer timestamp", () => {
  const seen = captureEvents();
  emit("missing", "lifecycle", { phase: "start" });
  emit("invalid", "lifecycle", { phase: "start", startedAt: Number.NaN });
  emit("valid", "lifecycle", { phase: "start", startedAt: 1_234 });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ runId: "valid", data: { phase: "start", startedAt: 1_234 } });
});

test("stamps each overlapping run's own start onto its terminal event", () => {
  registerAgentRunContext("older", { sessionKey: "shared" });
  registerAgentRunContext("newer", { sessionKey: "shared" });
  const seen = captureEvents();
  emit("older", "lifecycle", { phase: "start", startedAt: 1_000 });
  emit("newer", "lifecycle", { phase: "start", startedAt: 2_000 });
  emit("older", "lifecycle", { phase: "error", endedAt: 3_000 });
  emit("newer", "lifecycle", { phase: "end", endedAt: 4_000 });
  expect(seen.map((event) => [event.runId, event.data.phase, event.data.startedAt])).toEqual([
    ["older", "start", 1_000],
    ["newer", "start", 2_000],
    ["older", "error", 1_000],
    ["newer", "end", 2_000],
  ]);
});

test("does not invent or replace producer-owned lifecycle start timestamps", () => {
  registerAgentRunContext("unstarted", { sessionKey: "shared" });
  registerAgentRunContext("started", { sessionKey: "shared" });
  const seen = captureEvents();
  emit("unstarted", "lifecycle", { phase: "end" });
  emit("started", "lifecycle", { phase: "start", startedAt: 1_000 });
  emit("started", "lifecycle", { phase: "end", startedAt: 1_500 });
  expect(seen[0]?.data).toEqual({ phase: "end" });
  expect(seen[2]?.data.startedAt).toBe(1_500);
});

test("keeps hidden routing private while preserving lifecycle persistence identity", () => {
  registerAgentRunContext("run", {
    mainSessionRestartRecovery: true,
    projectSessionLifecycle: false,
    projectSessionMessages: false,
    sessionKey: "main",
    isControlUiVisible: false,
  });
  const received: AgentEventRuntimePayload[] = [];
  onAgentRuntimeEvent((event) => received.push(event));
  emit("run", "assistant", { text: "private" }, { sessionKey: "main" });
  emit("run", "lifecycle", { phase: "start", startedAt: 1_234 }, { sessionKey: "main" });
  emit("run", "lifecycle", { phase: "error" });
  expect(received.map((event) => event.sessionKey)).toEqual([undefined, "main", "main"]);
  const event = received[1]!;
  expect(event).toMatchObject({
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    projectSessionLifecycle: false,
    projectSessionMessages: false,
    mainSessionRestartRecovery: true,
  });
  expect(Object.keys(event)).not.toContain("lifecycleGeneration");
  for (const key of [
    "projectSessionLifecycle",
    "projectSessionMessages",
    "mainSessionRestartRecovery",
  ]) {
    expect(Object.keys(event)).not.toContain(key);
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
  expect(seen.map(({ seq, sessionKey }) => ({ seq, sessionKey }))).toEqual([
    { seq: 1, sessionKey: "session" },
    { seq: 2, sessionKey: "session" },
  ]);
});

test("sweeps stale contexts and sequences without clearing active runs", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100);
  registerAgentRunContext("stale", { sessionKey: "stale", registeredAt: 100 });
  registerAgentRunContext("active", { sessionKey: "active", registeredAt: 100 });
  clock.mockReturnValue(200);
  emit("stale");
  clock.mockReturnValue(900);
  emit("active");
  clock.mockReturnValue(1_000);
  expect(sweepStaleRunContexts(500)).toBe(1);
  expect(getAgentRunContext("stale")).toBeUndefined();
  expect(getAgentRunContext("active")?.sessionKey).toBe("active");
  const seen = captureEvents();
  emit("stale");
  emit("active");
  expect(seen.map((event) => [event.runId, event.seq])).toEqual([
    ["stale", 1],
    ["active", 2],
  ]);
});

test("protects active queue leases while tracked and abandoned owners expire", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100);
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  registerAgentRunContext("queued", { lifecycleGeneration, registeredAt: 100 });
  registerAgentRunContext("abandoned", { lifecycleGeneration, registeredAt: 100 });
  claimAgentRunContext(
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
  expect(getAgentRunContext("queued")).toBeDefined();
  expect(getAgentRunContext("abandoned")).toBeUndefined();
  expect(getAgentRunContext("tracked")).toBeUndefined();
  changed.mockClear();
  first?.("admitted");
  first?.("abandoned");
  expect(getAgentRunContext("queued")?.lastActiveAt).toBe(1_000);
  expect(changed).not.toHaveBeenCalled();
  clock.mockReturnValue(1_501);
  expect(sweepStaleRunContexts(500)).toBe(0);
  expect(changed).not.toHaveBeenCalled();
  second?.("abandoned");
  expect(changed).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "agent-runs" });
  changed.mockClear();
  expect(sweepStaleRunContexts(500)).toBe(1);
  expect(changed).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "agent-runs" });
  expect(getAgentRunContext("queued")).toBeUndefined();
});

test("never protects a retired lifecycle or refreshes a recycled context", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100);
  const original = getAgentEventLifecycleGeneration();
  registerAgentRunContext("run", { lifecycleGeneration: original, registeredAt: 100 });
  const release = retainQueuedAgentRunContext("run", original);
  clock.mockReturnValue(1_000);
  expect(sweepStaleRunContexts(500)).toBe(0);
  const lifecycleGeneration = rotateAgentEventLifecycleGeneration();
  expect(sweepStaleRunContexts(500)).toBe(1);
  claimAgentRunContext("run", { lifecycleGeneration, registeredAt: 100 });
  release?.("admitted");
  expect(getAgentRunContext("run")).toMatchObject({ lifecycleGeneration, registeredAt: 100 });
  expect(getAgentRunContext("run")?.lastActiveAt).toBeUndefined();
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
  registerAgentRunContext("a", { sessionKey: "a" });
  registerAgentRunContext("b", { sessionKey: "b" });
  const seen: number[] = [];
  const stop = onAgentEventForRun("a", (event) => seen.push(event.seq));
  emit("a");
  emit("b");
  emit("a");
  stop();
  emit("a");
  expect(seen).toEqual([1, 2]);
  onAgentEventForRun("a", (event) => seen.push(event.seq));
  stop();
  emit("a");
  expect(seen).toEqual([1, 2, 4]);
});

test("visits a listener added by the last callback even when that callback throws", () => {
  const order: string[] = [];
  onAgentEventForRun("run", () => {
    order.push("first");
    onAgentEvent(() => order.push("late"));
    throw new Error("listener failed after registering its successor");
  });
  emit("run");
  expect(order).toEqual(["first", "late"]);
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
    emit("run");
    stopFirst();
    emit("run");
    subscribe(listener);
    stopFirst();
    emit("run");
    stopDuplicate();
    expect(seen).toEqual(["event"]);
  },
);

test("keeps preserved listeners and additions live during reset", () => {
  const order: string[] = [];
  onAgentEventForRun("run", () => {
    order.push("first");
    resetAgentEventsForTest({ preserveListeners: true });
    onAgentEvent(() => order.push("new-global"));
    onAgentEventForRun("run", () => order.push("new-run"));
  });
  onAgentEvent(() => order.push("old-global"));
  onAgentEventForRun("run", () => order.push("old-run"));
  emit("run");
  expect(order).toEqual(["first", "old-global", "old-run", "new-global", "new-run"]);
});

test("reselects a mutated run cohort without revisiting earlier registrations", () => {
  const order: string[] = [];
  onAgentEventForRun("b", () => order.push("earlier-b"));
  onAgentEventForRun("a", () => order.push("first-a"));
  onAgentEvent((event) => {
    order.push("global");
    event.runId = "b";
  });
  onAgentEventForRun("a", () => order.push("later-a"));
  onAgentEventForRun("b", () => order.push("later-b"));
  emit("a");
  expect(order).toEqual(["first-a", "global", "later-b"]);
});

test("retains independent nested cursors while new callbacks join both emissions", () => {
  const order: string[] = [];
  onAgentEventForRun("run", (event) => {
    order.push(`first:${String(event.data.text)}`);
    if (event.data.text === "outer") {
      emit("run", "assistant", { text: "inner" });
    } else {
      onAgentEventForRun("run", (next) => order.push(`new-run:${String(next.data.text)}`));
      onAgentEvent((next) => order.push(`new-global:${String(next.data.text)}`));
    }
  });
  onAgentEvent((event) => order.push(`global:${String(event.data.text)}`));
  emit("run", "assistant", { text: "outer" });
  expect(order).toEqual([
    "first:outer",
    "first:inner",
    "global:inner",
    "new-run:inner",
    "new-global:inner",
    "global:outer",
    "new-run:outer",
    "new-global:outer",
  ]);
});
