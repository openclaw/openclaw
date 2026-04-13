import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-null-state-",
  baseTimeIso: "2025-12-13T00:00:00.000Z",
});

describe("CronService startup with null/missing job.state (#65916)", () => {
  async function writeStoreJobs(storePath: string, jobs: unknown[]) {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs }, null, 2), "utf-8");
  }

  it("starts without crashing when a job has state: null", async () => {
    const store = await makeStorePath();
    await writeStoreJobs(store.storePath, [
      {
        id: "null-state-job",
        name: "null state",
        enabled: true,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "tick" },
        state: null,
      },
    ]);

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await expect(cron.start()).resolves.not.toThrow();
    cron.stop();
  });

  it("starts without crashing when a job has no state field", async () => {
    const store = await makeStorePath();
    // Write a job that omits the state field entirely
    await writeStoreJobs(store.storePath, [
      {
        id: "missing-state-job",
        name: "missing state",
        enabled: true,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "tick" },
      },
    ]);

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await expect(cron.start()).resolves.not.toThrow();
    cron.stop();
  });

  it("lists jobs without crashing when a job has state: null", async () => {
    const store = await makeStorePath();
    await writeStoreJobs(store.storePath, [
      {
        id: "null-state-list-job",
        name: "null state list",
        enabled: true,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "tick" },
        state: null,
      },
    ]);

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await cron.start();
    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.id).toBe("null-state-list-job");
    cron.stop();
  });
});
