// Regression: startup catch-up creates cron task-ledger rows before the timer
// loop is armed. Long catch-up runs still need the active-job marker so task
// maintenance does not reconcile them as lost while execution is in flight.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isCronJobActive, resetCronActiveJobsForTests } from "./active-jobs.js";
import { CronService } from "./service.js";
import {
  createDeferred,
  setupCronServiceSuite,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-active-jobs-startup-catchup-",
  baseTimeIso: "2026-06-14T09:00:00.000Z",
});

function createOverdueMainWakeNowJob(params: { id: string; nowMs: number }): CronJob {
  return {
    id: params.id,
    name: params.id.replaceAll("-", " "),
    enabled: true,
    createdAtMs: params.nowMs - 3_600_000,
    updatedAtMs: params.nowMs - 60_000,
    schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "startup catch-up" },
    state: { nextRunAtMs: params.nowMs - 60_000 },
  };
}

describe("cron activeJobIds — startup catch-up mark/clear", () => {
  beforeEach(() => {
    resetCronActiveJobsForTests();
  });

  it("marks a startup catch-up job active while its heartbeat run is still in flight", async () => {
    const store = await makeStorePath();
    const nowMs = Date.parse("2026-06-14T09:00:00.000Z");
    const jobId = "startup-catchup-active";
    const heartbeatEntered = createDeferred<void>();
    const releaseHeartbeat = createDeferred<{ status: "ran"; durationMs: number }>();

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [createOverdueMainWakeNowJob({ id: jobId, nowMs })],
    });

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runHeartbeatOnce: vi.fn(async () => {
        heartbeatEntered.resolve();
        return await releaseHeartbeat.promise;
      }),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    try {
      const startPromise = cron.start();
      await heartbeatEntered.promise;

      expect(isCronJobActive(jobId)).toBe(true);

      releaseHeartbeat.resolve({ status: "ran", durationMs: 1 });
      await startPromise;

      expect(isCronJobActive(jobId)).toBe(false);
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });
});
