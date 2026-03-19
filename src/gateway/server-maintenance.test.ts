import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "../commands/health.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createToolEventRecipientRegistry,
} from "./server-chat.js";

const { cleanOldMediaMock } = vi.hoisted(() => ({
  cleanOldMediaMock: vi.fn(async () => {}),
}));

vi.mock("../media/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/store.js")>();
  return {
    ...actual,
    cleanOldMedia: cleanOldMediaMock,
  };
});

vi.mock("./server/health-state.js", () => ({
  setBroadcastHealthUpdate: () => {},
}));

const MEDIA_CLEANUP_TTL_MS = 24 * 60 * 60_000;

function createMaintenanceTimerDeps() {
  const chatRunState = createChatRunState();
  return {
    broadcast: () => {},
    nodeSendToAllSubscribed: () => {},
    getPresenceVersion: () => 1,
    getHealthVersion: () => 1,
    refreshGatewayHealthSnapshot: async () => ({ ok: true }) as HealthSummary,
    logHealth: { error: () => {} },
    dedupe: new Map(),
    chatAbortControllers: new Map(),
    chatRunState,
    removeChatRun: chatRunState.registry.remove,
    agentRunSeq: new Map(),
    nodeSendToSession: () => {},
  };
}

function seedEffectiveRunState(
  chatRunState: ReturnType<typeof createChatRunState>,
  runId: string,
  text = "Hello world",
) {
  chatRunState.buffers.set(runId, text);
  chatRunState.lastSeenEventSeq.set(runId, 3);
  chatRunState.lastAcceptedSeq.set(runId, 2);
  chatRunState.waitingForRecovery.add(runId);
  chatRunState.deltaLastBroadcastText.set(runId, text);
  chatRunState.deltaSentAt.set(runId, 100);
  chatRunState.deltaLastBroadcastLen.set(runId, text.length);
}

function seedAgentRunSeqPastCap(agentRunSeq: Map<string, number>, oldestRunId: string) {
  agentRunSeq.set(oldestRunId, 1);
  for (let i = 0; i < 10_000; i++) {
    agentRunSeq.set(`run-${String(i)}`, i + 2);
  }
}

function seedAgentRunSeqOverCapWithOlderRuns(
  agentRunSeq: Map<string, number>,
  olderRunIds: string[],
  extraRunCount = 1,
) {
  let seq = 1;
  for (const runId of olderRunIds) {
    agentRunSeq.set(runId, seq);
    seq += 1;
  }
  for (let i = 0; i < 10_000; i++) {
    agentRunSeq.set(`run-${String(i)}`, seq);
    seq += 1;
  }
  for (let i = 0; i < extraRunCount; i++) {
    agentRunSeq.set(`overflow-${String(i)}`, seq);
    seq += 1;
  }
}

function stopMaintenanceTimers(timers: {
  tickInterval: NodeJS.Timeout;
  healthInterval: NodeJS.Timeout;
  dedupeCleanup: NodeJS.Timeout;
  mediaCleanup: NodeJS.Timeout | null;
}) {
  clearInterval(timers.tickInterval);
  clearInterval(timers.healthInterval);
  clearInterval(timers.dedupeCleanup);
  if (timers.mediaCleanup) {
    clearInterval(timers.mediaCleanup);
  }
}

describe("startGatewayMaintenanceTimers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not schedule recursive media cleanup unless ttl is configured", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
    });

    expect(cleanOldMediaMock).not.toHaveBeenCalled();
    expect(timers.mediaCleanup).toBeNull();

    stopMaintenanceTimers(timers);
  });

  it("runs startup media cleanup and repeats it hourly", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      mediaCleanupTtlMs: MEDIA_CLEANUP_TTL_MS,
    });

    expect(cleanOldMediaMock).toHaveBeenCalledWith(MEDIA_CLEANUP_TTL_MS, {
      recursive: true,
      pruneEmptyDirs: true,
    });

    cleanOldMediaMock.mockClear();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledWith(MEDIA_CLEANUP_TTL_MS, {
      recursive: true,
      pruneEmptyDirs: true,
    });

    stopMaintenanceTimers(timers);
  });

  it("skips overlapping media cleanup runs", async () => {
    vi.useFakeTimers();
    let resolveCleanup = () => {};
    let cleanupReady = false;
    cleanOldMediaMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
          cleanupReady = true;
        }),
    );
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      mediaCleanupTtlMs: MEDIA_CLEANUP_TTL_MS,
    });

    expect(cleanOldMediaMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(1);

    if (cleanupReady) {
      resolveCleanup();
    }
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(2);

    stopMaintenanceTimers(timers);
  });

  it("clears timeout-aborted seq and recovery state before the same effective key is reused", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "client-timeout-reuse";
    const sessionKey = "session-timeout-reuse";
    seedEffectiveRunState(deps.chatRunState, runId);
    deps.agentRunSeq.set(runId, 3);
    deps.chatRunState.registry.add(runId, { sessionKey, clientRunId: runId });
    deps.chatAbortControllers.set(runId, {
      controller: new AbortController(),
      sessionId: sessionKey,
      sessionKey,
      startedAtMs: Date.now() - 5_000,
      expiresAtMs: Date.now() - 1,
    });

    const timers = startGatewayMaintenanceTimers(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.chatRunState.lastSeenEventSeq.has(runId)).toBe(false);
    expect(deps.chatRunState.lastAcceptedSeq.has(runId)).toBe(false);
    expect(deps.chatRunState.waitingForRecovery.has(runId)).toBe(false);
    expect(deps.chatRunState.deltaLastBroadcastLen.has(runId)).toBe(false);
    expect(deps.agentRunSeq.has(runId)).toBe(false);

    deps.chatRunState.abortedRuns.delete(runId);
    deps.chatRunState.registry.add(runId, { sessionKey, clientRunId: runId });

    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds: vi.fn(),
      nodeSendToSession,
      agentRunSeq: deps.agentRunSeq,
      chatRunState: deps.chatRunState,
      resolveSessionKeyForRun: () => undefined,
      clearAgentRunContext: vi.fn(),
      toolEventRecipients: createToolEventRecipientRegistry(),
      sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    });

    handler({
      runId,
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Fresh start" },
    });
    handler({
      runId,
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(2);
    const finalPayload = chatCalls.at(-1)?.[1] as {
      message?: { content?: Array<{ text?: string }> };
    };
    expect(finalPayload.message?.content?.[0]?.text).toBe("Fresh start");

    stopMaintenanceTimers(timers);
  });

  it("prunes all per-run maps after aborted-run TTL expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "client-prune";
    seedEffectiveRunState(deps.chatRunState, runId, "Stale text");
    deps.chatRunState.abortedRuns.set(runId, Date.now() - 60 * 60_000 - 1);

    const timers = startGatewayMaintenanceTimers(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.chatRunState.abortedRuns.has(runId)).toBe(false);
    expect(deps.chatRunState.buffers.has(runId)).toBe(false);
    expect(deps.chatRunState.lastSeenEventSeq.has(runId)).toBe(false);
    expect(deps.chatRunState.lastAcceptedSeq.has(runId)).toBe(false);
    expect(deps.chatRunState.waitingForRecovery.has(runId)).toBe(false);
    expect(deps.chatRunState.deltaLastBroadcastText.has(runId)).toBe(false);
    expect(deps.chatRunState.deltaSentAt.has(runId)).toBe(false);
    expect(deps.chatRunState.deltaLastBroadcastLen.has(runId)).toBe(false);

    stopMaintenanceTimers(timers);
  });

  it("eviction clears stale effective-run state before a client-visible key is reused", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "client-reused";

    seedEffectiveRunState(deps.chatRunState, runId, "Stale reused text");
    deps.chatRunState.abortedRuns.set(runId, Date.now() - 500);
    seedAgentRunSeqPastCap(deps.agentRunSeq, runId);

    const timers = startGatewayMaintenanceTimers(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.agentRunSeq.has(runId)).toBe(false);
    expect(deps.chatRunState.abortedRuns.has(runId)).toBe(true);
    expect(deps.chatRunState.buffers.has(runId)).toBe(false);
    expect(deps.chatRunState.lastSeenEventSeq.has(runId)).toBe(false);
    expect(deps.chatRunState.lastAcceptedSeq.has(runId)).toBe(false);
    expect(deps.chatRunState.waitingForRecovery.has(runId)).toBe(false);
    expect(deps.chatRunState.deltaLastBroadcastText.has(runId)).toBe(false);
    expect(deps.chatRunState.deltaSentAt.has(runId)).toBe(false);
    expect(deps.chatRunState.deltaLastBroadcastLen.has(runId)).toBe(false);

    stopMaintenanceTimers(timers);
  });

  it("bounds abandoned observed run state through the same agentRunSeq eviction path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "client-abandoned-observed";

    seedEffectiveRunState(deps.chatRunState, runId, "Observed but never ended");
    seedAgentRunSeqPastCap(deps.agentRunSeq, runId);

    const timers = startGatewayMaintenanceTimers(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.agentRunSeq.has(runId)).toBe(false);
    expect(deps.chatRunState.lastSeenEventSeq.has(runId)).toBe(false);
    expect(deps.chatRunState.lastAcceptedSeq.has(runId)).toBe(false);
    expect(deps.chatRunState.waitingForRecovery.has(runId)).toBe(false);
    expect(deps.chatRunState.buffers.has(runId)).toBe(false);
    expect(deps.chatRunState.deltaLastBroadcastText.has(runId)).toBe(false);
    expect(deps.chatRunState.deltaSentAt.has(runId)).toBe(false);
    expect(deps.chatRunState.deltaLastBroadcastLen.has(runId)).toBe(false);

    stopMaintenanceTimers(timers);
  });

  it("preserves aborted markers during overflow eviction until a late terminal cleanup can consume them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(15_000);
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "client-aborted-overflow";

    seedEffectiveRunState(deps.chatRunState, runId, "Aborted text");
    deps.chatRunState.abortedRuns.set(runId, Date.now() - 500);
    seedAgentRunSeqPastCap(deps.agentRunSeq, runId);

    const timers = startGatewayMaintenanceTimers(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.agentRunSeq.has(runId)).toBe(false);
    expect(deps.chatRunState.abortedRuns.has(runId)).toBe(true);
    expect(deps.chatRunState.buffers.has(runId)).toBe(false);
    expect(deps.chatRunState.lastSeenEventSeq.has(runId)).toBe(false);
    expect(deps.chatRunState.lastAcceptedSeq.has(runId)).toBe(false);
    expect(deps.chatRunState.waitingForRecovery.has(runId)).toBe(false);
    expect(deps.chatRunState.deltaLastBroadcastText.has(runId)).toBe(false);
    expect(deps.chatRunState.deltaSentAt.has(runId)).toBe(false);
    expect(deps.chatRunState.deltaLastBroadcastLen.has(runId)).toBe(false);

    stopMaintenanceTimers(timers);
  });

  it("skips active chat keys during agentRunSeq overflow eviction", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const activeRunId = "client-active";
    const inactiveRunId = "client-inactive-old";

    seedEffectiveRunState(deps.chatRunState, activeRunId, "Active text");
    seedEffectiveRunState(deps.chatRunState, inactiveRunId, "Inactive text");
    deps.chatRunState.abortedRuns.set(inactiveRunId, Date.now() - 500);
    deps.chatAbortControllers.set(activeRunId, {
      controller: new AbortController(),
      sessionId: "session-active",
      sessionKey: "session-active",
      startedAtMs: Date.now() - 1_000,
      expiresAtMs: Date.now() + 60_000,
    });
    seedAgentRunSeqOverCapWithOlderRuns(deps.agentRunSeq, [activeRunId, inactiveRunId]);

    const timers = startGatewayMaintenanceTimers(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.agentRunSeq.has(activeRunId)).toBe(true);
    expect(deps.chatRunState.buffers.get(activeRunId)).toBe("Active text");
    expect(deps.chatRunState.lastSeenEventSeq.get(activeRunId)).toBe(3);
    expect(deps.chatRunState.lastAcceptedSeq.get(activeRunId)).toBe(2);
    expect(deps.chatRunState.waitingForRecovery.has(activeRunId)).toBe(true);
    expect(deps.chatRunState.deltaLastBroadcastText.get(activeRunId)).toBe("Active text");
    expect(deps.chatRunState.deltaLastBroadcastLen.get(activeRunId)).toBe("Active text".length);

    expect(deps.agentRunSeq.has(inactiveRunId)).toBe(false);
    expect(deps.chatRunState.abortedRuns.has(inactiveRunId)).toBe(true);
    expect(deps.chatRunState.buffers.has(inactiveRunId)).toBe(false);
    expect(deps.chatRunState.lastSeenEventSeq.has(inactiveRunId)).toBe(false);
    expect(deps.chatRunState.lastAcceptedSeq.has(inactiveRunId)).toBe(false);
    expect(deps.chatRunState.waitingForRecovery.has(inactiveRunId)).toBe(false);
    expect(deps.chatRunState.deltaLastBroadcastText.has(inactiveRunId)).toBe(false);
    expect(deps.chatRunState.deltaSentAt.has(inactiveRunId)).toBe(false);
    expect(deps.chatRunState.deltaLastBroadcastLen.has(inactiveRunId)).toBe(false);

    stopMaintenanceTimers(timers);
  });

  it("skips registry-backed active client runs during agentRunSeq overflow eviction even without an abort controller", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(35_000);
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const activeRunId = "client-registry-active";
    const inactiveRunId = "client-inactive-old";

    seedEffectiveRunState(deps.chatRunState, activeRunId, "Active text");
    seedEffectiveRunState(deps.chatRunState, inactiveRunId, "Inactive text");
    deps.chatRunState.registry.add("source-active", {
      sessionKey: "session-active",
      clientRunId: activeRunId,
    });
    seedAgentRunSeqOverCapWithOlderRuns(deps.agentRunSeq, [activeRunId, inactiveRunId]);

    const timers = startGatewayMaintenanceTimers(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.agentRunSeq.has(activeRunId)).toBe(true);
    expect(deps.chatRunState.buffers.get(activeRunId)).toBe("Active text");
    expect(deps.chatRunState.lastSeenEventSeq.get(activeRunId)).toBe(3);
    expect(deps.chatRunState.lastAcceptedSeq.get(activeRunId)).toBe(2);
    expect(deps.chatRunState.waitingForRecovery.has(activeRunId)).toBe(true);

    expect(deps.agentRunSeq.has(inactiveRunId)).toBe(false);
    expect(deps.chatRunState.buffers.has(inactiveRunId)).toBe(false);
    expect(deps.chatRunState.lastSeenEventSeq.has(inactiveRunId)).toBe(false);
    expect(deps.chatRunState.lastAcceptedSeq.has(inactiveRunId)).toBe(false);
    expect(deps.chatRunState.waitingForRecovery.has(inactiveRunId)).toBe(false);

    stopMaintenanceTimers(timers);
  });

  it("still evicts inactive overflow keys and clears their effective state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(40_000);
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const inactiveOldRunIds = ["client-inactive-1", "client-inactive-2"];

    for (const runId of inactiveOldRunIds) {
      seedEffectiveRunState(deps.chatRunState, runId, `State for ${runId}`);
    }
    seedAgentRunSeqOverCapWithOlderRuns(deps.agentRunSeq, inactiveOldRunIds, 2);

    const timers = startGatewayMaintenanceTimers(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    for (const runId of inactiveOldRunIds) {
      expect(deps.agentRunSeq.has(runId)).toBe(false);
      expect(deps.chatRunState.abortedRuns.has(runId)).toBe(false);
      expect(deps.chatRunState.buffers.has(runId)).toBe(false);
      expect(deps.chatRunState.lastSeenEventSeq.has(runId)).toBe(false);
      expect(deps.chatRunState.lastAcceptedSeq.has(runId)).toBe(false);
      expect(deps.chatRunState.waitingForRecovery.has(runId)).toBe(false);
      expect(deps.chatRunState.deltaLastBroadcastText.has(runId)).toBe(false);
      expect(deps.chatRunState.deltaSentAt.has(runId)).toBe(false);
      expect(deps.chatRunState.deltaLastBroadcastLen.has(runId)).toBe(false);
    }

    stopMaintenanceTimers(timers);
  });

  it("continues scanning past protected oldest runs until agentRunSeq is back under the cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(45_000);
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const protectedRunIds = ["client-active-1", "client-active-2", "client-active-3"];
    const evictedRunIds = ["client-evict-1", "client-evict-2", "client-evict-3"];

    for (const runId of [...protectedRunIds, ...evictedRunIds]) {
      seedEffectiveRunState(deps.chatRunState, runId, `State for ${runId}`);
    }
    deps.chatAbortControllers.set(protectedRunIds[0], {
      controller: new AbortController(),
      sessionId: "session-active-1",
      sessionKey: "session-active-1",
      startedAtMs: Date.now() - 1_000,
      expiresAtMs: Date.now() + 60_000,
    });
    deps.chatRunState.registry.add("source-active-2", {
      sessionKey: "session-active-2",
      clientRunId: protectedRunIds[1],
    });
    deps.chatRunState.registry.add("source-active-3", {
      sessionKey: "session-active-3",
      clientRunId: protectedRunIds[2],
    });
    seedAgentRunSeqOverCapWithOlderRuns(
      deps.agentRunSeq,
      [...protectedRunIds, ...evictedRunIds],
      3,
    );

    const timers = startGatewayMaintenanceTimers(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.agentRunSeq.size).toBe(10_000);
    for (const runId of protectedRunIds) {
      expect(deps.agentRunSeq.has(runId)).toBe(true);
      expect(deps.chatRunState.buffers.get(runId)).toBe(`State for ${runId}`);
      expect(deps.chatRunState.waitingForRecovery.has(runId)).toBe(true);
    }
    for (const runId of evictedRunIds) {
      expect(deps.agentRunSeq.has(runId)).toBe(false);
      expect(deps.chatRunState.buffers.has(runId)).toBe(false);
      expect(deps.chatRunState.lastSeenEventSeq.has(runId)).toBe(false);
      expect(deps.chatRunState.lastAcceptedSeq.has(runId)).toBe(false);
      expect(deps.chatRunState.waitingForRecovery.has(runId)).toBe(false);
    }

    stopMaintenanceTimers(timers);
  });

  it("prunes finalized tombstones after the maintenance ttl window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    deps.chatRunState.finalizedEffectiveRunKeys.set(
      "client-finalized-old",
      Date.now() - 11 * 60_000,
    );
    deps.chatRunState.finalizedEffectiveRunKeys.set(
      "client-finalized-fresh",
      Date.now() - 5 * 60_000,
    );

    const timers = startGatewayMaintenanceTimers(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.chatRunState.finalizedEffectiveRunKeys.has("client-finalized-old")).toBe(false);
    expect(deps.chatRunState.finalizedEffectiveRunKeys.has("client-finalized-fresh")).toBe(true);

    stopMaintenanceTimers(timers);
  });
});
