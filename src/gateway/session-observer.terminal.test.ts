import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { emitSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import type { SessionObserverDeps } from "./session-observer-model.js";
import {
  createHarness as createBaseHarness,
  createObserverTimerTracker,
  event,
  flushObserver,
  modelMessage,
  type PersistDigestParams,
  persistedLiveDigest,
  resetSessionObserverEventSequence,
  startAndAddToolNotes,
} from "./session-observer.test-utils.js";
import { notifyGatewaySessionReset } from "./session-reset-notifications.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  for (const harness of activeHarnesses) {
    harness.observer.dispose();
  }
  activeHarnesses.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSessionObserverEventSequence();
});

type Harness = ReturnType<typeof createBaseHarness>;
type HarnessOptions = NonNullable<Parameters<typeof createBaseHarness>[0]>;
type EventRoute = { runId?: string; sessionKey?: string; agentId?: string };

const activeHarnesses = new Set<Harness>();
const databaseIdentity = Symbol("session-observer-database");

function createHarness(options?: HarnessOptions): Harness {
  const harness = createBaseHarness(options);
  activeHarnesses.add(harness);
  return harness;
}

function createPersistedHarness(
  options: HarnessOptions = {},
  digestOverrides: Partial<SessionObserverDigest> = {},
) {
  const storedDigest = persistedLiveDigest(digestOverrides);
  const readSession = vi.fn(() => ({
    sessionId: "session-id",
    updatedAt: 1_000,
    observerDigest: storedDigest,
  }));
  return { storedDigest, harness: createHarness({ ...options, readSession }) };
}

async function createFailingTerminalHarness(options: HarnessOptions = {}, health = "grinding") {
  const completeModel = vi.fn(async () => modelMessage({ headline: "Fixing tests", health }));
  const harness = createHarness({ ...options, completeModel });
  startAndAddToolNotes(harness.observer);
  await advanceAndFlush(12_000);
  expect(completeModel).toHaveBeenCalledOnce();
  completeModel.mockRejectedValue(new Error("model unavailable"));
  return harness;
}

function lifecycleEvent(data: Record<string, unknown>, route: EventRoute = {}) {
  return event({ ...route, stream: "lifecycle", data });
}

function emitEvent(
  harness: Harness,
  stream: string,
  data: Record<string, unknown>,
  route: EventRoute = {},
): void {
  harness.observer.handleEvent(event({ ...route, stream, data }));
}

async function advanceAndFlush(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flushObserver();
}

async function handleLifecycle(
  harness: Harness,
  data: Record<string, unknown>,
  route: EventRoute = {},
): Promise<void> {
  emitEvent(harness, "lifecycle", data, route);
  await flushObserver();
}

function persistedDigest(harness: Harness, index = 0) {
  return harness.persistDigest.mock.calls.at(index)?.[0]?.digest as
    | SessionObserverDigest
    | undefined;
}

function broadcastDigest(harness: Harness, index = 0) {
  return harness.broadcastToConnIds.mock.calls.at(index)?.[1] as SessionObserverDigest | undefined;
}

function observerBroadcasts(harness: Harness) {
  return harness.broadcastToConnIds.mock.calls.filter((call) => call[0] === "session.observer");
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

describe("session observer terminal, persistence, synthesis, and races", () => {
  it("accepts a routed terminal event after a contextless duplicate", async () => {
    vi.setSystemTime(30_000);
    const { harness } = createPersistedHarness({ subscribe: false });
    const contextlessTerminal = lifecycleEvent({
      phase: "end",
      startedAt: 0,
      endedAt: 30_000,
    });
    delete contextlessTerminal.sessionKey;
    delete contextlessTerminal.agentId;

    harness.observer.handleEvent(contextlessTerminal);
    emitEvent(harness, "lifecycle", { phase: "end", startedAt: 0, endedAt: 30_000 });
    await flushObserver();

    expect(harness.persistDigest).toHaveBeenCalledOnce();
    expect(harness.persistDigest.mock.calls[0]?.[0]?.digest).toMatchObject({ health: "done" });
  });

  it.each([false, true])(
    "recovers the owner of a contextless terminal (dormant: %s)",
    async (dormant) => {
      const { harness } = createPersistedHarness();
      startAndAddToolNotes(harness.observer);
      if (dormant) {
        harness.observer.removeConnection("conn-1");
      }
      vi.setSystemTime(30_000);
      const terminal = lifecycleEvent({ phase: "end", startedAt: 0, endedAt: 30_000 });
      delete terminal.sessionKey;
      delete terminal.agentId;
      harness.observer.handleEvent(terminal);
      await flushObserver();
      expect(broadcastDigest(harness, -1)).toMatchObject({ runId: "run-1", health: "done" });
      expect(persistedDigest(harness)).toMatchObject({ runId: "run-1", health: "done" });
      expect(harness.persistDigest).toHaveBeenCalledOnce();
    },
  );

  it("synthesizes before dropping an in-flight terminal state", async () => {
    vi.setSystemTime(30_000);
    const completeModel = vi.fn(() => createDeferred<ReturnType<typeof modelMessage>>().promise);
    const { storedDigest, harness } = createPersistedHarness({ completeModel });
    await handleLifecycle(harness, { phase: "end", startedAt: 0, endedAt: 30_000 });
    expect(completeModel).toHaveBeenCalledOnce();

    harness.subscribers.unsubscribe("conn-1", "agent:main:session-1");
    await flushObserver();

    const synthesized = persistedDigest(harness);
    expect(synthesized).toMatchObject({
      headline: storedDigest.headline,
      health: "done",
      revision: storedDigest.revision + 1,
    });
  });

  it("does not finalize a retryable attempt error before same-run fallback succeeds", async () => {
    const harness = createHarness();
    emitEvent(harness, "lifecycle", { phase: "start", startedAt: 0 });
    await vi.advanceTimersByTimeAsync(30_000);

    emitEvent(harness, "lifecycle", {
      phase: "error",
      endedAt: 30_000,
      error: "retryable provider failure",
    });
    await flushObserver();
    expect(vi.getTimerCount()).toBe(1);
    emitEvent(harness, "lifecycle", { phase: "start", startedAt: 30_000 });
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(60_000);
    await handleLifecycle(harness, { phase: "end", endedAt: 60_000 });

    expect(observerBroadcasts(harness).map((call) => call[1])).toEqual([
      expect.objectContaining({ health: "done" }),
    ]);
    expect(harness.persistDigest).toHaveBeenCalledOnce();
  });

  it("corrects an expired retryable failure after repeated same-run attempt errors", async () => {
    const harness = createHarness();
    emitEvent(harness, "lifecycle", { phase: "start", startedAt: 0 });
    await vi.advanceTimersByTimeAsync(30_000);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      emitEvent(harness, "lifecycle", {
        phase: "error",
        endedAt: 30_000 + attempt,
        error: `retryable provider failure ${attempt + 1}`,
      });
      await advanceAndFlush(15_000);
    }

    expect(broadcastDigest(harness, -1)).toMatchObject({ health: "failed" });
    const failureRevision = broadcastDigest(harness, -1)?.revision;
    await handleLifecycle(harness, { phase: "end", endedAt: 70_000 });

    expect(broadcastDigest(harness, -1)).toMatchObject({ health: "done", runId: "run-1" });
    expect(persistedDigest(harness, -1)).toMatchObject({ health: "done", runId: "run-1" });
    expect(broadcastDigest(harness, -1)?.revision).toBeGreaterThan(failureRevision ?? 0);
  });

  it("does not let a provisional prior run evict the newer active session owner", async () => {
    const harness = createHarness();
    emitEvent(harness, "lifecycle", { phase: "start", startedAt: 0 });
    await vi.advanceTimersByTimeAsync(30_000);
    emitEvent(harness, "lifecycle", {
      phase: "error",
      endedAt: 30_000,
      error: "retryable provider failure",
    });
    await advanceAndFlush(15_000);

    await handleLifecycle(harness, { phase: "start", startedAt: 45_000 }, { runId: "run-2" });
    await handleLifecycle(harness, { phase: "end", endedAt: 50_000 });
    await handleLifecycle(harness, { phase: "end", endedAt: 80_000 }, { runId: "run-2" });

    expect(
      observerBroadcasts(harness).some((call) => {
        const digest = call[1] as SessionObserverDigest;
        return digest.runId === "run-1" && digest.health === "done";
      }),
    ).toBe(false);
    expect(broadcastDigest(harness, -1)).toMatchObject({ health: "done", runId: "run-2" });
  });

  it("does not replay terminal persistence after an unknown write outcome", async () => {
    vi.setSystemTime(30_000);
    const persistDigest = vi
      .fn()
      .mockRejectedValueOnce(new Error("write outcome unknown"))
      .mockResolvedValueOnce(true);
    const harness = createHarness({ persistDigest });
    await handleLifecycle(harness, { phase: "end", startedAt: 0, endedAt: 30_000 });

    expect(persistDigest).toHaveBeenCalledTimes(1);
  });

  it("preserves text split across assistant deltas in the assembled note", async () => {
    const harness = createHarness();
    startAndAddToolNotes(harness.observer);
    emitEvent(harness, "assistant", { delta: "Calling the API with api_k" });
    emitEvent(harness, "assistant", { delta: "ey=super-secret-value-0123456789 attached." });
    await advanceAndFlush(12_000);
    expect(harness.completeModel).toHaveBeenCalledOnce();
    const prompt = completionPrompt(harness);
    expect(prompt).toContain("Assistant:");
    expect(prompt).toContain("super-secret-value-0123456789");
  });

  it("invalidates the persist-time guard when a newer run replaces a dormant run", async () => {
    const persistDigest = vi.fn(async (_params: PersistDigestParams) => undefined);
    const harness = createHarness({ persistDigest });
    startAndAddToolNotes(harness.observer);
    await advanceAndFlush(12_000);
    expect(persistDigest).toHaveBeenCalledOnce();
    const guard = persistGuard(harness);
    expect(guard?.()).toBe(true);
    harness.observer.setConnectionVisibility("conn-1", false);

    emitEvent(harness, "lifecycle", { phase: "error", error: "retryable provider failure" });
    expect(vi.getTimerCount()).toBe(1);
    emitEvent(harness, "lifecycle", { phase: "start" }, { runId: "run-2" });
    expect(vi.getTimerCount()).toBe(0);
    expect(guard?.()).toBe(false);
  });

  it.each([
    { name: "notified reset", notify: true, lifecycleRevision: "lifecycle-a" },
    { name: "first reset of a legacy lifecycle", notify: false, lifecycleRevision: undefined },
  ])(
    "discards a final result after same-id reset: $name",
    async ({ notify, lifecycleRevision }) => {
      const final = createDeferred<ReturnType<typeof modelMessage>>();
      const completeModel = vi.fn(() => final.promise);
      const readSession = vi.fn<NonNullable<SessionObserverDeps["readSession"]>>(() => ({
        sessionId: "session-id",
        lifecycleRevision,
        updatedAt: 1_000,
        observerDigest: persistedLiveDigest({ revision: 10, health: "stuck" }),
      }));
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
    },
  );

  it("discards a queued preamble from a reset lifecycle", async () => {
    const readSession = vi.fn<NonNullable<SessionObserverDeps["readSession"]>>(() => ({
      sessionId: "session-id",
      lifecycleRevision: "lifecycle-a",
      updatedAt: 0,
    }));
    const harness = createHarness({ readSession, utilityModelRef: null });
    emitEvent(harness, "item", { kind: "preamble", progressText: "Initial work" });
    await advanceAndFlush(100);
    emitEvent(harness, "item", { kind: "preamble", progressText: "Obsolete queued work" });
    commitObserverSessionReset(harness, false);
    await advanceAndFlush(2_000);

    expect(observerBroadcasts(harness)).toHaveLength(1);
    emitEvent(
      harness,
      "item",
      { kind: "preamble", progressText: "Fresh work" },
      { runId: "run-2" },
    );
    expect(broadcastDigest(harness, -1)).toMatchObject({
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
    const readSession = vi.fn<NonNullable<SessionObserverDeps["readSession"]>>(() => ({
      sessionId: "session-id",
      lifecycleRevision: "lifecycle-a",
      updatedAt: 1_000,
      observerDigest: persistedLiveDigest({
        revision: 10,
        health: "stuck",
        sessionId: "session-id",
        lifecycleRevision: "lifecycle-a",
      }),
    }));
    const harness = createHarness({ completeModel, readSession });
    harness.sessionEventSubscribers.subscribe("background");
    harness.observer.setConnectionVisibility("background", false);
    await handleLifecycle(harness, { phase: "start", startedAt: 0 });
    vi.setSystemTime(30_000);
    await handleLifecycle(harness, { phase: "end", startedAt: 0, endedAt: 30_000 });
    expect(completeModel).toHaveBeenCalledOnce();

    commitObserverSessionReset(harness, false);
    startAndAddToolNotes(harness.observer, { runId: "run-2" });
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
    const readSession = vi.fn<NonNullable<SessionObserverDeps["readSession"]>>(() => ({
      sessionId: "session-id",
      updatedAt: 0,
    }));
    const harness = createHarness({ readSession });
    startAndAddToolNotes(harness.observer);
    readSession.mockReturnValue(
      change === "deleted" ? undefined : { sessionId: "session-id-reset", updatedAt: 0 },
    );
    await advanceAndFlush(12_000);
    expect(harness.completeModel).toHaveBeenCalledOnce();
    expect(observerBroadcasts(harness)).toHaveLength(0);
    expect(harness.persistDigest).not.toHaveBeenCalled();

    startAndAddToolNotes(harness.observer, { count: 4 });
    await advanceAndFlush(24_000);
    expect(harness.completeModel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    readSession.mockReturnValue({ sessionId: "session-id-next", updatedAt: 36_000 });
    startAndAddToolNotes(harness.observer, { runId: "run-2" });
    await advanceAndFlush(12_000);
    expect(harness.completeModel).toHaveBeenCalledTimes(2);
    expect(harness.persistDigest).toHaveBeenCalledOnce();
    expect(observerBroadcasts(harness)).toHaveLength(1);
  });

  it("catches up durable persistence when the live digest already carried terminal health", async () => {
    const harness = await createFailingTerminalHarness({}, "done");
    expect(observerBroadcasts(harness)).toHaveLength(1);
    emitEvent(harness, "lifecycle", { phase: "end", endedAt: 30_000 });
    await advanceAndFlush(0);
    const persisted = persistedDigest(harness, -1);
    expect(persisted?.health).toBe("done");
    expect(persisted?.revision).toBe(1);
    const broadcasts = observerBroadcasts(harness);
    expect(broadcasts).toHaveLength(1);
  });

  it("does not broadcast a synthesized terminal digest the store rejected", async () => {
    const harness = await createFailingTerminalHarness({ persistDigest: vi.fn(async () => false) });
    emitEvent(harness, "lifecycle", { phase: "end", endedAt: 30_000 });
    await advanceAndFlush(0);
    const terminalBroadcasts = observerBroadcasts(harness).filter(
      (call) => (call[1] as SessionObserverDigest | undefined)?.health === "done",
    );
    expect(terminalBroadcasts).toHaveLength(0);
  });

  it("suppresses assistant notes while a runtime-context block is still streaming", async () => {
    const harness = createHarness();
    startAndAddToolNotes(harness.observer);
    emitEvent(harness, "assistant", {
      delta: "prose before\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n",
    });
    emitEvent(harness, "assistant", { delta: "private-context-body-must-not-leave" });
    await advanceAndFlush(12_000);
    expect(harness.completeModel).toHaveBeenCalledOnce();
    const openPrompt = completionPrompt(harness);
    expect(openPrompt).not.toContain("private-context-body-must-not-leave");
    expect(openPrompt).not.toContain("Assistant:");

    emitEvent(harness, "assistant", {
      delta: "\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\nvisible prose after",
    });
    startAndAddToolNotes(harness.observer, { count: 4 });
    await advanceAndFlush(12_000);
    expect(harness.completeModel).toHaveBeenCalledTimes(2);
    const closedPrompt = completionPrompt(harness, 1);
    expect(closedPrompt).not.toContain("private-context-body-must-not-leave");
    expect(closedPrompt).toContain("visible prose after");
  });

  it("invalidates the persist-time guard after disposal", async () => {
    const { ownedTimers, setTimeoutFn, clearTimeoutFn } = createObserverTimerTracker();
    const unrelated = vi.fn();
    const unrelatedTimer = setTimeout(unrelated, 60_000);
    const persistDigest = vi.fn(async (_params: PersistDigestParams) => true);
    const harness = createHarness({ persistDigest, setTimeoutFn, clearTimeoutFn });
    try {
      startAndAddToolNotes(harness.observer);
      await advanceAndFlush(12_000);
      expect(persistDigest).toHaveBeenCalledOnce();
      const guard = persistGuard(harness);
      expect(guard?.()).toBe(true);
      emitEvent(harness, "lifecycle", { phase: "error", error: "retryable provider failure" });
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
      clearTimeout(unrelatedTimer);
    }
  });
});

describe("session observer JSON diagnostics", () => {
  it("preserves the cause of a model failure", async () => {
    const previousConsole = loggingState.rawConsole;
    const previousOverride = loggingState.overrideSettings;
    const lines: string[] = [];
    const capture = (line: unknown) => lines.push(String(line));
    const cause = new Error("model failed");
    const harness = createHarness({
      completeModel: vi.fn(async () => {
        throw cause;
      }),
      persistDigest: vi.fn(async () => {
        throw cause;
      }),
    });
    try {
      setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "json" });
      loggingState.rawConsole = { log: capture, info: capture, warn: capture, error: capture };
      startAndAddToolNotes(harness.observer);
      await vi.advanceTimersByTimeAsync(24_000);
      const diagnostic = lines
        .map((line) => JSON.parse(line))
        .find((line) => line.message === "session observer disabled after consecutive failures");
      expect(diagnostic?.error).toBe("model failed");
      expect(diagnostic.consecutiveFailures).toBe(2);
    } finally {
      loggingState.rawConsole = previousConsole;
      setLoggerOverride(previousOverride as Parameters<typeof setLoggerOverride>[0]);
    }
  });
});
