import { describe, expect, it, vi } from "vitest";
import {
  setupCronIssueRegressionFixtures,
  startCronForStore,
  topOfHourOffsetMs,
} from "./service.issue-regressions.test-helpers.js";
import { loadCronStore, saveCronStore } from "./store.js";
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

  it("rejects invalid cron schedule updates without mutating disabled jobs", async () => {
    const { store, cron } = await disabledCron();

    const disabledJob = await cron.add({
      name: "disabled-cron",
      enabled: false,
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "tick" },
    });

    await expect(
      cron.update(disabledJob.id, {
        schedule: { kind: "cron", expr: "* * * 13 *", tz: "UTC" },
      }),
    ).rejects.toThrow("CronPattern");

    const persisted = await loadCronStore(store.storePath);
    const storedJob = persisted.jobs.find((job) => job.id === disabledJob.id);
    expect(storedJob?.enabled).toBe(false);
    expect(storedJob?.schedule.kind).toBe("cron");
    if (storedJob?.schedule.kind !== "cron") {
      throw new Error("expected stored cron schedule");
    }
    expect(storedJob.schedule.expr).toBe("0 * * * *");
    expect(storedJob.schedule.tz).toBe("UTC");

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
