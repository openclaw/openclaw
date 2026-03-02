import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-heartbeat-ok-suppressed",
});

describe("cron isolated job HEARTBEAT_OK summary suppression (#32013)", () => {
  it("does not enqueue HEARTBEAT_OK as a system event to the main session", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job: CronJob = {
      id: "heartbeat-only-job",
      name: "heartbeat-only-job",
      enabled: true,
      createdAtMs: now - 10_000,
      updatedAtMs: now - 10_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Check if anything is new" },
      delivery: { mode: "announce" },
      state: { nextRunAtMs: now - 1 },
    };

    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runHeartbeatOnce: vi.fn(),
      // Simulate the isolated agent returning HEARTBEAT_OK — nothing to
      // announce. The delivery was intentionally skipped.
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok" as const,
        summary: "HEARTBEAT_OK",
        delivered: false,
        deliveryAttempted: false,
      })),
    });

    await cron.start();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1_000);
    cron.stop();

    // HEARTBEAT_OK should NOT leak into the main session as a system event.
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
  });

  it("still enqueues real cron summaries as system events", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job: CronJob = {
      id: "real-summary-job",
      name: "real-summary-job",
      enabled: true,
      createdAtMs: now - 10_000,
      updatedAtMs: now - 10_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Check weather" },
      delivery: { mode: "announce" },
      state: { nextRunAtMs: now - 1 },
    };

    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runHeartbeatOnce: vi.fn(),
      // Simulate real content that should be forwarded.
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok" as const,
        summary: "Weather update: sunny, 72°F",
        delivered: false,
        deliveryAttempted: false,
      })),
    });

    await cron.start();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1_000);
    cron.stop();

    // Real summaries SHOULD be enqueued.
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("Weather update"),
      expect.objectContaining({ agentId: undefined }),
    );
  });
});
