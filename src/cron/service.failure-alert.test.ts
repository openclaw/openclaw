import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";

type CronServiceParams = ConstructorParameters<typeof CronService>[0];

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

function createFailureAlertCron(params: {
  storePath: string;
  cronConfig?: CronServiceParams["cronConfig"];
  runIsolatedAgentJob: NonNullable<CronServiceParams["runIsolatedAgentJob"]>;
  sendCronFailureAlert: NonNullable<CronServiceParams["sendCronFailureAlert"]>;
}) {
  return new CronService({
    storePath: params.storePath,
    cronEnabled: true,
    cronConfig: params.cronConfig,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: params.runIsolatedAgentJob,
    sendCronFailureAlert: params.sendCronFailureAlert,
  });
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

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 2,
          cooldownMs: 60_000,
        },
      },
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

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: false,
        },
      },
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
        to: "19098680",
      },
    });

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expect(sendCronFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({ id: job.id }),
        channel: "telegram",
        to: "19098680",
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
      error: "test error",
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "suppressed job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run" },
      failureAlert: false,
    });

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).not.toHaveBeenCalled();

    cron.stop();
    await store.cleanup();
  });

  it("preserves includeSkipped through failure alert updates", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "skipped" as const,
      error: "disabled",
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 2,
          cooldownMs: 60_000,
          includeSkipped: true,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "gateway restart",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "restart gateway if needed" },
      delivery: { mode: "announce", channel: "telegram", to: "19098680" },
    });

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).not.toHaveBeenCalled();

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expect(sendCronFailureAlert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "19098680",
        text: expect.stringMatching(
          /Cron job "gateway restart" skipped 2 times.*Skip reason: disabled/s,
        ),
      }),
    );

    const skippedJob = cron.getJob(job.id);
    expect(skippedJob?.state.consecutiveSkipped).toBe(2);
    expect(skippedJob?.state.consecutiveErrors).toBe(0);

    cron.stop();
    await store.cleanup();
  });

  it("threads failure alert mode/accountId and skips best-effort jobs", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "temporary upstream error",
    }));

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
          mode: "webhook",
          accountId: "global-account",
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const normalJob = await cron.add({
      name: "normal alert job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      delivery: { mode: "announce", channel: "telegram", to: "19098680" },
    });
    const bestEffortJob = await cron.add({
      name: "best effort alert job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run report" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "19098680",
        bestEffort: true,
      },
    });

    await cron.run(normalJob.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expect(sendCronFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "webhook",
        accountId: "global-account",
        to: undefined,
      }),
    );

    await cron.run(bestEffortJob.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);

    cron.stop();
    await store.cleanup();
  });

  it("includes event timestamp in failure alert body", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "test error",
    }));

    // Freeze time at a known timestamp so cron.run() sets lastRunAtMs = this value
    const eventTime = 1746477000000; // 2026-05-05T18:30:00.000Z
    vi.setSystemTime(eventTime);

    const cron = createFailureAlertCron({
      storePath: store.storePath,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
          cooldownMs: 60_000,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    await cron.add({
      name: "timestamped job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run" },
    });

    // run() will set job.state.lastRunAtMs = startedAt = eventTime (frozen timers)
    const job = await cron.add({
      name: "timestamped job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run" },
    });
    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);

    const alertText = sendCronFailureAlert.mock.calls[0][0].text;
    // Verify the alert text includes the ISO timestamp from the run time
    expect(alertText).toContain("Event time:");
    expect(alertText).toContain(new Date(eventTime).toISOString());

    cron.stop();
    await store.cleanup();
  });
});
