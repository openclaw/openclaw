import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startHeartbeatRunner } from "./heartbeat-runner.js";
import type { OpenClawConfig } from "../config/config.js";
import { CommandLane } from "../process/lanes.js";

describe("heartbeat runner: force execution after timeout", () => {
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup?.();
    vi.useRealTimers();
  });

  it("should force heartbeat execution after 5 minutes of queue contention", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: {
            every: "1m",
            target: "none",
          },
        },
      },
    };

    let queueSize = 1; // Simulate busy queue
    const mockGetQueueSize = vi.fn(() => queueSize);
    const runResults: string[] = [];

    const runner = startHeartbeatRunner({
      cfg,
      deps: {
        getQueueSize: mockGetQueueSize,
        nowMs: () => Date.now(),
      },
      runOnce: async () => {
        if (queueSize > 0) {
          return { status: "skipped", reason: "requests-in-flight" };
        }
        runResults.push("ran");
        return { status: "ran" };
      },
    });
    cleanup = runner.stop;

    // Advance 1 minute - should skip due to queue
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runResults).toHaveLength(0);

    // Advance 4 more minutes (total 5 min) - should still skip
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(runResults).toHaveLength(0);

    // Advance 1 more second (total 5min 1s) - should force execution even with queue busy
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runResults).toHaveLength(1);
    expect(runResults[0]).toBe("ran");
    
    // Verify next heartbeat respects queue again
    queueSize = 1;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runResults).toHaveLength(1); // Still 1, didn't run due to queue
  });

  it("should reset skip tracking when queue clears", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: {
            every: "1m",
            target: "none",
          },
        },
      },
    };

    let queueSize = 1;
    const mockGetQueueSize = vi.fn(() => queueSize);

    const runner = startHeartbeatRunner({
      cfg,
      deps: {
        getQueueSize: mockGetQueueSize,
      },
      runOnce: async () => {
        if (queueSize > 0) {
          return { status: "skipped", reason: "requests-in-flight" };
        }
        return { status: "ran" };
      },
    });
    cleanup = runner.stop;

    // Skip for 2 minutes
    await vi.advanceTimersByTimeAsync(2 * 60_000);

    // Clear queue
    queueSize = 0;
    await vi.advanceTimersByTimeAsync(60_000);

    // Queue busy again - should restart timeout from 0
    queueSize = 1;
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    
    // Should not force yet (only 4 min since last clear)
    expect(mockGetQueueSize).toHaveBeenCalled();
  });
});
