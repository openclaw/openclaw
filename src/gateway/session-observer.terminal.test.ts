import { expect, it, vi } from "vitest";
import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { emitSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import type { SessionObserverDeps } from "./session-observer-model.js";
import {
  advanceAndFlush,
  broadcastDigest,
  emitEvent,
  expectBroadcast,
  expectPersisted,
  observerBroadcasts,
  callCounts,
  useObserverSuite,
  type Harness,
  type HarnessOptions,
  type EventRoute,
} from "./session-observer-suite.test-support.js";
import {
  createObserverTimerTracker,
  event,
  flushObserver,
  modelMessage,
  type PersistDigestParams,
  persistedLiveDigest,
  startAndAddToolNotes,
} from "./session-observer.test-utils.js";
import { notifyGatewaySessionReset } from "./session-reset-notifications.js";

const { createHarness, activeHarnesses } = useObserverSuite();
const databaseIdentity = Symbol("session-observer-database");

function sessionReader(
  overrides: Partial<NonNullable<ReturnType<NonNullable<SessionObserverDeps["readSession"]>>>> = {},
) {
  return vi.fn<NonNullable<SessionObserverDeps["readSession"]>>(() => ({
    sessionId: "session-id",
    updatedAt: 1_000,
    ...overrides,
  }));
}

function createPersistedHarness(
  options: HarnessOptions = {},
  digestOverrides: Partial<SessionObserverDigest> = {},
) {
  const storedDigest = persistedLiveDigest(digestOverrides);
  const readSession = sessionReader({ observerDigest: storedDigest });
  return { storedDigest, harness: createHarness({ ...options, readSession }) };
}

async function createFailingTerminalHarness(options: HarnessOptions = {}, health = "grinding") {
  const completeModel = vi.fn(async () => modelMessage({ headline: "Fixing tests", health }));
  const harness = createHarness({ ...options, completeModel });
  await startAndAddToolNotes(harness.observer);
  await advanceAndFlush(12_000);
  expect(completeModel).toHaveBeenCalledOnce();
  completeModel.mockRejectedValue(new Error("model unavailable"));
  return harness;
}

function contextlessTerminal() {
  const terminal = event({
    stream: "lifecycle",
    data: { phase: "end", startedAt: 0, endedAt: 30_000 },
  });
  delete terminal.sessionKey;
  delete terminal.agentId;
  return terminal;
}

async function handleLifecycle(
  harness: Harness,
  data: Record<string, unknown>,
  route: EventRoute = {},
): Promise<void> {
  await emitEvent(harness, "lifecycle", data, route);
  await flushObserver();
}

async function longRunningHarness() {
  const harness = createHarness();
  await emitEvent(harness, "lifecycle", { phase: "start", startedAt: 0 });
  await vi.advanceTimersByTimeAsync(30_000);
  return harness;
}

function nextPersistence(harness: Harness): Promise<void> {
  const persisted = createDeferred();
  harness.persistDigest.mockImplementationOnce(async () => {
    persisted.resolve();
    return true;
  });
  return persisted.promise;
}

function persistGuard(harness: Harness): (() => boolean) | undefined {
  return harness.persistDigest.mock.calls[0]?.[0]?.stillCurrent as (() => boolean) | undefined;
}

function completionPrompt(harness: Harness, index = 0): string {
  return harness.completeModel.mock.calls[index]?.[0]?.prompt ?? "";
}

function commitObserverSessionReset(harness: Harness, notify = true): void {
  const sessionKey = "agent:main:session-1";
  const sessionId = "session-id";
  harness.readSession.mockReturnValue({
    sessionId,
    lifecycleRevision: "lifecycle-b",
    updatedAt: Date.now(),
  });
  if (!notify) {
    return;
  }
  emitSessionIdentityMutation({
    agentId: "main",
    databaseIdentity,
    kind: "reset",
    previous: { sessionId, sessionKeys: [sessionKey] },
    current: { sessionId, sessionKeys: [sessionKey] },
  });
  notifyGatewaySessionReset(sessionKey, "main");
}

it("accepts a routed terminal event after a contextless duplicate", async () => {
  vi.setSystemTime(30_000);
  const { harness } = createPersistedHarness({ subscribe: false });
  await harness.observer.handleEventAsync(contextlessTerminal());
  await emitEvent(harness, "lifecycle", { phase: "end", startedAt: 0, endedAt: 30_000 });
  await flushObserver();

  expect(harness.persistDigest).toHaveBeenCalledOnce();
  expectPersisted(harness, { health: "done" });
});

it.for([false, true])(
  "recovers the owner of a contextless terminal (dormant: %s)",
  async (dormant, { signal }) => {
    const { harness } = createPersistedHarness();
    await startAndAddToolNotes(harness.observer);
    if (dormant) {
      harness.observer.removeConnection("conn-1");
    }
    vi.setSystemTime(30_000);
    const terminal = contextlessTerminal();
    const persisted = nextPersistence(harness);
    const published = createDeferred();
    harness.broadcastToConnIds.mockImplementationOnce(() => published.resolve());
    await harness.observer.handleEventAsync(terminal);
    await withinTest(Promise.all([persisted, published.promise]), signal);
    expectBroadcast(harness, { runId: "run-1", health: "done" });
    expectPersisted(harness, { runId: "run-1", health: "done" });
    expect(harness.persistDigest).toHaveBeenCalledOnce();
  },
);

it("synthesizes before dropping an in-flight terminal state", async () => {
  vi.setSystemTime(30_000);
  const completion = createDeferred<ReturnType<typeof modelMessage>>();
  const completeModel = vi.fn(() => completion.promise);
  const { storedDigest, harness } = createPersistedHarness({ completeModel });
  try {
    await handleLifecycle(harness, { phase: "end", startedAt: 0, endedAt: 30_000 });
    expect(completeModel).toHaveBeenCalledOnce();

    harness.subscribers.unsubscribe("conn-1", "agent:main:session-1");
    await flushObserver();

    expectPersisted(harness, {
      headline: storedDigest.headline,
      health: "done",
      revision: storedDigest.revision + 1,
    });
  } finally {
    completion.resolve(modelMessage({ headline: "Cleanup", health: "on-track" }));
    await harness.observer.disposeAsync();
    activeHarnesses.delete(harness);
  }
});

it("does not finalize a retryable attempt error before same-run fallback succeeds", async ({
  signal,
}) => {
  const harness = await longRunningHarness();

  await emitEvent(harness, "lifecycle", {
    phase: "error",
    endedAt: 30_000,
    error: "retryable provider failure",
  });
  await flushObserver();
  expect(vi.getTimerCount()).toBe(1);
  await emitEvent(harness, "lifecycle", { phase: "start", startedAt: 30_000 });
  expect(vi.getTimerCount()).toBe(0);
  vi.setSystemTime(60_000);
  const persisted = nextPersistence(harness);
  await handleLifecycle(harness, { phase: "end", endedAt: 60_000 });
  await withinTest(persisted, signal);

  expect(observerBroadcasts(harness).map((call) => call[1])).toEqual([
    expect.objectContaining({ health: "done" }),
  ]);
  expect(harness.persistDigest).toHaveBeenCalledOnce();
});

it("corrects an expired retryable failure after repeated same-run attempt errors", async ({
  signal,
}) => {
  const harness = await longRunningHarness();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await emitEvent(harness, "lifecycle", {
      phase: "error",
      endedAt: 30_000 + attempt,
      error: `retryable provider failure ${attempt + 1}`,
    });
    await advanceAndFlush(15_000);
  }

  expectBroadcast(harness, { health: "failed" });
  const failureRevision = broadcastDigest(harness, -1)?.revision;
  const persisted = nextPersistence(harness);
  await handleLifecycle(harness, { phase: "end", endedAt: 70_000 });
  await withinTest(persisted, signal);

  expectBroadcast(harness, { health: "done", runId: "run-1" });
  expectPersisted(harness, { health: "done", runId: "run-1" }, -1);
  expect(broadcastDigest(harness, -1)?.revision).toBeGreaterThan(failureRevision ?? 0);
});

it("does not let a provisional prior run evict the newer active session owner", async () => {
  const harness = await longRunningHarness();
  await emitEvent(harness, "lifecycle", {
    phase: "error",
    endedAt: 30_000,
    error: "retryable provider failure",
  });
  await advanceAndFlush(15_000);

  await handleLifecycle(harness, { phase: "start", startedAt: 45_000 }, { runId: "run-2" });
  await handleLifecycle(harness, { phase: "end", endedAt: 50_000 });
  await handleLifecycle(harness, { phase: "end", endedAt: 80_000 }, { runId: "run-2" });

  expect(observerBroadcasts(harness).map((call) => call[1])).not.toContainEqual(
    expect.objectContaining({ runId: "run-1", health: "done" }),
  );
  expectBroadcast(harness, { health: "done", runId: "run-2" });
});

it("does not replay terminal persistence after an unknown write outcome", async ({ signal }) => {
  vi.setSystemTime(30_000);
  const attempted = createDeferred();
  const persistDigest = vi
    .fn()
    .mockImplementationOnce(async () => {
      attempted.resolve();
      throw new Error("write outcome unknown");
    })
    .mockResolvedValueOnce(true);
  const harness = createHarness({ persistDigest });
  await handleLifecycle(harness, { phase: "end", startedAt: 0, endedAt: 30_000 });
  await withinTest(attempted.promise, signal);
  await vi.advanceTimersByTimeAsync(0);

  expect(persistDigest).toHaveBeenCalledTimes(1);
});

it("invalidates the persist-time guard when a newer run replaces a dormant run", async () => {
  const persistDigest = vi.fn(async (_params: PersistDigestParams) => undefined);
  const harness = createHarness({ persistDigest });
  await startAndAddToolNotes(harness.observer);
  await advanceAndFlush(12_000);
  expect(persistDigest).toHaveBeenCalledOnce();
  const guard = persistGuard(harness);
  expect(guard?.()).toBe(true);
  harness.observer.setConnectionVisibility("conn-1", false);

  await emitEvent(harness, "lifecycle", { phase: "error", error: "retryable provider failure" });
  expect(vi.getTimerCount()).toBe(1);
  await emitEvent(harness, "lifecycle", { phase: "start" }, { runId: "run-2" });
  expect(vi.getTimerCount()).toBe(0);
  expect(guard?.()).toBe(false);
});

it.each([
  { name: "notified reset", notify: true, lifecycleRevision: "lifecycle-a" },
  { name: "first reset of a legacy lifecycle", notify: false, lifecycleRevision: undefined },
])("discards a final result after same-id reset: $name", async ({ notify, lifecycleRevision }) => {
  const final = createDeferred<ReturnType<typeof modelMessage>>();
  const completeModel = vi.fn(() => final.promise);
  const readSession = sessionReader({
    lifecycleRevision,
    observerDigest: persistedLiveDigest({ revision: 10, health: "stuck" }),
  });
  const harness = createHarness({ completeModel, readSession });
  await handleLifecycle(harness, { phase: "start", startedAt: 0 });
  vi.setSystemTime(30_000);
  await handleLifecycle(harness, { phase: "end", startedAt: 0, endedAt: 30_000 });
  expect(completeModel).toHaveBeenCalledOnce();

  commitObserverSessionReset(harness, notify);
  final.resolve(modelMessage({ headline: "Previous run finished", health: "done" }));
  await flushObserver();

  expect(observerBroadcasts(harness)).toHaveLength(0);
  expect(harness.persistDigest).not.toHaveBeenCalled();
});

it("discards a queued preamble from a reset lifecycle", async () => {
  const readSession = sessionReader({ lifecycleRevision: "lifecycle-a", updatedAt: 0 });
  const harness = createHarness({
    readSession,
    config: { agents: { defaults: { utilityModel: "" } } },
  });
  await emitEvent(harness, "item", { kind: "preamble", progressText: "Initial work" });
  await advanceAndFlush(100);
  await emitEvent(harness, "item", { kind: "preamble", progressText: "Obsolete queued work" });
  commitObserverSessionReset(harness, false);
  await advanceAndFlush(2_000);

  expect(observerBroadcasts(harness)).toHaveLength(1);
  await emitEvent(
    harness,
    "item",
    { kind: "preamble", progressText: "Fresh work" },
    { runId: "run-2" },
  );
  expectBroadcast(harness, {
    runId: "run-2",
    revision: 1,
    headline: "Fresh work",
    sessionId: "session-id",
    lifecycleRevision: "lifecycle-b",
  });
});

it("keeps critical transitions and revision floors within a reset lifecycle before notification", async () => {
  const final = createDeferred<ReturnType<typeof modelMessage>>();
  const completeModel = vi
    .fn(async () => modelMessage({ headline: "Waiting for a repair", health: "stuck" }))
    .mockImplementationOnce(() => final.promise);
  const readSession = sessionReader({
    lifecycleRevision: "lifecycle-a",
    observerDigest: persistedLiveDigest({
      revision: 10,
      health: "stuck",
      sessionId: "session-id",
      lifecycleRevision: "lifecycle-a",
    }),
  });
  const harness = createHarness({ completeModel, readSession });
  harness.sessionEventSubscribers.subscribe("background");
  harness.observer.setConnectionVisibility("background", false);
  await handleLifecycle(harness, { phase: "start", startedAt: 0 });
  vi.setSystemTime(30_000);
  await handleLifecycle(harness, { phase: "end", startedAt: 0, endedAt: 30_000 });
  expect(completeModel).toHaveBeenCalledOnce();

  commitObserverSessionReset(harness, false);
  await startAndAddToolNotes(harness.observer, { runId: "run-2" });
  notifyGatewaySessionReset("agent:main:session-1", "main");
  await advanceAndFlush(12_000);
  final.resolve(modelMessage({ headline: "Previous run finished", health: "done" }));
  await flushObserver();

  const broadcasts = observerBroadcasts(harness);
  expect(broadcasts).toHaveLength(1);
  expect(broadcasts[0]?.[1]).toMatchObject({
    runId: "run-2",
    health: "stuck",
    revision: 1,
    sessionId: "session-id",
    lifecycleRevision: "lifecycle-b",
  });
  expect(broadcasts[0]?.[2]).toEqual(new Set(["conn-1", "background"]));
});

it.each(["deleted", "reset"])("disables model work after the session is %s", async (change) => {
  const readSession = sessionReader({ updatedAt: 0 });
  const harness = createHarness({ readSession });
  await startAndAddToolNotes(harness.observer);
  readSession.mockReturnValue(
    change === "deleted" ? undefined : { sessionId: "session-id-reset", updatedAt: 0 },
  );
  await advanceAndFlush(12_000);
  expect(callCounts(harness)).toEqual({ model: 1, broadcast: 0, persisted: 0 });

  await startAndAddToolNotes(harness.observer, { count: 4 });
  await advanceAndFlush(24_000);
  expect(harness.completeModel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);

  readSession.mockReturnValue({ sessionId: "session-id-next", updatedAt: 36_000 });
  await startAndAddToolNotes(harness.observer, { runId: "run-2" });
  await advanceAndFlush(12_000);
  expect(callCounts(harness)).toEqual({ model: 2, broadcast: 1, persisted: 1 });
});

it("catches up durable persistence when the live digest already carried terminal health", async () => {
  const harness = await createFailingTerminalHarness({}, "done");
  expect(observerBroadcasts(harness)).toHaveLength(1);
  await emitEvent(harness, "lifecycle", { phase: "end", endedAt: 30_000 });
  await advanceAndFlush(0);
  expectPersisted(harness, { health: "done", revision: 1 }, -1);
  expect(observerBroadcasts(harness)).toHaveLength(1);
});

it("does not broadcast a synthesized terminal digest the store rejected", async () => {
  const harness = await createFailingTerminalHarness({ persistDigest: vi.fn(async () => false) });
  await emitEvent(harness, "lifecycle", { phase: "end", endedAt: 30_000 });
  await advanceAndFlush(0);
  expect(observerBroadcasts(harness).map((call) => call[1])).not.toContainEqual(
    expect.objectContaining({ health: "done" }),
  );
});

it("suppresses assistant notes while a runtime-context block is still streaming", async () => {
  const harness = createHarness();
  await startAndAddToolNotes(harness.observer);
  await emitEvent(harness, "assistant", {
    delta: "prose before\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n",
  });
  await emitEvent(harness, "assistant", { delta: "private-context-body-must-not-leave" });
  await advanceAndFlush(12_000);
  expect(harness.completeModel).toHaveBeenCalledOnce();
  const openPrompt = completionPrompt(harness);
  expect(openPrompt).not.toContain("private-context-body-must-not-leave");
  expect(openPrompt).not.toContain("Assistant:");

  await emitEvent(harness, "assistant", {
    delta: "\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\nvisible prose after",
  });
  await startAndAddToolNotes(harness.observer, { count: 4 });
  await advanceAndFlush(12_000);
  expect(harness.completeModel).toHaveBeenCalledTimes(2);
  const closedPrompt = completionPrompt(harness, 1);
  expect(closedPrompt).not.toContain("private-context-body-must-not-leave");
  expect(closedPrompt).toContain("visible prose after");
});

it("invalidates the persist-time guard after disposal", async () => {
  const unrelated = vi.fn();
  const unrelatedTimer = setTimeout(unrelated, 60_000);
  const { ownedTimers } = createObserverTimerTracker();
  const persistDigest = vi.fn(async (_params: PersistDigestParams) => true);
  const harness = createHarness({ persistDigest });
  try {
    await startAndAddToolNotes(harness.observer);
    await advanceAndFlush(12_000);
    expect(persistDigest).toHaveBeenCalledOnce();
    const guard = persistGuard(harness);
    expect(guard?.()).toBe(true);
    await emitEvent(harness, "lifecycle", { phase: "error", error: "retryable provider failure" });
    expect(ownedTimers.size).toBe(1);
    harness.observer.dispose();
    activeHarnesses.delete(harness);
    expect(ownedTimers.size).toBe(0);
    expect(guard?.()).toBe(false);
    expect(unrelated).not.toHaveBeenCalled();

    await advanceAndFlush(48_000);
    expect(unrelated).toHaveBeenCalledOnce();
    expect(ownedTimers.size).toBe(0);
    expect(persistDigest).toHaveBeenCalledOnce();
    expect(harness.completeModel).toHaveBeenCalledOnce();
  } finally {
    await harness.observer.disposeAsync();
    clearTimeout(unrelatedTimer);
  }
});
it("preserves the cause of a model failure", async () => {
  const previousConsole = loggingState.rawConsole;
  const previousOverride = loggingState.overrideSettings;
  const lines: string[] = [];
  const capture = (line: unknown) => lines.push(String(line));
  const cause = new Error("model failed");
  const fail = async () => {
    throw cause;
  };
  const harness = createHarness({ completeModel: vi.fn(fail), persistDigest: vi.fn(fail) });
  try {
    setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "json" });
    loggingState.rawConsole = { log: capture, info: capture, warn: capture, error: capture };
    await startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(24_000);
    const diagnostic = lines
      .map((line) => JSON.parse(line))
      .find((line) => line.message === "session observer disabled after consecutive failures");
    expect(diagnostic).toMatchObject({ error: "model failed", consecutiveFailures: 2 });
  } finally {
    loggingState.rawConsole = previousConsole;
    setLoggerOverride(previousOverride as Parameters<typeof setLoggerOverride>[0]);
  }
});
