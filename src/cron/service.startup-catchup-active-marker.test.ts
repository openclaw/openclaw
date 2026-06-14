// Regression: startup catch-up command jobs must set the active marker so
// long-running runs are not reconciled as "lost" while still in flight.
// See https://github.com/openclaw/openclaw/issues/91695
import { beforeEach, describe, expect, it } from "vitest";
import { isCronJobActive, resetCronActiveJobsForTests } from "./active-jobs.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const BASE_TIME_ISO = "2025-12-13T17:00:00.000Z";
const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-startup-catchup-active-marker-",
  baseTimeIso: BASE_TIME_ISO,
});

function createMissedCommandJob(id: string): CronJob {
  const now = Date.parse(BASE_TIME_ISO);
  return {
    id,
    name: id.replaceAll("-", " "),
    enabled: true,
    createdAtMs: now - 3_600_000,
    updatedAtMs: now - 3_600_000,
    schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "command", argv: ["echo", "nightly-backup"] },
    delivery: { mode: "none" },
    state: {
      // A slot due an hour ago that the gateway "missed" while it was down.
      nextRunAtMs: now - 3_600_000,
      lastRunAtMs: now - 7_200_000,
    },
  };
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function createStartupCatchupHarness(jobId: string) {
  const store = await makeStorePath();
  await writeCronStoreSnapshot({
    storePath: store.storePath,
    jobs: [createMissedCommandJob(jobId)],
  });

  const entered = createDeferred();
  const release = createDeferred();
  const cron = new CronService({
    storePath: store.storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: () => {},
    requestHeartbeat: () => {},
    runCommandJob: async () => {
      entered.resolve();
      await release.promise;
      return { status: "ok" as const, summary: "ok" };
    },
  });
  return { cron, entered, release, store };
}

describe("cron activeJobIds — startup catch-up mark/clear", () => {
  beforeEach(() => {
    resetCronActiveJobsForTests();
  });

  it("marks the job active while a missed command job is replayed on startup", async () => {
    const { cron, entered, release, store } = await createStartupCatchupHarness("catchup-command");
    try {
      // start() awaits the in-flight catch-up run, so kick it off without await.
      const startPromise = cron.start();
      await entered.promise;

      // The job should be marked active while the command is still running.
      expect(isCronJobActive("catchup-command")).toBe(true);

      release.resolve();
      await startPromise;

      // After the run completes, the active marker should be cleared.
      expect(isCronJobActive("catchup-command")).toBe(false);
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("clears the active marker after a startup catch-up command job errors", async () => {
    const store = await makeStorePath();
    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [createMissedCommandJob("catchup-error")],
    });

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: () => {},
      requestHeartbeat: () => {},
      runCommandJob: async () => {
        throw new Error("command failed");
      },
    });

    try {
      await cron.start();
      // After an error, the active marker should still be cleared.
      expect(isCronJobActive("catchup-error")).toBe(false);
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });
});
