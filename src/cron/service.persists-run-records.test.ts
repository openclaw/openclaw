import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  createStartedCronServiceWithFinishedBarrier,
  installCronTestHooks,
} from "./service.test-harness.js";
import { loadCronStore } from "./store.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-run-records-" });
installCronTestHooks({ logger: noopLogger });

type CronAddInput = Parameters<CronService["add"]>[0];

function buildMainSessionSystemEventJob(name: string): CronAddInput {
  return {
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "tick" },
  };
}

function buildIsolatedAgentTurnJob(name: string): CronAddInput {
  return {
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test" },
    delivery: { mode: "none" },
  };
}

describe("CronService persists durable run records", () => {
  it("persists a finalized run record for scheduled main-session cron", async () => {
    const store = await makeStorePath();
    const { cron, finished } = createStartedCronServiceWithFinishedBarrier({
      storePath: store.storePath,
      logger: noopLogger,
    });

    await cron.start();
    try {
      const job = await cron.add(buildMainSessionSystemEventJob("main-run-record"));
      vi.setSystemTime(new Date(job.state.nextRunAtMs! + 5));
      await vi.runOnlyPendingTimersAsync();
      await finished.waitForOk(job.id);
      await cron.list({ includeDisabled: true });

      const loaded = await loadCronStore(store.storePath);
      expect(loaded.runs).toHaveLength(1);
      expect(loaded.runs?.[0]).toMatchObject({
        jobId: job.id,
        trigger: "due",
        status: "ok",
        summary: "tick",
      });
      expect(loaded.runs?.[0]?.runId).toMatch(/^cron:/);
      expect(loaded.runs?.[0]?.endedAtMs).toBeTypeOf("number");
    } finally {
      cron.stop();
    }
  });

  it("persists a finalized run record for manual cron runs", async () => {
    const store = await makeStorePath();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok" as const,
        summary: "done",
        delivered: true,
        sessionId: "sess-123",
        sessionKey: "agent:main:cron:job-1:run:sess-123",
      })),
    });

    await cron.start();
    try {
      const job = await cron.add(buildIsolatedAgentTurnJob("manual-run-record"));
      await cron.run(job.id, "force");

      const loaded = await loadCronStore(store.storePath);
      expect(loaded.runs).toHaveLength(1);
      expect(loaded.runs?.[0]).toMatchObject({
        jobId: job.id,
        trigger: "manual",
        status: "ok",
        summary: "done",
        delivered: true,
        sessionId: "sess-123",
      });
    } finally {
      cron.stop();
    }
  });

  it("marks stale running run records as interrupted on startup", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const staleStore = {
      version: 1 as const,
      jobs: [
        {
          id: "job-1",
          name: "Interrupted job",
          enabled: true,
          createdAtMs: now - 60_000,
          updatedAtMs: now - 60_000,
          schedule: { kind: "every" as const, everyMs: 60_000 },
          sessionTarget: "main" as const,
          wakeMode: "next-heartbeat" as const,
          payload: { kind: "systemEvent" as const, text: "tick" },
          state: {
            runningAtMs: now - 5_000,
          },
        },
      ],
      runs: [
        {
          runId: "cron:job-1:stale",
          jobId: "job-1",
          trigger: "due" as const,
          startedAtMs: now - 5_000,
          status: "running" as const,
        },
      ],
    };
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, JSON.stringify(staleStore, null, 2), "utf-8");
    vi.setSystemTime(new Date(now));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await cron.start();
    cron.stop();

    const loaded = await loadCronStore(store.storePath);
    expect(loaded.runs?.[0]).toMatchObject({
      runId: "cron:job-1:stale",
      status: "error",
      error: "gateway restarted before cron run completed",
    });
    expect(loaded.runs?.[0]?.endedAtMs).toBeTypeOf("number");
  });
});
