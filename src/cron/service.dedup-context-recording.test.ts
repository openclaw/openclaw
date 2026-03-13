import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createFinishedBarrier,
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

type CronAddInput = Parameters<CronService["add"]>[0];

function buildDedupJob(name: string): CronAddInput {
  return {
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test", dedupContext: true },
    delivery: { mode: "none" },
  };
}

describe("CronService dedup context recording", () => {
  it("records outputText in recentOutputs when dedupContext is enabled and delivered", async () => {
    const store = await makeStorePath();
    const finished = createFinishedBarrier();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok" as const,
        summary: "done",
        outputText: "Today's celebrity news: Actor X did Y",
        delivered: true,
      })),
      onEvent: (evt) => finished.onEvent(evt),
    });

    await cron.start();
    try {
      const job = await cron.add(buildDedupJob("dedup-record"));
      vi.setSystemTime(new Date(job.state.nextRunAtMs! + 5));
      await vi.runOnlyPendingTimersAsync();
      await finished.waitForOk(job.id);

      const jobs = await cron.list({ includeDisabled: true });
      const updated = jobs.find((j) => j.id === job.id);
      expect(updated?.state.recentOutputs).toBeDefined();
      expect(updated?.state.recentOutputs).toHaveLength(1);
      expect(updated?.state.recentOutputs![0].text).toBe("Today's celebrity news: Actor X did Y");
      expect(updated?.state.recentOutputs![0].timestamp).toBeGreaterThan(0);
    } finally {
      cron.stop();
    }
  });

  it("does not record when dedupContext is not enabled", async () => {
    const store = await makeStorePath();
    const finished = createFinishedBarrier();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok" as const,
        summary: "done",
        outputText: "some output",
        delivered: true,
      })),
      onEvent: (evt) => finished.onEvent(evt),
    });

    await cron.start();
    try {
      const job = await cron.add({
        ...buildDedupJob("no-dedup"),
        payload: { kind: "agentTurn", message: "test" },
      });
      vi.setSystemTime(new Date(job.state.nextRunAtMs! + 5));
      await vi.runOnlyPendingTimersAsync();
      await finished.waitForOk(job.id);

      const jobs = await cron.list({ includeDisabled: true });
      const updated = jobs.find((j) => j.id === job.id);
      expect(updated?.state.recentOutputs).toBeUndefined();
    } finally {
      cron.stop();
    }
  });

  it("does not record when delivery fails", async () => {
    const store = await makeStorePath();
    const finished = createFinishedBarrier();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok" as const,
        summary: "done",
        outputText: "some output",
        delivered: false,
      })),
      onEvent: (evt) => finished.onEvent(evt),
    });

    await cron.start();
    try {
      const job = await cron.add(buildDedupJob("no-delivery"));
      vi.setSystemTime(new Date(job.state.nextRunAtMs! + 5));
      await vi.runOnlyPendingTimersAsync();
      await finished.waitForOk(job.id);

      const jobs = await cron.list({ includeDisabled: true });
      const updated = jobs.find((j) => j.id === job.id);
      expect(updated?.state.recentOutputs).toBeUndefined();
    } finally {
      cron.stop();
    }
  });

  it("caps recentOutputs at 5 entries (FIFO)", async () => {
    const store = await makeStorePath();
    let runCount = 0;
    const finished = createFinishedBarrier();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        runCount++;
        return {
          status: "ok" as const,
          summary: "done",
          outputText: `output-${runCount}`,
          delivered: true,
        };
      }),
      onEvent: (evt) => finished.onEvent(evt),
    });

    await cron.start();
    try {
      const job = await cron.add(buildDedupJob("cap-test"));

      // Run 6 times
      for (let i = 0; i < 6; i++) {
        vi.setSystemTime(new Date(job.state.nextRunAtMs! + 5));
        await vi.runOnlyPendingTimersAsync();
        await finished.waitForOk(job.id);
        // Re-read job state for next iteration's nextRunAtMs
        const jobs = await cron.list({ includeDisabled: true });
        const updated = jobs.find((j) => j.id === job.id)!;
        Object.assign(job.state, updated.state);
      }

      const jobs = await cron.list({ includeDisabled: true });
      const updated = jobs.find((j) => j.id === job.id);
      expect(updated?.state.recentOutputs).toHaveLength(5);
      // Oldest (output-1) should be dropped, newest 5 remain
      expect(updated?.state.recentOutputs![0].text).toBe("output-2");
      expect(updated?.state.recentOutputs![4].text).toBe("output-6");
    } finally {
      cron.stop();
    }
  });

  it("truncates output text at 500 characters", async () => {
    const store = await makeStorePath();
    const finished = createFinishedBarrier();
    const longText = "x".repeat(600);
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok" as const,
        summary: "done",
        outputText: longText,
        delivered: true,
      })),
      onEvent: (evt) => finished.onEvent(evt),
    });

    await cron.start();
    try {
      const job = await cron.add(buildDedupJob("truncate-test"));
      vi.setSystemTime(new Date(job.state.nextRunAtMs! + 5));
      await vi.runOnlyPendingTimersAsync();
      await finished.waitForOk(job.id);

      const jobs = await cron.list({ includeDisabled: true });
      const updated = jobs.find((j) => j.id === job.id);
      expect(updated?.state.recentOutputs![0].text).toHaveLength(500);
    } finally {
      cron.stop();
    }
  });
});
