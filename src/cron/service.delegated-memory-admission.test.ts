import os from "node:os";
import { expect, it, vi } from "vitest";
import * as cron from "../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { start, stop } from "./service/ops-lifecycle.js";
import { waitForCronRunQueue } from "./service/run-queue.js";
import { captureCronSchedulerWakeForTest } from "./service/scheduler-actor.test-support.js";
import { loadCronStore, saveCronStore } from "./store.js";

const controllers = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) =>
      controllers.get(String(args[0])) ?? fs.readFileSync(...args),
  };
});

const fixtures = cron.setupCronRegressionFixtures({ prefix: "cron-delegated-memory-" });

it.skipIf(process.platform !== "linux" || Boolean(process.versions.bun))(
  "admits an extra run only when the delegated service has at least 1 GiB free",
  async () => {
    const GiB = 1024 ** 3;
    const mount = "/sys/fs/cgroup";
    const leaf = `${mount}/service`;
    controllers.set("/proc/self/cgroup", "0::/pod/service");
    controllers.set("/proc/self/mountinfo", `30 1 0:27 /pod ${mount} rw - cgroup2 cgroup rw`);
    controllers.set(`${leaf}/memory.max`, String(2 * GiB));
    controllers.set(`${leaf}/memory.high`, "max");
    controllers.set(`${leaf}/memory.current`, String(GiB + 1));
    const total = vi.spyOn(os, "totalmem").mockReturnValue(8 * GiB);
    const native = vi.spyOn(process, "availableMemory").mockReturnValue(3 * GiB);
    const finish = createDeferred();
    let now = Date.parse("2026-02-06T10:08:00.000Z");
    const due = now + 1_000;
    const { storePath } = fixtures.makeStorePath();
    const jobs = Array.from({ length: 10 }, (_, i) =>
      cron.createDueIsolatedJob({ id: `job-${i}`, nowMs: now, nextRunAtMs: due }),
    );
    await saveCronStore(storePath, { version: 1, jobs });
    const running = async () =>
      (await loadCronStore(storePath)).jobs.filter((job) => job.state.runningAtMs !== undefined);
    const state = cron.createCronRegressionState({
      storePath,
      nowMs: () => now,
      runIsolatedAgentJob: async () => {
        await finish.promise;
        return { status: "ok" as const, summary: "done" };
      },
    });
    try {
      const scheduler = await captureCronSchedulerWakeForTest(() => start(state));
      now = due;
      await scheduler.wake(state);
      expect(await running()).toHaveLength(8);
      native.mockReturnValue(0);
      controllers.set(`${leaf}/memory.current`, String(GiB));
      await scheduler.wake(state);
      expect(await running()).toHaveLength(9);
      // This membership is outside the delegated view, so its free capacity is unknown.
      controllers.set("/proc/self/cgroup", "0::/elsewhere");
      native.mockReturnValue(3 * GiB);
      await scheduler.wake(state);
      expect(await running()).toHaveLength(9);
    } finally {
      finish.resolve();
      await waitForCronRunQueue(state);
      stop(state);
      controllers.clear();
      native.mockRestore();
      total.mockRestore();
    }
  },
);
