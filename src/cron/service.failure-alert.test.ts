import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-failure-alert-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

describe("CronService failure alerts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("alerts after configured consecutive failures and honors cooldown", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "wrong model id",
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 2,
          cooldownMs: 60_000,
        },
      },
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "daily report",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      delivery: { mode: "announce", channel: "telegram", to: "19098680" },
    });

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).not.toHaveBeenCalled();

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expect(sendCronFailureAlert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({ id: job.id }),
        channel: "telegram",
        to: "19098680",
        text: expect.stringContaining('Cron job "daily report" failed 2 times'),
      }),
    );

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);
    expect(sendCronFailureAlert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Cron job "daily report" failed 4 times'),
      }),
    );

    cron.stop();
    await store.cleanup();
  });

  it("supports per-job failure alert override when global alerts are disabled", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "timeout",
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      cronConfig: {
        failureAlert: {
          enabled: false,
        },
      },
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "job with override",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      failureAlert: {
        after: 1,
        channel: "telegram",
        to: "12345",
        cooldownMs: 1,
      },
    });

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expect(sendCronFailureAlert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "12345",
      }),
    );

    cron.stop();
    await store.cleanup();
  });

  it("respects per-job failureAlert=false and suppresses alerts", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "auth error",
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
        },
      },
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "disabled alert job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      failureAlert: false,
    });

    await cron.run(job.id, "force");
    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).not.toHaveBeenCalled();

    cron.stop();
    await store.cleanup();
  });
});
