import { describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { createCronServiceState, type CronServiceDeps } from "./service/state.js";
import { runMissedJobs } from "./service/timer.js";
import { loadCronStore, saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-restart-",
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});
const time = (value: string) => Date.parse(value);

function job(overrides: Partial<CronJob>): CronJob {
  return {
    id: "restart-job",
    name: "restart job",
    enabled: true,
    createdAtMs: time("2025-12-10T12:00:00Z"),
    updatedAtMs: time("2025-12-13T04:01:00Z"),
    schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "tick" },
    state: {},
    ...overrides,
  };
}

async function fixture(jobs: CronJob[], overrides: Partial<CronServiceDeps> = {}) {
  const store = await makeStorePath();
  await saveCronStore(store.storePath, { version: 1, jobs });
  const deps = {
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath: store.storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    enqueueSessionEvent: vi.fn(),
    runSessionEvent: vi.fn(async () => ({ status: "ok" as const })),
    onEvent: vi.fn(),
    runCommandJob: vi.fn(async () => ({ status: "ok" as const })),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...overrides,
  };
  return { store, deps };
}

async function withRestartedCron(
  jobs: CronJob[],
  run: (cron: CronService, deps: Awaited<ReturnType<typeof fixture>>["deps"]) => Promise<void>,
) {
  const { store, deps } = await fixture(jobs);
  const cron = new CronService(deps);
  try {
    await cron.start();
    await run(cron, deps);
  } finally {
    cron.stop();
    await store.cleanup();
  }
}

describe("CronService restart catch-up", () => {
  it("preserves delivery target writeback from a startup catch-up run", async () => {
    const target = job({
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "run" },
      delivery: { mode: "announce", channel: "telegram", to: "https://t.me/obviyus" },
      state: { nextRunAtMs: Date.now() - 60_000 },
    });
    const { store, deps } = await fixture([target]);
    const state = createCronServiceState({
      ...deps,
      runIsolatedAgentJob: async () => {
        const persisted = await loadCronStore(store.storePath);
        const current = persisted.jobs.find((entry) => entry.id === target.id);
        if (current?.delivery) {
          current.delivery.to = "-10012345/6789";
        }
        await saveCronStore(store.storePath, persisted);
        return { status: "ok", delivered: true };
      },
    });
    await runMissedJobs(state);
    expect((await loadCronStore(store.storePath)).jobs[0]).toMatchObject({
      delivery: { to: "-10012345/6789" },
      state: { lastRunStatus: "ok", lastDelivered: true },
    });
  });

  it("does not resurrect a job removed during startup catch-up", async () => {
    const { store, deps } = await fixture([
      job({
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "run" },
        state: { nextRunAtMs: Date.now() - 60_000 },
      }),
    ]);
    const state = createCronServiceState({
      ...deps,
      runIsolatedAgentJob: async () => {
        await saveCronStore(store.storePath, { version: 1, jobs: [] });
        return { status: "ok", summary: "removed", delivered: false };
      },
    });
    await runMissedJobs(state);
    expect((await loadCronStore(store.storePath)).jobs).toStrictEqual([]);
    expect(state.store?.jobs).toStrictEqual([]);
    expect(deps.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "restart-job", action: "finished", status: "ok" }),
    );
  });

  it("does not defer an isolated cron job whose persisted due slot finished as skipped", async () => {
    vi.setSystemTime(time("2025-12-13T11:00:00Z"));
    await withRestartedCron(
      [
        job({
          schedule: { kind: "cron", expr: "10 9 * * *", tz: "UTC" },
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "daily reminder" },
          state: {
            nextRunAtMs: time("2025-12-13T09:10:00Z"),
            lastRunAtMs: time("2025-12-13T09:10:30Z"),
            lastRunStatus: "skipped",
          },
        }),
      ],
      async (cron, deps) => {
        expect(deps.runIsolatedAgentJob).not.toHaveBeenCalled();
        expect(deps.enqueueSessionEvent).not.toHaveBeenCalled();
        expect(deps.runSessionEvent).not.toHaveBeenCalled();
        expect(cron.getJob("restart-job")?.state).toMatchObject({
          lastRunStatus: "skipped",
          nextRunAtMs: time("2025-12-14T09:10:00Z"),
        });
      },
    );
  });

  it("defers a cron slot due exactly at restart behind a completed persisted slot", async () => {
    vi.setSystemTime(time("2025-12-13T04:02:00Z"));
    await withRestartedCron(
      [
        job({
          state: {
            nextRunAtMs: time("2025-12-13T04:01:00Z"),
            lastRunAtMs: time("2025-12-13T04:01:00Z"),
            lastRunStatus: "ok",
          },
        }),
      ],
      async (cron, deps) => {
        expect(deps.runSessionEvent).not.toHaveBeenCalled();
        expect(cron.getJob("restart-job")?.state).toMatchObject({
          lastRunAtMs: time("2025-12-13T04:01:00Z"),
          nextRunAtMs: time("2025-12-13T04:04:00Z"),
          startupCatchupAtMs: time("2025-12-13T04:04:00Z"),
        });
        vi.setSystemTime(time("2025-12-13T04:04:00Z"));
        await expect(cron.run("restart-job", "due")).resolves.toMatchObject({
          ok: true,
          ran: true,
        });
        expect(deps.runSessionEvent).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            text: "tick",
            job: expect.objectContaining({ id: "restart-job" }),
          }),
        );
      },
    );
  });

  it("marks interrupted recurring jobs failed instead of replaying them on startup", async () => {
    const runningAtMs = time("2025-12-13T16:30:00Z");
    await withRestartedCron(
      [
        job({
          schedule: { kind: "cron", expr: "0 16 * * *", tz: "UTC" },
          state: { nextRunAtMs: time("2025-12-13T16:00:00Z"), runningAtMs },
        }),
      ],
      async (cron, deps) => {
        expect(deps.enqueueSessionEvent).not.toHaveBeenCalled();
        expect(deps.runSessionEvent).not.toHaveBeenCalled();
        const stored = cron.getJob("restart-job");
        expect(stored?.state.runningAtMs).toBeUndefined();
        expect(stored?.state).toMatchObject({
          lastStatus: "error",
          lastRunStatus: "error",
          lastRunAtMs: runningAtMs,
          lastError: "cron: job interrupted by gateway restart",
        });
        expect(stored?.state.nextRunAtMs).toBeGreaterThan(Date.now());
        expect(deps.onEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            jobId: "restart-job",
            action: "finished",
            status: "error",
            error: "cron: job interrupted by gateway restart",
            runAtMs: runningAtMs,
          }),
        );
      },
    );
  });

  it("releases queued reservations and runs due jobs after restart", async () => {
    const dueAt = time("2025-12-13T16:30:00Z");
    const state = { nextRunAtMs: dueAt, queuedAtMs: time("2025-12-13T16:45:00Z") };
    await withRestartedCron(
      [
        job({ id: "recurring", schedule: { kind: "every", everyMs: 60_000 }, state }),
        job({
          id: "one-shot",
          deleteAfterRun: true,
          schedule: { kind: "at", at: new Date(dueAt).toISOString() },
          state,
        }),
      ],
      async (cron, deps) => {
        expect(deps.runSessionEvent).not.toHaveBeenCalled();
        expect(cron.getJob("recurring")?.state.queuedAtMs).toBeUndefined();
        expect(cron.getJob("one-shot")?.state.queuedAtMs).toBeUndefined();
        expect(cron.getJob("recurring")?.state.nextRunAtMs).toBe(time("2025-12-13T17:02:00Z"));
        expect(cron.getJob("one-shot")?.state.nextRunAtMs).toBe(time("2025-12-13T17:02:05Z"));
        vi.setSystemTime(time("2025-12-13T17:02:05Z"));
        for (const id of ["recurring", "one-shot"]) {
          await expect(cron.run(id, "due")).resolves.toMatchObject({ ok: true, ran: true });
        }
        expect(deps.runSessionEvent).toHaveBeenCalledTimes(2);
        expect(cron.getJob("recurring")).toMatchObject({
          enabled: true,
          state: { lastRunStatus: "ok" },
        });
        expect(cron.getJob("recurring")?.state.queuedAtMs).toBeUndefined();
        expect(cron.getJob("one-shot")).toBeUndefined();
        expect(deps.onEvent).not.toHaveBeenCalledWith(
          expect.objectContaining({
            action: "finished",
            error: "cron: job interrupted by gateway restart",
          }),
        );
      },
    );
  });

  it("does not mistake a future retry for a rescheduled one-shot on restart", async () => {
    const runningAtMs = time("2025-12-13T16:30:00Z");
    await withRestartedCron(
      [
        job({
          deleteAfterRun: true,
          schedule: { kind: "at", at: "2025-12-13T16:00:00Z" },
          updatedAtMs: runningAtMs,
          state: { nextRunAtMs: time("2025-12-13T18:00:00Z"), runningAtMs },
        }),
      ],
      async (cron, deps) => {
        const recovered = cron.getJob("restart-job");
        expect(recovered).toMatchObject({
          enabled: false,
          deleteAfterRun: true,
          schedule: { kind: "at", at: "2025-12-13T16:00:00.000Z" },
          state: {
            lastRunAtMs: runningAtMs,
            lastRunStatus: "error",
            lastDeliveryStatus: "unknown",
          },
        });
        expect(recovered?.state.runningAtMs).toBeUndefined();
        expect(recovered?.state.nextRunAtMs).toBeUndefined();
        expect(recovered?.state.startupCatchupAtMs).toBeUndefined();
        expect(deps.enqueueSessionEvent).not.toHaveBeenCalled();
        expect(deps.runSessionEvent).not.toHaveBeenCalled();
        expect(deps.onEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            jobId: "restart-job",
            action: "finished",
            status: "error",
            error: "cron: job interrupted by gateway restart",
            runAtMs: runningAtMs,
          }),
        );
      },
    );
  });

  it("keeps missed cron slots paused until run-end error backoff expires after restart", async () => {
    vi.setSystemTime(time("2025-12-13T04:01:59Z"));
    await withRestartedCron(
      [
        job({
          state: {
            nextRunAtMs: time("2025-12-13T04:10:00Z"),
            lastRunAtMs: time("2025-12-13T04:00:00Z"),
            lastDurationMs: 90_000,
            lastStatus: "error",
            consecutiveErrors: 1,
          },
        }),
      ],
      async (cron, deps) => {
        expect(deps.enqueueSessionEvent).not.toHaveBeenCalled();
        expect(deps.runSessionEvent).not.toHaveBeenCalled();
        expect(cron.getJob("restart-job")?.state.nextRunAtMs).toBe(time("2025-12-13T04:02:00Z"));
        cron.stop();
        vi.setSystemTime(time("2025-12-13T04:02:00Z"));
        await cron.start();
        expect(deps.runSessionEvent).not.toHaveBeenCalled();
        expect(cron.getJob("restart-job")?.state.nextRunAtMs).toBe(time("2025-12-13T04:04:00Z"));
        vi.setSystemTime(time("2025-12-13T04:04:00Z"));
        await expect(cron.run("restart-job", "due")).resolves.toMatchObject({
          ok: true,
          ran: true,
        });
        expect(deps.runSessionEvent).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ text: "tick" }),
        );
      },
    );
  });

  it("keeps past-due retries paused with lastRunStatus-only history and run-end backoff", async () => {
    vi.setSystemTime(time("2025-12-13T04:01:59Z"));
    await withRestartedCron(
      [
        job({
          schedule: { kind: "every", everyMs: 60_000, anchorMs: time("2025-12-13T04:00:00Z") },
          state: {
            nextRunAtMs: time("2025-12-13T04:00:30Z"),
            lastRunAtMs: time("2025-12-13T04:00:00Z"),
            lastDurationMs: 90_000,
            lastRunStatus: "error",
            consecutiveErrors: 1,
          },
        }),
      ],
      async (cron, deps) => {
        expect(deps.enqueueSessionEvent).not.toHaveBeenCalled();
        expect(deps.runSessionEvent).not.toHaveBeenCalled();
        expect(cron.getJob("restart-job")?.state.nextRunAtMs).toBe(time("2025-12-13T04:02:00Z"));
        expect(cron.getJob("restart-job")?.state.lastRunStatus).toBe("error");
        expect(cron.getJob("restart-job")?.state.lastStatus).toBeUndefined();
      },
    );
  });

  it("stagger-limits overdue failed one-shot retries after restart", async () => {
    const now = Date.now();
    const jobs = [now - 60_000, now - 45_000].map((nextRunAtMs, index) =>
      job({
        id: `retry-${index}`,
        deleteAfterRun: true,
        schedule: { kind: "at", at: new Date(nextRunAtMs - 30_000).toISOString() },
        wakeMode: "now",
        payload: { kind: "systemEvent", text: `retry-${index}` },
        state: {
          nextRunAtMs,
          lastRunAtMs: nextRunAtMs - 30_000,
          lastRunStatus: "error",
          lastError: "temporary timeout",
          consecutiveErrors: 1,
        },
      }),
    );
    const { store, deps } = await fixture(jobs, {
      maxMissedJobsPerRestart: 1,
      missedJobStaggerMs: 5_000,
    });
    const state = createCronServiceState(deps);
    await runMissedJobs(state);
    expect(deps.runSessionEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "retry-0" }),
    );
    expect((await loadCronStore(store.storePath)).jobs).toEqual([
      expect.objectContaining({
        id: "retry-1",
        enabled: true,
        state: expect.objectContaining({
          lastRunStatus: "error",
          lastError: "temporary timeout",
          nextRunAtMs: now + 5_000,
        }),
      }),
    ]);
  });

  it.each([
    {
      label: "the first second of a slot",
      restart: "2025-12-13T04:02:00.500Z",
      last: "2025-12-13T04:01:00Z",
      next: "2025-12-13T04:03:00Z",
      expr: "* * * * *",
      tz: "UTC",
    },
    {
      label: "a daylight-saving fold",
      restart: "2026-11-01T06:05:00Z",
      last: "2026-10-31T07:30:00Z",
      next: "2026-11-01T08:30:00Z",
      expr: "30 1,3 * * *",
      tz: "America/New_York",
    },
    {
      label: "a spring-forward gap",
      restart: "2027-03-14T07:05:00Z",
      last: "2027-03-13T08:45:00Z",
      next: "2027-03-14T07:45:00Z",
      expr: "45 1,2,3 * * *",
      tz: "America/New_York",
    },
  ])("replays a missed slot across $label only once", async ({ restart, last, next, expr, tz }) => {
    vi.setSystemTime(time(restart));
    await withRestartedCron(
      [
        job({
          schedule: { kind: "cron", expr, tz },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "command", argv: ["echo", "FIRED"] },
          state: { nextRunAtMs: time(next), lastRunAtMs: time(last), lastStatus: "ok" },
        }),
      ],
      async (cron, deps) => {
        expect(deps.runCommandJob).toHaveBeenCalledOnce();
        expect(cron.getJob("restart-job")?.state).toMatchObject({
          lastRunAtMs: time(restart),
          nextRunAtMs: time(next),
        });
        cron.stop();
        await cron.start();
        expect(deps.runCommandJob).toHaveBeenCalledOnce();
      },
    );
  });
});
