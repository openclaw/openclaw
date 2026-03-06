import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import type { CronEvent } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

/** Like createFinishedBarrier but resolves for any "finished" status (ok, skipped, error). */
function createAnyFinishedBarrier() {
  const resolvers = new Map<string, (evt: CronEvent) => void>();
  return {
    waitForFinished: (jobId: string) =>
      new Promise<CronEvent>((resolve) => {
        resolvers.set(jobId, resolve);
      }),
    onEvent: (evt: CronEvent) => {
      if (evt.action !== "finished") {
        return;
      }
      const resolve = resolvers.get(evt.jobId);
      if (!resolve) {
        return;
      }
      resolvers.delete(evt.jobId);
      resolve(evt);
    },
  };
}

async function withIsolatedAgentCron(
  runIsolatedAgentJob: ReturnType<typeof vi.fn>,
  run: (params: {
    cron: CronService;
    finished: ReturnType<typeof createAnyFinishedBarrier>;
  }) => Promise<void>,
) {
  const { storePath } = await makeStorePath();
  const finished = createAnyFinishedBarrier();
  const cron = new CronService({
    storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob,
    onEvent: finished.onEvent,
  });
  await run({ cron, finished });
}

describe("cron gate check", () => {
  it("runs LLM when gate command exits 0", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
    await withIsolatedAgentCron(runIsolatedAgentJob, async ({ cron, finished }) => {
      const job = await cron.add({
        name: "gate-pass test",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "agentTurn",
          message: "do the work",
          gate: { command: "exit 0" },
        },
      });

      vi.setSystemTime(new Date(job.state.nextRunAtMs! + 5));
      await vi.runOnlyPendingTimersAsync();
      await finished.waitForFinished(job.id);

      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      const jobs = await cron.list({ includeDisabled: true });
      expect(jobs[0]?.state.lastRunStatus).toBe("ok");
    });
  });

  it("skips LLM and sets status=skipped when gate exits non-zero", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
    await withIsolatedAgentCron(runIsolatedAgentJob, async ({ cron, finished }) => {
      const job = await cron.add({
        name: "gate-fail test",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "agentTurn",
          message: "do the work",
          gate: { command: "exit 1" },
        },
      });

      vi.setSystemTime(new Date(job.state.nextRunAtMs! + 5));
      await vi.runOnlyPendingTimersAsync();
      await finished.waitForFinished(job.id);

      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      const jobs = await cron.list({ includeDisabled: true });
      expect(jobs[0]?.state.lastRunStatus).toBe("skipped");
      expect(jobs[0]?.state.lastError).toMatch(/gate/i);
    });
  });

  it("does not increment consecutiveErrors when gate skips", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
    await withIsolatedAgentCron(runIsolatedAgentJob, async ({ cron, finished }) => {
      const job = await cron.add({
        name: "gate-no-error-count test",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "agentTurn",
          message: "check inbox",
          gate: { command: "exit 1" },
        },
      });

      vi.setSystemTime(new Date(job.state.nextRunAtMs! + 5));
      await vi.runOnlyPendingTimersAsync();
      await finished.waitForFinished(job.id);

      const jobs = await cron.list({ includeDisabled: true });
      // Skipped jobs must not accumulate consecutiveErrors (no backoff penalty)
      expect(jobs[0]?.state.consecutiveErrors ?? 0).toBe(0);
    });
  });

  it("runs without gate when gate field is absent", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
    await withIsolatedAgentCron(runIsolatedAgentJob, async ({ cron, finished }) => {
      const job = await cron.add({
        name: "no-gate test",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "do it" },
      });

      vi.setSystemTime(new Date(job.state.nextRunAtMs! + 5));
      await vi.runOnlyPendingTimersAsync();
      await finished.waitForFinished(job.id);

      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      const jobs = await cron.list({ includeDisabled: true });
      expect(jobs[0]?.state.lastRunStatus).toBe("ok");
    });
  });
});
