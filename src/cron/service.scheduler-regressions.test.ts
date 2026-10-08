import { describe, expect, it, vi } from "vitest";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { mockCall } from "../test-utils/mock-call-assertions.js";
import {
  setupCronIssueRegressionFixtures,
  startCronForStore,
  topOfHourOffsetMs,
} from "./service.issue-regressions.test-helpers.js";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  createStartedCronServiceWithFinishedBarrier,
  installCronTestHooks,
  setupCronServiceSuite,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import { loadCronJobsStore, loadCronStore, saveCronStore } from "./store.js";
import type { CronJob, CronJobState } from "./types.js";

describe("Cron issue regressions", () => {
  const cronIssueRegressionFixtures = setupCronIssueRegressionFixtures();
  async function disabledCron() {
    const store = cronIssueRegressionFixtures.makeStorePath();
    return {
      store,
      cron: await startCronForStore({ storePath: store.storePath, cronEnabled: false }),
    };
  }

  it("covers schedule updates and payload patching", async () => {
    const { cron } = await disabledCron();

    const created = await cron.add({
      name: "hourly",
      enabled: true,
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "tick" },
    });
    const offsetMs = topOfHourOffsetMs(created.id);
    expect(created.state.nextRunAtMs).toBe(Date.parse("2026-02-06T11:00:00.000Z") + offsetMs);

    const updated = await cron.update(created.id, {
      schedule: { kind: "cron", expr: "0 */2 * * *", tz: "UTC" },
    });

    expect(updated.state.nextRunAtMs).toBe(Date.parse("2026-02-06T12:00:00.000Z") + offsetMs);

    const unsafeToggle = await cron.add({
      name: "unsafe toggle",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "hi" },
    });

    const patched = await cron.update(unsafeToggle.id, {
      payload: { kind: "agentTurn", allowUnsafeExternalContent: true },
    });

    expect(patched.payload).toMatchObject({
      kind: "agentTurn",
      allowUnsafeExternalContent: true,
      message: "hi",
    });

    cron.stop();
  });

  it("does not advance unrelated due jobs when updating another job", async () => {
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    vi.setSystemTime(now);
    const { store, cron } = await disabledCron();

    const dueJob = await cron.add({
      name: "due-preserved",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: now },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "due-preserved" },
    });
    const otherJob = await cron.add({
      name: "other-job",
      enabled: true,
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "other" },
    });

    const originalDueNextRunAtMs = dueJob.state.nextRunAtMs;
    expect(typeof originalDueNextRunAtMs).toBe("number");

    vi.setSystemTime(now + 5 * 60_000);

    await cron.update(otherJob.id, {
      payload: { kind: "systemEvent", text: "other-updated" },
    });

    const storeData = await loadCronStore(store.storePath);
    const persistedDueJob = storeData.jobs.find((job) => job.id === dueJob.id);
    expect(persistedDueJob?.state?.nextRunAtMs).toBe(originalDueNextRunAtMs);

    cron.stop();
  });

  it("#13845: one-shot jobs with terminal statuses do not re-fire on restart", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const pastAt = Date.parse("2026-02-06T09:00:00.000Z");
    const baseJob = {
      name: "reminder",
      enabled: true,
      deleteAfterRun: true,
      createdAtMs: pastAt - 60_000,
      updatedAtMs: pastAt,
      schedule: { kind: "at", at: new Date(pastAt).toISOString() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "⏰ Reminder" },
    } as const;
    const terminalStates: Array<{ id: string; state: CronJobState }> = [
      {
        id: "oneshot-skipped",
        state: {
          nextRunAtMs: pastAt,
          lastRunStatus: "skipped",
          lastRunAtMs: pastAt,
        },
      },
      {
        id: "oneshot-errored",
        state: {
          nextRunAtMs: pastAt,
          lastStatus: "error",
          lastRunAtMs: pastAt,
          lastError: "heartbeat failed",
        },
      },
    ];
    for (const { id, state } of terminalStates) {
      const job: CronJob = { id, ...baseJob, state };
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });
      const enqueueSystemEvent = vi.fn();
      const cron = await startCronForStore({
        storePath: store.storePath,
        enqueueSystemEvent,
        runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok" }),
      });
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      cron.stop();
    }
  });
});

describe("list preserves past-due schedules (#16156)", () => {
  const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
    prefix: "openclaw-cron-16156-",
    fakeTimers: false,
  });

  it("does not skip a cron job when list() is called while the job is past-due", async () => {
    const store = await makeStorePath();
    const clock = createGatewaySchedulerClock(Date.parse("2025-12-13T00:00:00.000Z"));
    const { cron, enqueueSystemEvent, finished } = createStartedCronServiceWithFinishedBarrier({
      scheduler: createTestGatewayScheduler(clock.clock),
      storePath: store.storePath,
      logger: noopLogger,
    });

    await cron.start();

    const job = await cron.add({
      name: "every-minute",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "cron-tick" },
    });

    const firstDueAt = job.state.nextRunAtMs!;
    expect(firstDueAt).toBe(Date.parse("2025-12-13T00:01:00.000Z"));

    clock.setTime(firstDueAt + 5);

    const listedBefore = await cron.list({ includeDisabled: true });
    const jobBeforeTimer = listedBefore.find((j) => j.id === job.id);

    expect(jobBeforeTimer?.state.nextRunAtMs).toBe(firstDueAt);

    const finishedRun = finished.waitForOk(job.id);
    await clock.wake();
    await finishedRun;

    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((j) => j.id === job.id);

    const [text, options] = mockCall(enqueueSystemEvent) as [
      string,
      { agentId?: string } | undefined,
    ];
    expect(text).toBe("cron-tick");
    expect(options?.agentId).toBe("main");
    expect(updated?.state.lastStatus).toBe("ok");
    expect(updated?.state.nextRunAtMs).toBeGreaterThan(firstDueAt);

    cron.stop();
  });
});

describe("remove preserves sibling schedules", () => {
  const noopLogger = createNoopLogger();
  const { makeStorePath } = createCronStoreHarness();
  installCronTestHooks({ logger: noopLogger });

  const base = Date.parse("2025-12-13T00:00:00.000Z");

  function createJob(id: string, schedule: CronJob["schedule"], nextRunAtMs?: number): CronJob {
    return {
      id,
      name: id,
      enabled: true,
      createdAtMs: base - 3_600_000,
      updatedAtMs: base - 10_000,
      schedule,
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "tick" },
      delivery: { mode: "none" },
      state: nextRunAtMs === undefined ? {} : { nextRunAtMs },
    };
  }

  it("preserves a due sibling while backfilling another enabled sibling on cold-store remove", async () => {
    const store = await makeStorePath();
    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        createJob("due-every", { kind: "every", everyMs: 10_000 }, base - 5_000),
        createJob("missing-next", { kind: "cron", expr: "0 9 * * *", tz: "UTC" }),
        createJob("to-remove", { kind: "cron", expr: "0 12 * * *", tz: "UTC" }, base + 3_600_000),
      ],
    });

    const cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      nowMs: () => Date.now(),
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    const result = await cron.remove("to-remove");
    expect(result).toEqual({ ok: true, removed: true });

    const persisted = await loadCronJobsStore(store.storePath);
    const byId = new Map(persisted.jobs.map((job) => [job.id, job]));

    expect(byId.has("to-remove")).toBe(false);
    expect(byId.get("due-every")?.state.nextRunAtMs).toBe(base - 5_000);
    expect(byId.get("missing-next")?.state.nextRunAtMs).toBeGreaterThan(base);

    cron.stop();
  });
});
