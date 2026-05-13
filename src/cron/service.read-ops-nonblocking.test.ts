import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { createCronStoreHarness, writeCronStoreSnapshot } from "./service.test-harness.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
const { makeStoreKey } = createCronStoreHarness();

type IsolatedRunResult = {
  status: "ok" | "error" | "skipped";
  summary?: string;
  error?: string;
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function createDeferredIsolatedRun() {
  const resolveRuns: Array<(value: IsolatedRunResult) => void> = [];
  let resolveRunStarted: (() => void) | undefined;
  const runStarted = new Promise<void>((resolve) => {
    resolveRunStarted = resolve;
  });
  const runIsolatedAgentJob = vi.fn(async () => {
    resolveRunStarted?.();
    return await new Promise<IsolatedRunResult>((resolve) => {
      resolveRuns.push(resolve);
    });
  });
  return {
    runIsolatedAgentJob,
    runStarted,
    completeRun: (result: IsolatedRunResult) => {
      for (const resolveRun of resolveRuns.splice(0)) {
        resolveRun(result);
      }
    },
  };
}

function expectCronStatus(
  status: Awaited<ReturnType<CronService["status"]>>,
  params: { storeKey: string; jobs: number },
) {
  expect(status.enabled).toBe(true);
  expect(status.storeKey).toBe(params.storeKey);
  expect(status.jobs).toBe(params.jobs);
  if (status.nextWakeAtMs !== null) {
    expect(status.nextWakeAtMs).toBeTypeOf("number");
  }
}

describe("CronService read ops while job is running", () => {
  it("keeps list and status responsive during manual cron.run execution", async () => {
    const store = await makeStoreKey();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const isolatedRun = createDeferredIsolatedRun();

    const cron = new CronService({
      storeKey: store.storeKey,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: isolatedRun.runIsolatedAgentJob,
    });

    try {
      await cron.start();
      const job = await cron.add({
        name: "manual run isolation",
        enabled: true,
        deleteAfterRun: false,
        schedule: {
          kind: "at",
          at: new Date("2030-01-01T00:00:00.000Z").toISOString(),
        },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "manual run" },
        delivery: { mode: "none" },
      });

      const runPromise = cron.run(job.id, "force");
      await isolatedRun.runStarted;

      await expect(
        withTimeout(cron.list({ includeDisabled: true }), 300, "cron.list during cron.run"),
      ).resolves.toHaveLength(1);
      await expect(withTimeout(cron.status(), 300, "cron.status during cron.run")).resolves.toEqual(
        expect.objectContaining({ enabled: true, storeKey: store.storeKey }),
      );

      isolatedRun.completeRun({ status: "ok", summary: "manual done" });
      await expect(runPromise).resolves.toEqual({ ok: true, ran: true });

      const completed = await cron.list({ includeDisabled: true });
      expect(completed[0]?.state.lastStatus).toBe("ok");
      expect(completed[0]?.state.runningAtMs).toBeUndefined();
    } finally {
      cron.stop();
    }
  });

  it("keeps list and status responsive after startup defers catch-up runs", async () => {
    const store = await makeStoreKey();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");

    await writeCronStoreSnapshot({
      storeKey: store.storeKey,
      jobs: [
        {
          id: "startup-catchup",
          name: "startup catch-up",
          enabled: true,
          createdAtMs: nowMs - 86_400_000,
          updatedAtMs: nowMs - 86_400_000,
          schedule: { kind: "at", at: new Date(nowMs - 60_000).toISOString() },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "startup replay" },
          delivery: { mode: "none" },
          state: { nextRunAtMs: nowMs - 60_000 },
        },
      ],
    });

    const isolatedRun = createDeferredIsolatedRun();

    const cron = new CronService({
      storeKey: store.storeKey,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: isolatedRun.runIsolatedAgentJob,
      startupDeferredMissedAgentJobDelayMs: 120_000,
    });

    try {
      await cron.start();
      expect(isolatedRun.runIsolatedAgentJob).not.toHaveBeenCalled();

      await expect(
        withTimeout(cron.list({ includeDisabled: true }), 300, "cron.list during startup"),
      ).resolves.toHaveLength(1);
      await expect(withTimeout(cron.status(), 300, "cron.status during startup")).resolves.toEqual(
        expect.objectContaining({ enabled: true, storeKey: store.storeKey }),
      );

      const jobs = await cron.list({ includeDisabled: true });
      expect(jobs[0]?.state.lastStatus).toBeUndefined();
      expect(jobs[0]?.state.runningAtMs).toBeUndefined();
      expect(jobs[0]?.state.nextRunAtMs).toBe(nowMs + 120_000);
    } finally {
      cron.stop();
    }
  });
});
