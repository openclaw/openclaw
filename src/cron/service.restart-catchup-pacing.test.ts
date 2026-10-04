import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { loadCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const FIRST_RUN_AT = Date.parse("2026-09-06T12:00:00.000Z");
const MINUTE = 60_000;
const PACED_DELAY = 30 * MINUTE;
const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-paced-restart-",
  baseTimeIso: new Date(FIRST_RUN_AT - MINUTE).toISOString(),
});

type RestartCase = {
  label: string;
  scheduleKind: "cron" | "every";
  paced: boolean;
  restartAfterMs: number;
  expectedNextAfterMs: number;
  forceStatus?: "ok" | "error";
  firstStatus?: "error";
};

describe("CronService restart catch-up with dynamic cadence", () => {
  it.each<RestartCase>([
    {
      label: "a paced cron deadline during a failed force run's backoff",
      scheduleKind: "cron",
      paced: true,
      forceStatus: "error",
      restartAfterMs: 10 * MINUTE + 1_000,
      expectedNextAfterMs: PACED_DELAY,
    },
    {
      label: "catch-up for an overdue paced every deadline",
      scheduleKind: "every",
      paced: true,
      restartAfterMs: 31 * MINUTE,
      expectedNextAfterMs: 33 * MINUTE,
    },
    {
      label: "catch-up for an unpaced cron deadline",
      scheduleKind: "cron",
      paced: false,
      restartAfterMs: 10 * MINUTE,
      expectedNextAfterMs: 12 * MINUTE,
    },
    {
      label: "backoff after a failed scheduled cron run",
      scheduleKind: "cron",
      paced: false,
      firstStatus: "error",
      restartAfterMs: 10_000,
      expectedNextAfterMs: 30_000,
    },
  ])("preserves $label", async (scenario) => {
    const store = await makeStorePath();
    const runIsolatedAgentJob = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>();
    runIsolatedAgentJob.mockResolvedValue({ status: "ok" });
    runIsolatedAgentJob.mockResolvedValueOnce(
      scenario.firstStatus === "error"
        ? { status: "error", error: "temporary timeout" }
        : {
            status: "ok",
            ...(scenario.paced ? { nextCheck: { delayMs: PACED_DELAY } } : {}),
          },
    );
    const createService = () =>
      new CronService({
        scheduler: createTestGatewayScheduler(),
        nowMs: () => Date.now(),
        storePath: store.storePath,
        cronEnabled: true,
        log: logger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
      });
    const original = createService();
    const restarted = createService();

    try {
      await original.start();
      const job = await original.add({
        enabled: true,
        name: "paced reminder",
        schedule:
          scenario.scheduleKind === "cron"
            ? { kind: "cron", expr: "* * * * *", tz: "UTC", staggerMs: 0 }
            : { kind: "every", everyMs: MINUTE },
        ...(scenario.paced ? { pacing: { min: "15m", max: "4h" } } : {}),
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "Check the reminder" },
        delivery: { mode: "none" },
      });
      expect(job.state.nextRunAtMs).toBe(FIRST_RUN_AT);
      vi.setSystemTime(FIRST_RUN_AT);
      await expect(original.run(job.id, "due")).resolves.toMatchObject({ ok: true, ran: true });
      if (scenario.forceStatus) {
        vi.setSystemTime(FIRST_RUN_AT + 10 * MINUTE - 1_000);
        runIsolatedAgentJob.mockResolvedValueOnce({
          status: scenario.forceStatus,
          ...(scenario.forceStatus === "error" ? { error: "temporary timeout" } : {}),
        });
        await expect(original.run(job.id, "force")).resolves.toMatchObject({ ok: true, ran: true });
      }
      original.stop();

      const before = (await loadCronStore(store.storePath)).jobs[0];
      const initialNextAfterMs = scenario.firstStatus
        ? 30_000
        : scenario.paced
          ? PACED_DELAY
          : MINUTE;
      expect(before?.state.nextRunAtMs).toBe(FIRST_RUN_AT + initialNextAfterMs);
      expect(before?.state.pacedNextRunAtMs).toBe(
        scenario.paced ? FIRST_RUN_AT + PACED_DELAY : undefined,
      );
      const completedRuns = scenario.forceStatus ? 2 : 1;
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(completedRuns);

      vi.setSystemTime(FIRST_RUN_AT + scenario.restartAfterMs);
      await restarted.start();
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(completedRuns);
      const after = (await loadCronStore(store.storePath)).jobs[0];
      const expectedNextRunAtMs = FIRST_RUN_AT + scenario.expectedNextAfterMs;
      expect(after?.state.nextRunAtMs).toBe(expectedNextRunAtMs);
      expect(after?.state.lastRunAtMs).toBe(before?.state.lastRunAtMs);
      expect(after?.state.pacedNextRunAtMs).toBe(
        scenario.paced && scenario.restartAfterMs < PACED_DELAY
          ? FIRST_RUN_AT + PACED_DELAY
          : undefined,
      );

      vi.setSystemTime(expectedNextRunAtMs);
      await expect(restarted.run(job.id, "due")).resolves.toMatchObject({ ok: true, ran: true });
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(completedRuns + 1);
    } finally {
      original.stop();
      restarted.stop();
      await store.cleanup();
    }
  });
});

function dailyJob(
  id: string,
  state: CronJob["state"],
  schedule: CronJob["schedule"] = { kind: "cron", expr: "0 12 * * *", tz: "UTC" },
): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: Date.parse("2026-07-01T12:00:00.000Z"),
    updatedAtMs: Date.parse("2026-07-29T08:00:00.000Z"),
    schedule,
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "command", argv: ["echo", "FIRED"] },
    state,
  };
}
function commandService(
  storePath: string,
  runCommandJob: CronServiceDeps["runCommandJob"],
  nowMs = Date.now,
) {
  return new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs,
    storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    runCommandJob,
  });
}

describe("CronService restart catch-up after a schedule change", () => {
  beforeEach(() => vi.setSystemTime(new Date("2026-07-28T07:18:00.000Z")));
  it("does not replay a cron slot that predates the new schedule", async () => {
    // Real report (#91944): a daily 19:00 job edited to 21:00 at 10:18 fired
    // immediately when the gateway restarted at 13:18. Yesterday's 21:00 slot
    // never existed under the old schedule, so it is not a missed run.
    const store = await makeStorePath();
    const runCommandJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
    const jobId = "restart-pre-activation-slot";
    const lastRunUnderOldSchedule = Date.parse("2026-07-27T16:00:00.000Z"); // 27 Jul 19:00 +03
    const createService = () => commandService(store.storePath, runCommandJob);

    vi.setSystemTime(new Date("2026-07-28T07:18:00.000Z")); // 10:18 Europe/Istanbul
    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        {
          ...dailyJob(
            jobId,
            {
              nextRunAtMs: Date.parse("2026-07-28T16:00:00.000Z"), // 28 Jul 19:00 +03
              lastRunAtMs: lastRunUnderOldSchedule,
              lastStatus: "ok",
            },
            { kind: "cron", expr: "0 19 * * *", tz: "Europe/Istanbul" },
          ),
          updatedAtMs: lastRunUnderOldSchedule,
        },
      ],
    });

    const editor = createService();
    try {
      await editor.start();
      await editor.update(jobId, {
        schedule: { kind: "cron", expr: "0 21 * * *", tz: "Europe/Istanbul" },
      });
      const activatedAtMs = Date.parse("2026-07-28T07:18:00.000Z");
      expect(editor.getJob(jobId)?.state.scheduleActivatedAtMs).toBe(activatedAtMs);

      vi.setSystemTime(new Date("2026-07-28T08:18:00.000Z"));
      await editor.update(jobId, { name: "renamed daily briefing" });
      await editor.update(jobId, {
        schedule: { kind: "cron", expr: "0 21 * * *", tz: "Europe/Istanbul" },
      });
      const idempotentlyUpdated = editor.getJob(jobId);
      expect(idempotentlyUpdated?.state.scheduleActivatedAtMs).toBe(activatedAtMs);
      expect(idempotentlyUpdated?.updatedAtMs).toBe(Date.parse("2026-07-28T08:18:00.000Z"));
    } finally {
      editor.stop();
    }
    // The edit itself is not a run; catch-up must stay quiet before the restart.
    expect(runCommandJob).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-07-28T10:18:00.000Z")); // 13:18 Europe/Istanbul
    const restarted = createService();
    try {
      await restarted.start();

      expect(runCommandJob).not.toHaveBeenCalled();
      const job = (await restarted.list({ includeDisabled: true })).find(
        (entry) => entry.id === jobId,
      );
      expect(job?.state.lastRunAtMs).toBe(lastRunUnderOldSchedule);
      expect(job?.state.nextRunAtMs).toBe(Date.parse("2026-07-28T18:00:00.000Z"));
    } finally {
      restarted.stop();
      await store.cleanup();
    }
  });

  it.each([true, false])(
    "replays one genuine missed slot (activation stamped: %s)",
    async (stamped) => {
      const store = await makeStorePath();
      const runCommandJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
      const now = Date.parse("2026-07-30T13:18:00.000Z");
      const id = "restart-missed-slot";
      await writeCronStoreSnapshot({
        storePath: store.storePath,
        jobs: [
          dailyJob(id, {
            nextRunAtMs: Date.parse("2026-07-31T12:00:00.000Z"),
            lastRunAtMs: Date.parse("2026-07-28T12:00:00.000Z"),
            lastStatus: "ok",
            ...(stamped ? { scheduleActivatedAtMs: Date.parse("2026-07-29T08:00:00.000Z") } : {}),
          }),
        ],
      });
      for (let restart = 0; restart < (stamped ? 1 : 2); restart++) {
        const service = commandService(store.storePath, runCommandJob, () => now);
        try {
          await service.start();
          expect(runCommandJob).toHaveBeenCalledTimes(1);
          expect(service.getJob(id)?.state.lastRunAtMs).toBe(now);
        } finally {
          service.stop();
        }
      }
      await store.cleanup();
    },
  );
});
