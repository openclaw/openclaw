import { describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import { loadCronJobsStore } from "./store.js";
import type { CronJob } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

describe("add() must not drop a due every-job's pending run", () => {
  it("preserves a due every-job nextRunAtMs when an unrelated job is added", async () => {
    const store = await makeStorePath();
    const base = Date.parse("2025-12-13T00:00:00.000Z");
    const lastRunAtMs = base;
    const dueSlot = base + 10_000;
    const nowDue = dueSlot + 50;
    const job: CronJob = {
      id: "every-10s",
      name: "every 10s",
      enabled: true,
      createdAtMs: base - 10_000,
      updatedAtMs: base,
      schedule: { kind: "every", everyMs: 10_000, anchorMs: base - 10_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "tick" },
      delivery: { mode: "announce" },
      state: { lastRunAtMs, lastRunStatus: "ok", nextRunAtMs: dueSlot },
    };

    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      nowMs: () => Date.now(),
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob,
    });

    try {
      // Seed the completed run; driving all pending timers also advances SQLite idle timers.
      await writeCronStoreSnapshot({ storePath: store.storePath, jobs: [job] });
      vi.setSystemTime(new Date(nowDue));

      await cron.add({
        name: "unrelated daily",
        enabled: true,
        schedule: { kind: "cron", expr: "0 9 * * *" },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "daily" },
      });

      const current = (await cron.list({ includeDisabled: true })).find((j) => j.id === job.id)!;
      expect(current.state.lastRunAtMs).toBe(lastRunAtMs);
      expect(current.state.nextRunAtMs).toBe(current.state.lastRunAtMs! + 10_000);
      expect(current.state.nextRunAtMs).toBeLessThanOrEqual(nowDue);
      expect(current.state.nextRunAtMs).toBe(dueSlot);

      const persisted = await loadCronJobsStore(store.storePath);
      expect(persisted.jobs.find((j) => j.id === job.id)?.state).toMatchObject({
        lastRunAtMs,
        nextRunAtMs: dueSlot,
      });
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });
});
