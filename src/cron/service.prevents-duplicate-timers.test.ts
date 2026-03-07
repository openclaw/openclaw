import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-" });
installCronTestHooks({
  logger: noopLogger,
  baseTimeIso: "2025-12-13T00:00:00.000Z",
});

describe("CronService", () => {
  it("avoids duplicate runs when two services share a store", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));

    const cronA = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
    });

    await cronA.start();
    const atMs = Date.parse("2025-12-13T00:00:01.000Z");
    await cronA.add({
      name: "shared store job",
      enabled: true,
      schedule: { kind: "at", at: new Date(atMs).toISOString() },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "hello" },
    });

    const cronB = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
    });

    await cronB.start();

    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await vi.runOnlyPendingTimersAsync();
    await cronA.status();
    await cronB.status();

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(requestHeartbeatNow).toHaveBeenCalledTimes(1);

    cronA.stop();
    cronB.stop();
    await store.cleanup();
  });

  it("does not spawn duplicate sessions when watchdog recheck timer fires near job completion", async () => {
    // Regression: avoid duplicate isolated spawns from watchdog recheck race.
    // We schedule a one-shot job 60s in the future, then simulate a long-running
    // job that exceeds the watchdog interval (60s) to trigger recheck mid-run.
    const store = await makeStorePath();
    const runIsolatedAgentJob = vi.fn(async () => {
      // Exceed watchdog interval to trigger recheck while running.
      await vi.advanceTimersByTimeAsync(65_000);
      return { status: "ok" as const };
    });
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
    });

    await cron.start();
    await cron.add({
      name: "long isolated job",
      enabled: true,
      schedule: { kind: "at", at: "2025-12-13T00:01:00.000Z" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "run task" },
    });

    // Advance time to when the job should fire and run all timers.
    // The job runs for 65s, triggering the watchdog recheck timer during execution.
    vi.setSystemTime(new Date("2025-12-13T00:01:00.000Z"));

    try {
      await vi.runAllTimersAsync();
      // The isolated job should have been spawned exactly once.
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });
});
