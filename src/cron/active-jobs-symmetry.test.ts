import { beforeEach, describe, expect, it } from "vitest";
import { isCronJobActive, resetCronActiveJobsForTests } from "./active-jobs.js";
import { CronService } from "./service.js";
import {
  createDeferred,
  setupCronServiceSuite,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-active-jobs-symmetry-",
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});

type IsolatedRunResult = Awaited<
  ReturnType<NonNullable<ConstructorParameters<typeof CronService>[0]["runIsolatedAgentJob"]>>
>;

describe("cron activeJobIds — mark/clear symmetry across execution paths", () => {
  beforeEach(() => {
    resetCronActiveJobsForTests();
  });

  it("startup catchup marks the job active during execution and clears it on completion (#68157)", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2025-12-13T17:00:00.000Z");
    const overdueAt = now - 60_000;

    const jobs: CronJob[] = [
      {
        id: "catchup-isolated",
        name: "catchup isolated",
        enabled: true,
        createdAtMs: overdueAt - 3_600_000,
        updatedAtMs: overdueAt,
        schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hi" },
        delivery: { mode: "none" },
        state: {
          nextRunAtMs: overdueAt,
        },
      },
    ];

    await writeCronStoreSnapshot({ storePath: store.storePath, jobs });

    const entered = createDeferred<void>();
    const release = createDeferred<IsolatedRunResult>();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: () => {},
      requestHeartbeatNow: () => {},
      runIsolatedAgentJob: async () => {
        entered.resolve();
        return await release.promise;
      },
    });

    try {
      const startPromise = cron.start();

      await entered.promise;

      expect(isCronJobActive("catchup-isolated")).toBe(true);

      release.resolve({ status: "ok", summary: "ok" });
      await startPromise;

      expect(isCronJobActive("catchup-isolated")).toBe(false);
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("manual run marks the job active during execution and clears it even when the inner throws (#68157)", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2025-12-13T17:00:00.000Z");
    const futureNext = now + 3_600_000;

    const jobs: CronJob[] = [
      {
        id: "manual-isolated",
        name: "manual isolated",
        enabled: true,
        createdAtMs: now - 3_600_000,
        updatedAtMs: now,
        schedule: { kind: "cron", expr: "0 18 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hi" },
        delivery: { mode: "none" },
        state: {
          nextRunAtMs: futureNext,
        },
      },
    ];

    await writeCronStoreSnapshot({ storePath: store.storePath, jobs });

    const entered = createDeferred<void>();
    const release = createDeferred<IsolatedRunResult>();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: () => {},
      requestHeartbeatNow: () => {},
      runIsolatedAgentJob: async () => {
        entered.resolve();
        return await release.promise;
      },
    });

    try {
      await cron.start();

      const runPromise = cron.run("manual-isolated", "force");
      await entered.promise;

      expect(isCronJobActive("manual-isolated")).toBe(true);

      release.reject(new Error("synthetic inner failure"));
      await runPromise;

      expect(isCronJobActive("manual-isolated")).toBe(false);
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });
});
