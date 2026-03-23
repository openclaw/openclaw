import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "../commands/health.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";

const cleanOldMediaMock = vi.fn(async () => {});
const processPendingReceiptsMock = vi.fn(() => ({
  processed: 0,
  applied: 0,
  requeued: 0,
  remaining: 0,
}));

vi.mock("../media/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/store.js")>();
  return {
    ...actual,
    cleanOldMedia: cleanOldMediaMock,
  };
});

vi.mock("../operator-control/task-store.js", () => ({
  processPendingReceipts: processPendingReceiptsMock,
}));

const MEDIA_CLEANUP_TTL_MS = 24 * 60 * 60_000;
const ABORTED_RUN_TTL_MS = 60 * 60_000;

function createActiveRun(sessionKey: string): ChatAbortControllerEntry {
  const now = Date.now();
  return {
    controller: new AbortController(),
    sessionId: "sess-1",
    sessionKey,
    startedAtMs: now,
    expiresAtMs: now + ABORTED_RUN_TTL_MS,
  };
}

function createMaintenanceTimerDeps() {
  return {
    broadcast: () => {},
    nodeSendToAllSubscribed: () => {},
    getPresenceVersion: () => 1,
    getHealthVersion: () => 1,
    refreshGatewayHealthSnapshot: async () => ({ ok: true }) as HealthSummary,
    logHealth: { error: () => {} },
    dedupe: new Map(),
    chatAbortControllers: new Map(),
    chatRunState: { abortedRuns: new Map() },
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatDeltaLastBroadcastLen: new Map(),
    removeChatRun: () => undefined,
    agentRunSeq: new Map(),
    nodeSendToSession: () => {},
  };
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

  it("replays pending operator receipts on the maintenance interval", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
    });

    processPendingReceiptsMock.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(processPendingReceiptsMock).toHaveBeenCalledTimes(1);

    stopMaintenanceTimers(timers);
  });
});
