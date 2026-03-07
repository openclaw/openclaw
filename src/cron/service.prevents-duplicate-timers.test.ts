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
    // We force a long-running job so the recheck fires mid-run, then assert only one spawn.
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
    const atMs = Date.parse("2025-12-13T00:00:01.000Z");
    await cron.add({
      name: "long isolated job",
      enabled: true,
      schedule: { kind: "at", at: new Date(atMs).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "run task" },
    });

    // Advance time past the job's scheduled fire time.
    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    // Run all pending timers (fires the scheduler tick + watchdog recheck).
    await vi.runAllTimersAsync();

    // The isolated job should have been spawned exactly once.
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    cron.stop();
    await store.cleanup();
  });
});
