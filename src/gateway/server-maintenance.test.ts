import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "../commands/health.js";

const cleanOldMediaMock = vi.fn(async () => {});

vi.mock("../media/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/store.js")>();
  return {
    ...actual,
    cleanOldMedia: cleanOldMediaMock,
  };
});

describe("startGatewayMaintenanceTimers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("schedules periodic media cleanup with configured ttl", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
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
      removeChatRun: () => undefined,
      agentRunSeq: new Map(),
      nodeSendToSession: () => {},
      mediaTtlMs: 24 * 60 * 60 * 1000,
    });

    expect(cleanOldMediaMock).toHaveBeenCalledWith(24 * 60 * 60 * 1000);

    cleanOldMediaMock.mockClear();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(cleanOldMediaMock).toHaveBeenCalledWith(24 * 60 * 60 * 1000);

    clearInterval(timers.tickInterval);
    clearInterval(timers.healthInterval);
    clearInterval(timers.dedupeCleanup);
    clearInterval(timers.mediaCleanup);
  });
});
