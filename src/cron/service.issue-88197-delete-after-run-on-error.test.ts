import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";

type CronServiceParams = ConstructorParameters<typeof CronService>[0];

// Regression for #88197: a one-shot `deleteAfterRun` job that fails permanently
// (or exhausts its retries) was disabled but kept in the store forever. Real
// listener-spawn isolated turns that hit "isolated agent setup timed out before
// runner start" accumulated as enabled=false orphans. A `deleteAfterRun` job
// means "run once, then delete" and must be removed once it is done running,
// regardless of run success.

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-88197-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function createCron(params: {
  storePath: string;
  cronConfig?: CronServiceParams["cronConfig"];
  runIsolatedAgentJob: NonNullable<CronServiceParams["runIsolatedAgentJob"]>;
}) {
  return new CronService({
    storePath: params.storePath,
    cronEnabled: true,
    cronConfig: params.cronConfig,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: params.runIsolatedAgentJob,
  });
}

async function addOneShotIsolatedJob(
  cron: CronService,
  params: { atMs: number; name: string; deleteAfterRun: boolean },
) {
  return cron.add({
    name: params.name,
    enabled: true,
    deleteAfterRun: params.deleteAfterRun,
    schedule: { kind: "at", at: new Date(params.atMs).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "spawn isolated turn" },
  });
}

describe("cron deleteAfterRun on permanent/exhausted error (#88197)", () => {
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

  it("deletes a deleteAfterRun one-shot after a non-retryable error", async () => {
    const store = await makeStorePath();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "isolated agent setup failed: invalid configuration",
    }));
    const cron = createCron({ storePath: store.storePath, runIsolatedAgentJob });

    await cron.start();
    const job = await addOneShotIsolatedJob(cron, {
      atMs: Date.parse("2026-01-01T00:00:02.000Z"),
      name: "listener-spawn",
      deleteAfterRun: true,
    });

    await cron.run(job.id, "force");

    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    // The failed deleteAfterRun job must not linger as an orphan.
    expect(cron.getJob(job.id)).toBeUndefined();

    cron.stop();
    await store.cleanup();
  });

  it("deletes a deleteAfterRun one-shot after retries are exhausted on the issue's timeout error", async () => {
    const store = await makeStorePath();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "isolated agent setup timed out before runner start",
    }));
    // Exhaust retries immediately so the single run reaches the permanent path.
    const cron = createCron({
      storePath: store.storePath,
      cronConfig: { retry: { maxAttempts: 0 } },
      runIsolatedAgentJob,
    });

    await cron.start();
    const job = await addOneShotIsolatedJob(cron, {
      atMs: Date.parse("2026-01-01T00:00:02.000Z"),
      name: "listener-spawn-timeout",
      deleteAfterRun: true,
    });

    await cron.run(job.id, "force");

    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(cron.getJob(job.id)).toBeUndefined();

    cron.stop();
    await store.cleanup();
  });

  it("keeps a failed one-shot in the store when deleteAfterRun is not set", async () => {
    const store = await makeStorePath();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "isolated agent setup failed: invalid configuration",
    }));
    const cron = createCron({ storePath: store.storePath, runIsolatedAgentJob });

    await cron.start();
    const job = await addOneShotIsolatedJob(cron, {
      atMs: Date.parse("2026-01-01T00:00:02.000Z"),
      name: "keep-for-inspection",
      deleteAfterRun: false,
    });

    await cron.run(job.id, "force");

    // Without deleteAfterRun the disabled job is retained for inspection.
    const kept = cron.getJob(job.id);
    expect(kept).toBeDefined();
    expect(kept?.enabled).toBe(false);
    expect(kept?.state.lastStatus).toBe("error");

    cron.stop();
    await store.cleanup();
  });
});
