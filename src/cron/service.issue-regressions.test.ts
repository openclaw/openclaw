// Cron service issue regression tests cover historical scheduler failures.
import { describe, expect, it, vi } from "vitest";
import {
  setupCronIssueRegressionFixtures,
  startCronForStore,
  topOfHourOffsetMs,
} from "./service.issue-regressions.test-helpers.js";
import { loadCronStore, saveCronStore, updateCronJobDeliveryTargets } from "./store.js";
import type { CronJob, CronJobState } from "./types.js";

describe("Cron issue regressions", () => {
  const cronIssueRegressionFixtures = setupCronIssueRegressionFixtures();

  it("covers schedule updates and payload patching", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const cron = await startCronForStore({
      storePath: store.storePath,
      cronEnabled: false,
    });

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

    expect(patched.payload.kind).toBe("agentTurn");
    if (patched.payload.kind === "agentTurn") {
      expect(patched.payload.allowUnsafeExternalContent).toBe(true);
      expect(patched.payload.message).toBe("hi");
    }

    cron.stop();
  });

  it("does not rewrite unchanged stores during startup", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-06T11:00:00.000Z");
    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [
        {
          id: "startup-stable",
          name: "startup stable",
          createdAtMs: scheduledAt - 60_000,
          updatedAtMs: scheduledAt - 60_000,
          enabled: true,
          schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "stable" },
          state: { nextRunAtMs: scheduledAt },
        },
      ],
    });
    const before = await loadCronStore(store.storePath);

    const cron = await startCronForStore({
      storePath: store.storePath,
      cronEnabled: true,
    });
    const after = await loadCronStore(store.storePath);

    expect(after).toEqual(before);
    cron.stop();
  });

  it("repairs missing nextRunAtMs on non-schedule updates without touching other jobs", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const cron = await startCronForStore({ storePath: store.storePath, cronEnabled: false });

    const created = await cron.add({
      name: "repair-target",
      enabled: true,
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "tick" },
    });
    const updated = await cron.update(created.id, {
      payload: { kind: "systemEvent", text: "tick-2" },
      state: { nextRunAtMs: undefined },
    });

    expect(updated.payload.kind).toBe("systemEvent");
    expect(typeof updated.state.nextRunAtMs).toBe("number");
    expect(updated.state.nextRunAtMs).toBe(created.state.nextRunAtMs);

    cron.stop();
  });

  it("does not advance unrelated due jobs when updating another job", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    vi.setSystemTime(now);
    const cron = await startCronForStore({ storePath: store.storePath, cronEnabled: false });

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
    const store = cronIssueRegressionFixtures.makeStorePath();
    const cron = await startCronForStore({ storePath: store.storePath, cronEnabled: false });

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

  it("keeps telegram delivery target writeback after manual cron.run", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const originalTarget = "https://t.me/obviyus";
    const rewrittenTarget = "-10012345/6789";
    const runIsolatedAgentJob = vi.fn(async (params: { job: { id: string } }) => {
      await updateCronJobDeliveryTargets(store.storePath, (delivery, jobId) =>
        jobId === params.job.id && delivery.channel === "telegram" ? rewrittenTarget : undefined,
      );
      return { status: "ok" as const, summary: "done", delivered: true };
    });

    const cron = await startCronForStore({
      storePath: store.storePath,
      cronEnabled: false,
      runIsolatedAgentJob,
    });
    const job = await cron.add({
      name: "manual-writeback",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "test" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: originalTarget,
      },
    });

    const result = await cron.run(job.id, "force");
    expect(result).toEqual({ ok: true, ran: true });

    const persisted = await loadCronStore(store.storePath);
    const persistedJob = persisted.jobs.find((entry) => entry.id === job.id);
    expect(persistedJob?.delivery?.to).toBe(rewrittenTarget);
    expect(persistedJob?.state.lastStatus).toBe("ok");
    expect(persistedJob?.state.lastDelivered).toBe(true);

    cron.stop();
  });

  it("keeps telegram delivery target writeback across cached writes and reads", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const originalTarget = "https://t.me/obviyus";
    const intermediateTarget = "-10011111/2222";
    const rewrittenTarget = "-10012345/6789";
    const laterTarget = "-10054321/9876";
    const cron = await startCronForStore({ storePath: store.storePath, cronEnabled: false });
    const targetJob = await cron.add({
      name: "target-writeback",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "target" },
      delivery: { mode: "announce", channel: "telegram", to: originalTarget },
    });
    const siblingJob = await cron.add({
      name: "sibling-update",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "before" },
    });

    const explicitlyRestoredTargetJob = await cron.updateWithPrecondition(
      targetJob.id,
      { delivery: { to: originalTarget } },
      async () => {
        await expect(
          updateCronJobDeliveryTargets(store.storePath, (delivery) =>
            delivery.to === originalTarget ? intermediateTarget : undefined,
          ),
        ).resolves.toEqual({ updatedJobs: 1 });
      },
    );
    expect(explicitlyRestoredTargetJob.delivery?.to).toBe(originalTarget);
    expect((await loadCronStore(store.storePath)).jobs[0]?.delivery?.to).toBe(originalTarget);

    const updatedTargetJob = await cron.updateWithPrecondition(
      targetJob.id,
      { payload: { kind: "agentTurn", message: "target-updated" } },
      async () => {
        await expect(
          updateCronJobDeliveryTargets(store.storePath, (delivery) =>
            delivery.channel === "telegram" && delivery.to === originalTarget
              ? rewrittenTarget
              : undefined,
          ),
        ).resolves.toEqual({ updatedJobs: 1 });
      },
    );
    expect(updatedTargetJob.delivery?.to).toBe(rewrittenTarget);
    expect(
      (await cron.list({ includeDisabled: true })).find((job) => job.id === targetJob.id)?.delivery
        ?.to,
    ).toBe(rewrittenTarget);

    await cron.update(siblingJob.id, {
      payload: { kind: "systemEvent", text: "after" },
    });

    const persisted = await loadCronStore(store.storePath);
    expect(persisted.jobs.find((job) => job.id === targetJob.id)?.delivery?.to).toBe(
      rewrittenTarget,
    );
    expect(persisted.jobs.find((job) => job.id === siblingJob.id)?.payload).toEqual({
      kind: "systemEvent",
      text: "after",
    });

    await expect(
      updateCronJobDeliveryTargets(store.storePath, (delivery) =>
        delivery.channel === "telegram" && delivery.to === rewrittenTarget
          ? laterTarget
          : undefined,
      ),
    ).resolves.toEqual({ updatedJobs: 1 });
    expect(cron.getJob(targetJob.id)?.delivery?.to).toBe(laterTarget);
    expect(
      (await cron.list({ includeDisabled: true })).find((job) => job.id === targetJob.id)?.delivery
        ?.to,
    ).toBe(laterTarget);

    cron.stop();
  });

  it("invalidates another loaded service after a same-process full-store write", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const originalTarget = "https://t.me/obviyus";
    const rewrittenTarget = "-10012345/6789";
    const writer = await startCronForStore({ storePath: store.storePath, cronEnabled: false });
    const job = await writer.add({
      name: "shared-store-writer",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "target" },
      delivery: { mode: "announce", channel: "telegram", to: originalTarget },
    });
    const reader = await startCronForStore({ storePath: store.storePath, cronEnabled: false });
    expect((await reader.readJob(job.id))?.delivery?.to).toBe(originalTarget);

    await writer.update(job.id, { delivery: { to: rewrittenTarget } });

    expect(reader.getJob(job.id)?.delivery?.to).toBe(rewrittenTarget);
    expect((await reader.readJob(job.id))?.delivery?.to).toBe(rewrittenTarget);

    writer.stop();
    reader.stop();
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
          lastStatus: "skipped",
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
