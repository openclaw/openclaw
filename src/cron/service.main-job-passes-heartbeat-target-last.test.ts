import { describe, expect, it, vi } from "vitest";
import type { HeartbeatRunResult } from "../infra/heartbeat-wake.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-main-heartbeat-target",
});

describe("cron main job passes heartbeat target=last", () => {
  it("should pass heartbeat.target=last to runHeartbeatOnce for wakeMode=now main jobs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job: CronJob = {
      id: "test-main-delivery",
      name: "test-main-delivery",
      enabled: true,
      createdAtMs: now - 10_000,
      updatedAtMs: now - 10_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "Check in" },
      state: { nextRunAtMs: now - 1 },
    };

    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runHeartbeatOnce = vi.fn<
      (opts?: {
        reason?: string;
        agentId?: string;
        sessionKey?: string;
        heartbeat?: { target?: string };
      }) => Promise<HeartbeatRunResult>
    >(async () => ({
      status: "ran" as const,
      durationMs: 50,
    }));

    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runHeartbeatOnce,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await cron.start();

    // Wait for the timer to fire
    await vi.advanceTimersByTimeAsync(2_000);

    // Give the async run a chance to complete
    await vi.advanceTimersByTimeAsync(1_000);

    cron.stop();

    // runHeartbeatOnce should have been called
    expect(runHeartbeatOnce).toHaveBeenCalled();

    // The heartbeat config passed should include target: "last" so the
    // heartbeat runner delivers the response to the last active channel.
    const callArgs = runHeartbeatOnce.mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.heartbeat).toBeDefined();
    expect(callArgs?.heartbeat?.target).toBe("last");
  });

  it("should not pass heartbeat target for wakeMode=next-heartbeat main jobs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job: CronJob = {
      id: "test-next-heartbeat",
      name: "test-next-heartbeat",
      enabled: true,
      createdAtMs: now - 10_000,
      updatedAtMs: now - 10_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "Check in" },
      state: { nextRunAtMs: now - 1 },
    };

    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runHeartbeatOnce = vi.fn(async () => ({
      status: "ran" as const,
      durationMs: 50,
    }));

    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runHeartbeatOnce,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await cron.start();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1_000);
    cron.stop();

    // wakeMode=next-heartbeat uses requestHeartbeatNow, not runHeartbeatOnce
    expect(requestHeartbeatNow).toHaveBeenCalled();
    // runHeartbeatOnce should NOT have been called for next-heartbeat mode
    expect(runHeartbeatOnce).not.toHaveBeenCalled();
  });
});
