import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCronStoreHarness,
  createNoopLogger,
  createStartedCronServiceWithFinishedBarrier,
  installCronTestHooks,
} from "./service.test-harness.js";
import { markChainedJobsDue } from "./service/timer.js";
import type { CronJob } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

afterEach(() => {
  vi.useRealTimers();
});

describe("cron triggerOnCompletionOf", () => {
  it("markChainedJobsDue sets nextRunAtMs for jobs chained to finished job", () => {
    const nowMs = 1000;
    const jobA: CronJob = {
      id: "job-a",
      name: "A",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "a" },
      state: {},
    };
    const jobB: CronJob = {
      id: "job-b",
      name: "B",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every", everyMs: 60_000 },
      triggerOnCompletionOf: "job-a",
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "b" },
      state: {},
    };
    const state = {
      store: { jobs: [jobA, jobB] },
      deps: { nowMs: () => nowMs },
    } as Parameters<typeof markChainedJobsDue>[0];

    markChainedJobsDue(state, "job-a", nowMs);

    expect(jobB.state.nextRunAtMs).toBe(nowMs);
    expect(jobB.updatedAtMs).toBe(nowMs);
    expect(jobA.state.nextRunAtMs).toBeUndefined();
  });

  it("createJob throws when triggerOnCompletionOf references unknown job id", async () => {
    const store = await makeStorePath();
    const { cron } = createStartedCronServiceWithFinishedBarrier({
      storePath: store.storePath,
      logger: noopLogger,
    });
    await cron.start();
    try {
      await expect(
        cron.add({
          name: "chained",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "systemEvent", text: "chained" },
          triggerOnCompletionOf: "nonexistent-id",
        }),
      ).rejects.toThrow(/unknown job id: nonexistent-id/);
    } finally {
      cron.stop();
    }
  });

  it("createJob accepts triggerOnCompletionOf when referenced job exists", async () => {
    const store = await makeStorePath();
    const { cron } = createStartedCronServiceWithFinishedBarrier({
      storePath: store.storePath,
      logger: noopLogger,
    });
    await cron.start();

    const jobA = await cron.add({
      name: "A",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "a" },
    });
    const jobB = await cron.add({
      name: "B",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "b" },
      triggerOnCompletionOf: jobA.id,
    });

    expect(jobB.triggerOnCompletionOf).toBe(jobA.id);
  });

  it("update rejects triggerOnCompletionOf that would create a cycle", async () => {
    const store = await makeStorePath();
    const { cron } = createStartedCronServiceWithFinishedBarrier({
      storePath: store.storePath,
      logger: noopLogger,
    });
    await cron.start();

    const jobA = await cron.add({
      name: "A",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "a" },
    });
    const jobB = await cron.add({
      name: "B",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "b" },
      triggerOnCompletionOf: jobA.id,
    });

    await expect(cron.update(jobA.id, { triggerOnCompletionOf: jobB.id })).rejects.toThrow(
      /would create a cycle/,
    );
  });

  it("update rejects triggerOnCompletionOf when job references itself", async () => {
    const store = await makeStorePath();
    const { cron } = createStartedCronServiceWithFinishedBarrier({
      storePath: store.storePath,
      logger: noopLogger,
    });
    await cron.start();

    const job = await cron.add({
      name: "self",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "self" },
    });

    await expect(cron.update(job.id, { triggerOnCompletionOf: job.id })).rejects.toThrow(
      /would create a cycle/,
    );
  });
});
