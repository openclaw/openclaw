import { describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-trigger-cadence-" });

describe("cron trigger cadence", () => {
  it("does not replay a quiet occurrence after an earlier fired payload", async () => {
    const { storePath } = await makeStorePath();
    let firstEvaluation = true;
    const evaluateCronTrigger = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 123);
      const fire = firstEvaluation;
      firstEvaluation = false;
      return { kind: "evaluated" as const, fire };
    });
    const deps: CronServiceDeps = {
      scheduler: createTestGatewayScheduler(),
      nowMs: () => Date.now(),
      storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      evaluateCronTrigger,
    };
    let cron = new CronService(deps);
    await cron.start();
    try {
      const job = await cron.add({
        name: "quiet occurrence",
        enabled: true,
        schedule: { kind: "cron", expr: "0 * * * * *", tz: "UTC", staggerMs: 0 },
        trigger: { script: "json({ fire: false })" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "quiet occurrence" },
      });
      for (let occurrence = 0; occurrence < 2; occurrence += 1) {
        vi.setSystemTime(cron.getJob(job.id)!.state.nextRunAtMs!);
        expect(await cron.run(job.id, "due")).toEqual({ ok: true, ran: true });
      }
      const nextAt = cron.getJob(job.id)!.state.nextRunAtMs;
      cron.stop();
      vi.setSystemTime(Date.now() + 5_000);
      cron = new CronService(deps);
      await cron.start();

      expect(evaluateCronTrigger).toHaveBeenCalledTimes(2);
      expect(deps.enqueueSystemEvent).toHaveBeenCalledOnce();
      expect(cron.getJob(job.id)?.state.nextRunAtMs).toBe(nextAt);
    } finally {
      cron.stop();
    }
  });

  it.each([
    { name: "quiet", result: { kind: "evaluated", fire: false } },
    { name: "fired", result: { kind: "evaluated", fire: true } },
    { name: "busy", result: { kind: "busy" } },
  ] as const)(
    "preserves the $name interval through maintenance and restart",
    async ({ result }) => {
      const { storePath } = await makeStorePath();
      const evaluateCronTrigger = vi.fn(async () => {
        vi.setSystemTime(Date.now() + 123);
        return result;
      });
      const deps: CronServiceDeps = {
        scheduler: createTestGatewayScheduler(),
        nowMs: () => Date.now(),
        storePath,
        cronEnabled: true,
        log: logger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        evaluateCronTrigger,
      };
      let cron = new CronService(deps);
      await cron.start();
      try {
        const job = await cron.add({
          name: "cadence probe",
          enabled: true,
          schedule: { kind: "cron", expr: "* * * * * *", tz: "UTC", staggerMs: 0 },
          trigger: { script: "json({ fire: false })" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "cadence probe" },
        });
        vi.setSystemTime(job.state.nextRunAtMs!);
        expect(await cron.run(job.id, "due")).toEqual({ ok: true, ran: true });
        const nextAt = Date.now() + 30_000;
        expect(cron.getJob(job.id)?.state.nextRunAtMs).toBe(nextAt);

        cron.stop();
        const offline = new CronService({ ...deps, cronEnabled: false });
        expect((await offline.readJob(job.id))?.state.nextRunAtMs).toBe(nextAt);
        expect((await offline.list())[0]?.state.nextRunAtMs).toBe(nextAt);
        vi.setSystemTime(Date.now() + 10_000);
        cron = new CronService(deps);
        await cron.start();
        expect(evaluateCronTrigger).toHaveBeenCalledTimes(1);
        expect(cron.getJob(job.id)?.state.nextRunAtMs).toBe(nextAt);

        vi.setSystemTime(nextAt - 1);
        expect(await cron.run(job.id, "due")).toEqual({ ok: true, ran: false, reason: "not-due" });
        vi.setSystemTime(nextAt);
        expect(await cron.run(job.id, "due")).toEqual({ ok: true, ran: true });
        expect(evaluateCronTrigger).toHaveBeenCalledTimes(2);
      } finally {
        cron.stop();
      }
    },
  );

  it("catches up an old occurrence whose future slot has no recent evaluation", async () => {
    const { storePath } = await makeStorePath();
    const nowMs = Date.now();
    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: "missed-watcher",
          name: "missed watcher",
          enabled: true,
          createdAtMs: nowMs - 120_000,
          updatedAtMs: nowMs - 60_000,
          schedule: { kind: "cron", expr: "* * * * * *", tz: "UTC", staggerMs: 0 },
          trigger: { script: "json({ fire: false })" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "missed watcher" },
          state: {
            lastRunAtMs: nowMs - 60_000,
            lastRunStatus: "ok",
            nextRunAtMs: nowMs + 20_123,
          },
        },
      ],
    });
    const evaluateCronTrigger = vi.fn(async () => ({ kind: "evaluated" as const, fire: false }));
    const cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      nowMs: () => Date.now(),
      storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      evaluateCronTrigger,
    });
    try {
      await cron.start();
      expect(evaluateCronTrigger).toHaveBeenCalledOnce();
      expect(cron.getJob("missed-watcher")?.state.nextRunAtMs).toBe(nowMs + 30_000);
    } finally {
      cron.stop();
    }
  });
});
