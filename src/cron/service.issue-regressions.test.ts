import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { HeartbeatRunResult } from "../infra/heartbeat-wake.js";
import {
  clearCommandLane,
  enqueueCommandInLane,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import * as schedule from "./schedule.js";
import {
  createAbortAwareIsolatedRunner,
  createDefaultIsolatedRunner,
  createDueIsolatedJob,
  createIsolatedRegressionJob,
  noopLogger,
  setupCronIssueRegressionFixtures,
  startCronForStore,
  topOfHourOffsetMs,
  writeCronJobs,
  writeCronStoreSnapshot,
} from "./service.issue-regressions.test-helpers.js";
import { CronService } from "./service.js";
import {
  createDeferred,
  createNoopLogger,
  createRunningCronServiceState,
} from "./service.test-harness.js";
import { computeJobNextRunAtMs } from "./service/jobs.js";
import { enqueueRun, run } from "./service/ops.js";
import { createCronServiceState, type CronEvent } from "./service/state.js";
import {
  DEFAULT_JOB_TIMEOUT_MS,
  applyJobResult,
  executeJobCore,
  onTimer,
  runMissedJobs,
} from "./service/timer.js";
import type { CronJob, CronJobState } from "./types.js";

const FAST_TIMEOUT_SECONDS = 0.0025;

describe("Cron issue regressions", () => {
  const { makeStorePath } = setupCronIssueRegressionFixtures();

  it("covers schedule updates and payload patching", async () => {
    const store = makeStorePath();
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

  it("repairs isolated every jobs missing createdAtMs and sets nextWakeAtMs", async () => {
    const store = makeStorePath();
    await writeCronStoreSnapshot(store.storePath, [
      {
        id: "legacy-isolated",
        agentId: "feature-dev_planner",
        sessionKey: "agent:main:main",
        name: "legacy isolated",
        enabled: true,
        schedule: { kind: "every", everyMs: 300_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "poll workflow queue" },
        state: {},
      },
    ]);

    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
    });
    await cron.start();

    const status = await cron.status();
    const jobs = await cron.list({ includeDisabled: true });
    const isolated = jobs.find((job) => job.id === "legacy-isolated");
    expect(Number.isFinite(isolated?.state.nextRunAtMs)).toBe(true);
    expect(Number.isFinite(status.nextWakeAtMs)).toBe(true);

    const persisted = JSON.parse(await fs.readFile(store.storePath, "utf8")) as {
      jobs: Array<{ id: string; state?: { nextRunAtMs?: number | null } }>;
    };
    const persistedIsolated = persisted.jobs.find((job) => job.id === "legacy-isolated");
    expect(typeof persistedIsolated?.state?.nextRunAtMs).toBe("number");
    expect(Number.isFinite(persistedIsolated?.state?.nextRunAtMs)).toBe(true);

    cron.stop();
  });

  it("repairs missing nextRunAtMs on non-schedule updates without touching other jobs", async () => {
    const store = makeStorePath();
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
    const store = makeStorePath();
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

    // Make dueJob past-due without running timer callbacks.
    vi.setSystemTime(now + 5 * 60_000);

    await cron.update(otherJob.id, {
      payload: { kind: "systemEvent", text: "other-updated" },
    });

    const storeData = JSON.parse(await fs.readFile(store.storePath, "utf8")) as {
      jobs: Array<{ id: string; state?: { nextRunAtMs?: number } }>;
    };
    const persistedDueJob = storeData.jobs.find((job) => job.id === dueJob.id);
    expect(persistedDueJob?.state?.nextRunAtMs).toBe(originalDueNextRunAtMs);

    cron.stop();
  });

  it("treats persisted jobs with missing enabled as enabled during update()", async () => {
    const store = makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    await writeCronStoreSnapshot(store.storePath, [
      {
        id: "missing-enabled-update",
        name: "legacy missing enabled",
        createdAtMs: now - 60_000,
        updatedAtMs: now - 60_000,
        schedule: { kind: "cron", expr: "0 */2 * * *", tz: "UTC" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "legacy" },
        state: {},
      },
    ]);

    const cron = await startCronForStore({ storePath: store.storePath, cronEnabled: false });

    const listed = await cron.list();
    expect(listed.some((job) => job.id === "missing-enabled-update")).toBe(true);

    const updated = await cron.update("missing-enabled-update", {
      schedule: { kind: "cron", expr: "0 */3 * * *", tz: "UTC" },
    });

    expect(updated.state.nextRunAtMs).toBeTypeOf("number");
    expect(updated.state.nextRunAtMs).toBeGreaterThan(now);

    cron.stop();
  });

  it("treats persisted due jobs with missing enabled as runnable", async () => {
    const store = makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const dueAt = now - 30_000;
    await writeCronStoreSnapshot(store.storePath, [
      {
        id: "missing-enabled-due",
        name: "legacy due job",
        createdAtMs: dueAt - 60_000,
        updatedAtMs: dueAt,
        schedule: { kind: "at", at: new Date(dueAt).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "missing-enabled-due" },
        state: { nextRunAtMs: dueAt },
      },
    ]);

    const enqueueSystemEvent = vi.fn();
    const cron = await startCronForStore({
      storePath: store.storePath,
      cronEnabled: false,
      enqueueSystemEvent,
    });

    const result = await cron.run("missing-enabled-due", "due");
    expect(result).toEqual({ ok: true, ran: true });
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "missing-enabled-due",
      expect.objectContaining({ agentId: undefined }),
    );

    cron.stop();
  });

  it("caps timer delay to 60s for far-future schedules", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = makeStorePath();
    const cron = await startCronForStore({ storePath: store.storePath });

    const callsBeforeAdd = timeoutSpy.mock.calls.length;
    await cron.add({
      name: "far-future",
      enabled: true,
      schedule: { kind: "at", at: "2035-01-01T00:00:00.000Z" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "future" },
    });

    const delaysAfterAdd = timeoutSpy.mock.calls
      .slice(callsBeforeAdd)
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === "number");
    expect(delaysAfterAdd.some((delay) => delay === 60_000)).toBe(true);

    cron.stop();
    timeoutSpy.mockRestore();
  });

  it("re-arms timer without hot-looping when a run is already in progress", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const state = createRunningCronServiceState({
      storePath: store.storePath,
      log: noopLogger as unknown as Parameters<typeof createRunningCronServiceState>[0]["log"],
      nowMs: () => now,
      jobs: [createDueIsolatedJob({ id: "due", nowMs: now, nextRunAtMs: now - 1 })],
    });

    await onTimer(state);

    // The timer should be re-armed (not null) so the scheduler stays alive,
    // with a fixed MAX_TIMER_DELAY_MS (60s) delay to avoid a hot-loop when
    // past-due jobs are waiting.  See #12025.
    expect(timeoutSpy).toHaveBeenCalled();
    expect(state.timer).not.toBeNull();
    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((d): d is number => typeof d === "number");
    expect(delays).toContain(60_000);
    timeoutSpy.mockRestore();
  });

  it("skips forced manual runs while a timer-triggered run is in progress", async () => {
    const store = makeStorePath();
    let resolveRun:
      | ((value: { status: "ok" | "error" | "skipped"; summary?: string; error?: string }) => void)
      | undefined;
    const runIsolatedAgentJob = vi.fn(
      async () =>
        await new Promise<{ status: "ok" | "error" | "skipped"; summary?: string; error?: string }>(
          (resolve) => {
            resolveRun = resolve;
          },
        ),
    );

    const started = createDeferred<void>();
    const finished = createDeferred<void>();
    let targetJobId = "";

    const cron = await startCronForStore({
      storePath: store.storePath,
      runIsolatedAgentJob,
      onEvent: (evt: CronEvent) => {
        if (evt.jobId !== targetJobId) {
          return;
        }
        if (evt.action === "started") {
          started.resolve();
        } else if (evt.action === "finished" && evt.status === "ok") {
          finished.resolve();
        }
      },
    });

    const runAt = Date.now() + 1;
    const job = await cron.add({
      name: "timer-overlap",
      enabled: true,
      schedule: { kind: "at", at: new Date(runAt).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "long task" },
      delivery: { mode: "none" },
    });

    targetJobId = job.id;
    await vi.advanceTimersByTimeAsync(2);
    await started.promise;
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    const manualResult = await cron.run(job.id, "force");
    expect(manualResult).toEqual({ ok: true, ran: false, reason: "already-running" });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    resolveRun?.({ status: "ok", summary: "done" });
    await finished.promise;
    // Barrier: ensure timer tick finished persisting state before cleanup.
    await cron.list({ includeDisabled: true });

    cron.stop();
  });

  it("does not double-run a job when cron.run overlaps a due timer tick", async () => {
    const store = makeStorePath();
    const runStarted = createDeferred<void>();
    const runFinished = createDeferred<void>();
    const runResolvers: Array<
      (value: { status: "ok" | "error" | "skipped"; summary?: string; error?: string }) => void
    > = [];
    const runIsolatedAgentJob = vi.fn(async () => {
      if (runIsolatedAgentJob.mock.calls.length === 1) {
        runStarted.resolve();
      }
      return await new Promise<{ status: "ok" | "error" | "skipped"; summary?: string }>(
        (resolve) => {
          runResolvers.push(resolve);
        },
      );
    });

    let targetJobId = "";
    const cron = await startCronForStore({
      storePath: store.storePath,
      runIsolatedAgentJob,
      onEvent: (evt: CronEvent) => {
        if (evt.jobId === targetJobId && evt.action === "finished") {
          runFinished.resolve();
        }
      },
    });

    const dueAt = Date.now() + 100;
    const job = await cron.add({
      name: "manual-overlap-no-double-run",
      enabled: true,
      schedule: { kind: "at", at: new Date(dueAt).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "overlap" },
      delivery: { mode: "none" },
    });
    targetJobId = job.id;

    const manualRun = cron.run(job.id, "force");
    await runStarted.promise;
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(105);
    await Promise.resolve();
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    runResolvers[0]?.({ status: "ok", summary: "done" });
    await manualRun;
    await runFinished.promise;
    // Barrier for final persistence before cleanup.
    await cron.list({ includeDisabled: true });
    cron.stop();
  });

  it("manual cron.run preserves unrelated due jobs but advances already-executed stale slots", async () => {
    const store = makeStorePath();
    const nowMs = Date.now();
    const dueNextRunAtMs = nowMs - 1_000;
    const staleExecutedNextRunAtMs = nowMs - 2_000;

    await writeCronJobs(store.storePath, [
      createIsolatedRegressionJob({
        id: "manual-target",
        name: "manual target",
        scheduledAt: nowMs,
        schedule: { kind: "at", at: new Date(nowMs + 3_600_000).toISOString() },
        payload: { kind: "agentTurn", message: "manual target" },
        state: { nextRunAtMs: nowMs + 3_600_000 },
      }),
      createIsolatedRegressionJob({
        id: "unrelated-due",
        name: "unrelated due",
        scheduledAt: nowMs,
        schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
        payload: { kind: "agentTurn", message: "unrelated due" },
        state: { nextRunAtMs: dueNextRunAtMs },
      }),
      createIsolatedRegressionJob({
        id: "unrelated-stale-executed",
        name: "unrelated stale executed",
        scheduledAt: nowMs,
        schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
        payload: { kind: "agentTurn", message: "unrelated stale executed" },
        state: {
          nextRunAtMs: staleExecutedNextRunAtMs,
          lastRunAtMs: staleExecutedNextRunAtMs + 1,
        },
      }),
    ]);

    const cron = await startCronForStore({
      storePath: store.storePath,
      cronEnabled: false,
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });

    const runResult = await cron.run("manual-target", "force");
    expect(runResult).toEqual({ ok: true, ran: true });

    const jobs = await cron.list({ includeDisabled: true });
    const unrelated = jobs.find((entry) => entry.id === "unrelated-due");
    const staleExecuted = jobs.find((entry) => entry.id === "unrelated-stale-executed");
    expect(unrelated).toBeDefined();
    expect(unrelated?.state.nextRunAtMs).toBe(dueNextRunAtMs);
    expect(staleExecuted).toBeDefined();
    expect((staleExecuted?.state.nextRunAtMs ?? 0) > nowMs).toBe(true);

    cron.stop();
  });

  it("keeps telegram delivery target writeback after manual cron.run", async () => {
    const store = makeStorePath();
    const originalTarget = "https://t.me/obviyus";
    const rewrittenTarget = "-10012345/6789";
    const runIsolatedAgentJob = vi.fn(async (params: { job: { id: string } }) => {
      const raw = await fs.readFile(store.storePath, "utf-8");
      const persisted = JSON.parse(raw) as { version: number; jobs: CronJob[] };
      const targetJob = persisted.jobs.find((job) => job.id === params.job.id);
      if (targetJob?.delivery?.channel === "telegram") {
        targetJob.delivery.to = rewrittenTarget;
      }
      await fs.writeFile(store.storePath, JSON.stringify(persisted), "utf-8");
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

    const persisted = JSON.parse(await fs.readFile(store.storePath, "utf8")) as {
      jobs: CronJob[];
    };
    const persistedJob = persisted.jobs.find((entry) => entry.id === job.id);
    expect(persistedJob?.delivery?.to).toBe(rewrittenTarget);
    expect(persistedJob?.state.lastStatus).toBe("ok");
    expect(persistedJob?.state.lastDelivered).toBe(true);

    cron.stop();
  });

  it("#13845: one-shot jobs with terminal statuses do not re-fire on restart", async () => {
    const store = makeStorePath();
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
      await fs.writeFile(store.storePath, JSON.stringify({ version: 1, jobs: [job] }), "utf-8");
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

  it("#24355: one-shot retries then succeeds (with and without deleteAfterRun)", async () => {
    const scheduledAt = Date.parse("2026-02-06T10:00:00.000Z");

    const runRetryScenario = async (params: {
      id: string;
      deleteAfterRun: boolean;
      firstError?: string;
    }): Promise<{
      state: ReturnType<typeof createCronServiceState>;
      runIsolatedAgentJob: ReturnType<typeof vi.fn>;
      firstRetryAtMs: number;
    }> => {
      const store = makeStorePath();
      const cronJob = createIsolatedRegressionJob({
        id: params.id,
        name: "reminder",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "remind me" },
        state: { nextRunAtMs: scheduledAt },
      });
      cronJob.deleteAfterRun = params.deleteAfterRun;
      await writeCronJobs(store.storePath, [cronJob]);

      let now = scheduledAt;
      const runIsolatedAgentJob = vi
        .fn()
        .mockResolvedValueOnce({
          status: "error",
          error: params.firstError ?? "429 rate limit exceeded",
        })
        .mockResolvedValueOnce({ status: "ok", summary: "done" });
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob,
      });

      await onTimer(state);
      const jobAfterRetry = state.store?.jobs.find((j) => j.id === params.id);
      expect(jobAfterRetry).toBeDefined();
      expect(jobAfterRetry!.enabled).toBe(true);
      expect(jobAfterRetry!.state.lastStatus).toBe("error");
      expect(jobAfterRetry!.state.nextRunAtMs).toBeDefined();
      expect(jobAfterRetry!.state.nextRunAtMs).toBeGreaterThan(scheduledAt);

      const firstRetryAtMs = (jobAfterRetry!.state.nextRunAtMs ?? 0) + 1;
      now = firstRetryAtMs;
      await onTimer(state);
      return { state, runIsolatedAgentJob, firstRetryAtMs };
    };

    const keepResult = await runRetryScenario({
      id: "oneshot-retry",
      deleteAfterRun: false,
    });
    const keepJob = keepResult.state.store?.jobs.find((j) => j.id === "oneshot-retry");
    expect(keepJob).toBeDefined();
    expect(keepJob!.state.lastStatus).toBe("ok");
    expect(keepResult.runIsolatedAgentJob).toHaveBeenCalledTimes(2);

    const deleteResult = await runRetryScenario({
      id: "oneshot-deleteAfterRun-retry",
      deleteAfterRun: true,
    });
    const deletedJob = deleteResult.state.store?.jobs.find(
      (j) => j.id === "oneshot-deleteAfterRun-retry",
    );
    expect(deletedJob).toBeUndefined();
    expect(deleteResult.runIsolatedAgentJob).toHaveBeenCalledTimes(2);

    const overloadedResult = await runRetryScenario({
      id: "oneshot-overloaded-retry",
      deleteAfterRun: false,
      firstError:
        "All models failed (2): anthropic/claude-3-5-sonnet: LLM error overloaded_error: overloaded (overloaded); openai/gpt-5.3-codex: LLM error overloaded_error: overloaded (overloaded)",
    });
    const overloadedJob = overloadedResult.state.store?.jobs.find(
      (j) => j.id === "oneshot-overloaded-retry",
    );
    expect(overloadedJob).toBeDefined();
    expect(overloadedJob!.state.lastStatus).toBe("ok");
    expect(overloadedResult.runIsolatedAgentJob).toHaveBeenCalledTimes(2);
  });

  it("#24355: one-shot job disabled after max transient retries", async () => {
    const store = makeStorePath();
    const scheduledAt = Date.parse("2026-02-06T10:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "oneshot-max-retries",
      name: "reminder",
      scheduledAt,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      payload: { kind: "agentTurn", message: "remind me" },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const runIsolatedAgentJob = vi.fn().mockResolvedValue({
      status: "error",
      error: "429 rate limit exceeded",
    });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    for (let i = 0; i < 4; i++) {
      await onTimer(state);
      const job = state.store?.jobs.find((j) => j.id === "oneshot-max-retries");
      expect(job).toBeDefined();
      if (i < 3) {
        expect(job!.enabled).toBe(true);
        now = (job!.state.nextRunAtMs ?? now) + 1;
      } else {
        expect(job!.enabled).toBe(false);
      }
    }
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(4);
  });

  it("#24355: one-shot job respects cron.retry config", async () => {
    const store = makeStorePath();
    const scheduledAt = Date.parse("2026-02-06T10:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "oneshot-custom-retry",
      name: "reminder",
      scheduledAt,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      payload: { kind: "agentTurn", message: "remind me" },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const runIsolatedAgentJob = vi.fn().mockResolvedValue({
      status: "error",
      error: "429 rate limit exceeded",
    });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      cronConfig: {
        retry: { maxAttempts: 2, backoffMs: [1000, 2000] },
      },
    });

    for (let i = 0; i < 4; i++) {
      await onTimer(state);
      const job = state.store?.jobs.find((j) => j.id === "oneshot-custom-retry");
      expect(job).toBeDefined();
      if (i < 2) {
        expect(job!.enabled).toBe(true);
        now = (job!.state.nextRunAtMs ?? now) + 1;
      } else {
        expect(job!.enabled).toBe(false);
      }
    }
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(3);
  });

  it("#24355: one-shot job retries status-only 529 failures when retryOn only includes overloaded", async () => {
    const store = makeStorePath();
    const scheduledAt = Date.parse("2026-02-06T10:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "oneshot-overloaded-529-only",
      name: "reminder",
      scheduledAt,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      payload: { kind: "agentTurn", message: "remind me" },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const runIsolatedAgentJob = vi
      .fn()
      .mockResolvedValueOnce({ status: "error", error: "FailoverError: HTTP 529" })
      .mockResolvedValueOnce({ status: "ok", summary: "done" });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      cronConfig: {
        retry: { maxAttempts: 1, backoffMs: [1000], retryOn: ["overloaded"] },
      },
    });

    await onTimer(state);
    const jobAfterRetry = state.store?.jobs.find((j) => j.id === "oneshot-overloaded-529-only");
    expect(jobAfterRetry).toBeDefined();
    expect(jobAfterRetry!.enabled).toBe(true);
    expect(jobAfterRetry!.state.lastStatus).toBe("error");
    expect(jobAfterRetry!.state.nextRunAtMs).toBeGreaterThan(scheduledAt);

    now = (jobAfterRetry!.state.nextRunAtMs ?? now) + 1;
    await onTimer(state);

    const finishedJob = state.store?.jobs.find((j) => j.id === "oneshot-overloaded-529-only");
    expect(finishedJob).toBeDefined();
    expect(finishedJob!.state.lastStatus).toBe("ok");
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
  });

  it("#38822: one-shot job retries Bedrock too-many-tokens-per-day errors", async () => {
    const store = makeStorePath();
    const scheduledAt = Date.parse("2026-03-08T10:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "oneshot-bedrock-too-many-tokens-per-day",
      name: "reminder",
      scheduledAt,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      payload: { kind: "agentTurn", message: "remind me" },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const runIsolatedAgentJob = vi
      .fn()
      .mockResolvedValueOnce({
        status: "error",
        error: "AWS Bedrock: Too many tokens per day. Please try again tomorrow.",
      })
      .mockResolvedValueOnce({ status: "ok", summary: "done" });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      cronConfig: {
        retry: { maxAttempts: 1, backoffMs: [1000], retryOn: ["rate_limit"] },
      },
    });

    await onTimer(state);
    const jobAfterRetry = state.store?.jobs.find(
      (j) => j.id === "oneshot-bedrock-too-many-tokens-per-day",
    );
    expect(jobAfterRetry).toBeDefined();
    expect(jobAfterRetry!.enabled).toBe(true);
    expect(jobAfterRetry!.state.lastStatus).toBe("error");
    expect(jobAfterRetry!.state.nextRunAtMs).toBeGreaterThan(scheduledAt);

    now = (jobAfterRetry!.state.nextRunAtMs ?? now) + 1;
    await onTimer(state);

    const finishedJob = state.store?.jobs.find(
      (j) => j.id === "oneshot-bedrock-too-many-tokens-per-day",
    );
    expect(finishedJob).toBeDefined();
    expect(finishedJob!.state.lastStatus).toBe("ok");
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
  });

  it("#24355: one-shot job disabled immediately on permanent error", async () => {
    const store = makeStorePath();
    const scheduledAt = Date.parse("2026-02-06T10:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "oneshot-permanent-error",
      name: "reminder",
      scheduledAt,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      payload: { kind: "agentTurn", message: "remind me" },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({
        status: "error",
        error: "invalid API key",
      }),
    });

    await onTimer(state);

    const job = state.store?.jobs.find((j) => j.id === "oneshot-permanent-error");
    expect(job).toBeDefined();
    expect(job!.enabled).toBe(false);
    expect(job!.state.lastStatus).toBe("error");
    expect(job!.state.nextRunAtMs).toBeUndefined();
  });

  it("prevents spin loop when cron job completes within the scheduled second (#17821)", async () => {
    const store = makeStorePath();
    // Simulate a cron job "0 13 * * *" (daily 13:00 UTC) that fires exactly
    // at 13:00:00.000 and completes 7ms later (still in the same second).
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
    const nextDay = scheduledAt + 86_400_000;

    const cronJob = createIsolatedRegressionJob({
      id: "spin-loop-17821",
      name: "daily noon",
      scheduledAt,
      schedule: { kind: "cron", expr: "0 13 * * *", tz: "UTC" },
      payload: { kind: "agentTurn", message: "briefing" },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    let fireCount = 0;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        // Job completes very quickly (7ms) — still within the same second
        now += 7;
        fireCount++;
        return { status: "ok" as const, summary: "done" };
      }),
    });

    // First timer tick — should fire the job exactly once
    await onTimer(state);

    expect(fireCount).toBe(1);

    const job = state.store?.jobs.find((j) => j.id === "spin-loop-17821");
    expect(job).toBeDefined();
    // nextRunAtMs MUST be in the future (next day), not the same second
    expect(job!.state.nextRunAtMs).toBeDefined();
    expect(job!.state.nextRunAtMs).toBeGreaterThanOrEqual(nextDay);

    // Second timer tick (simulating the timer re-arm) — should NOT fire again
    await onTimer(state);
    expect(fireCount).toBe(1);
  });

  it("enforces a minimum refire gap for second-granularity cron schedules (#17821)", async () => {
    const store = makeStorePath();
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "spin-gap-17821",
      name: "second-granularity",
      scheduledAt,
      schedule: { kind: "cron", expr: "* * * * * *", tz: "UTC" },
      payload: { kind: "agentTurn", message: "pulse" },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        now += 100;
        return { status: "ok" as const, summary: "done" };
      }),
    });

    await onTimer(state);

    const job = state.store?.jobs.find((j) => j.id === "spin-gap-17821");
    expect(job).toBeDefined();
    const endedAt = now;
    const minNext = endedAt + 2_000;
    expect(job!.state.nextRunAtMs).toBeDefined();
    expect(job!.state.nextRunAtMs).toBeGreaterThanOrEqual(minNext);
  });

  it("treats timeoutSeconds=0 as no timeout for isolated agentTurn jobs", async () => {
    const store = makeStorePath();
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "no-timeout-0",
      name: "no-timeout",
      scheduledAt,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      payload: { kind: "agentTurn", message: "work", timeoutSeconds: 0 },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const deferredRun = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        const result = await deferredRun.promise;
        now += 5;
        return result;
      }),
    });

    const timerPromise = onTimer(state);
    let settled = false;
    void timerPromise.finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(settled).toBe(false);

    deferredRun.resolve({ status: "ok", summary: "done" });
    await timerPromise;

    const job = state.store?.jobs.find((j) => j.id === "no-timeout-0");
    expect(job?.state.lastStatus).toBe("ok");
  });

  it("does not time out agentTurn jobs at the default 10-minute safety window", async () => {
    const store = makeStorePath();
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "agentturn-default-safety-window",
      name: "agentturn default safety window",
      scheduledAt,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      payload: { kind: "agentTurn", message: "work" },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const deferredRun = createDeferred<{ status: "ok"; summary: string }>();
    const runIsolatedAgentJob = vi.fn(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      const result = await deferredRun.promise;
      if (abortSignal?.aborted) {
        return { status: "error" as const, error: String(abortSignal.reason) };
      }
      now += 5;
      return result;
    });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    const timerPromise = onTimer(state);
    let settled = false;
    void timerPromise.finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_JOB_TIMEOUT_MS + 1_000);
    await Promise.resolve();
    expect(settled).toBe(false);

    deferredRun.resolve({ status: "ok", summary: "done" });
    await timerPromise;

    const job = state.store?.jobs.find((entry) => entry.id === "agentturn-default-safety-window");
    expect(job?.state.lastStatus).toBe("ok");
    expect(job?.state.lastError).toBeUndefined();
  });

  it("aborts isolated runs when cron timeout fires", async () => {
    vi.useRealTimers();
    const store = makeStorePath();
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
    const cronJob = createIsolatedRegressionJob({
      id: "abort-on-timeout",
      name: "abort timeout",
      scheduledAt,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      payload: { kind: "agentTurn", message: "work", timeoutSeconds: FAST_TIMEOUT_SECONDS },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const abortAwareRunner = createAbortAwareIsolatedRunner();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async (params) => {
        const result = await abortAwareRunner.runIsolatedAgentJob(params);
        now += 5;
        return result;
      }),
    });

    await onTimer(state);

    expect(abortAwareRunner.getObservedAbortSignal()).toBeDefined();
    expect(abortAwareRunner.getObservedAbortSignal()?.aborted).toBe(true);
    const job = state.store?.jobs.find((entry) => entry.id === "abort-on-timeout");
    expect(job?.state.lastStatus).toBe("error");
    expect(job?.state.lastError).toContain("timed out");
  });

  it("suppresses isolated follow-up side effects after timeout", async () => {
    vi.useRealTimers();
    const store = makeStorePath();
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
    const enqueueSystemEvent = vi.fn();

    const cronJob = createIsolatedRegressionJob({
      id: "timeout-side-effects",
      name: "timeout side effects",
      scheduledAt,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: scheduledAt },
      payload: { kind: "agentTurn", message: "work", timeoutSeconds: FAST_TIMEOUT_SECONDS },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async (params) => {
        const abortSignal = params.abortSignal;
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            abortSignal?.removeEventListener("abort", onAbort);
            now += 100;
            reject(new Error("aborted"));
          };
          abortSignal?.addEventListener("abort", onAbort, { once: true });
        });
        return {
          status: "ok" as const,
          summary: "late-summary",
          delivered: false,
          error:
            abortSignal?.aborted && typeof abortSignal.reason === "string"
              ? abortSignal.reason
              : undefined,
        };
      }),
    });

    await onTimer(state);

    const jobAfterTimeout = state.store?.jobs.find((j) => j.id === "timeout-side-effects");
    expect(jobAfterTimeout?.state.lastStatus).toBe("error");
    expect(jobAfterTimeout?.state.lastError).toContain("timed out");
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("applies timeoutSeconds to manual cron.run isolated executions", async () => {
    vi.useRealTimers();
    const store = makeStorePath();
    const abortAwareRunner = createAbortAwareIsolatedRunner();

    const cron = await startCronForStore({
      storePath: store.storePath,
      cronEnabled: false,
      runIsolatedAgentJob: abortAwareRunner.runIsolatedAgentJob,
    });

    const job = await cron.add({
      name: "manual timeout",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "work", timeoutSeconds: FAST_TIMEOUT_SECONDS },
      delivery: { mode: "none" },
    });

    const result = await cron.run(job.id, "force");
    expect(result).toEqual({ ok: true, ran: true });
    expect(abortAwareRunner.getObservedAbortSignal()).toBeDefined();
    expect(abortAwareRunner.getObservedAbortSignal()?.aborted).toBe(true);

    const updated = (await cron.list({ includeDisabled: true })).find(
      (entry) => entry.id === job.id,
    );
    expect(updated?.state.lastStatus).toBe("error");
    expect(updated?.state.lastError).toContain("timed out");
    expect(updated?.state.runningAtMs).toBeUndefined();

    cron.stop();
  });

  it("applies timeoutSeconds to startup catch-up isolated executions", async () => {
    vi.useRealTimers();
    const store = makeStorePath();
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
    const cronJob = createIsolatedRegressionJob({
      id: "startup-timeout",
      name: "startup timeout",
      scheduledAt,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      payload: { kind: "agentTurn", message: "work", timeoutSeconds: FAST_TIMEOUT_SECONDS },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const abortAwareRunner = createAbortAwareIsolatedRunner();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async (params) => {
        const result = await abortAwareRunner.runIsolatedAgentJob(params);
        now += 5;
        return result;
      }),
    });

    await runMissedJobs(state);

    expect(abortAwareRunner.getObservedAbortSignal()).toBeDefined();
    expect(abortAwareRunner.getObservedAbortSignal()?.aborted).toBe(true);
    const job = state.store?.jobs.find((entry) => entry.id === "startup-timeout");
    expect(job?.state.lastStatus).toBe("error");
    expect(job?.state.lastError).toContain("timed out");
  });

  it("respects abort signals while retrying main-session wake-now heartbeat runs", async () => {
    const abortController = new AbortController();
    const runHeartbeatOnce = vi.fn(
      async (): Promise<HeartbeatRunResult> => ({
        status: "skipped",
        reason: "requests-in-flight",
      }),
    );
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const mainJob: CronJob = {
      id: "main-abort",
      name: "main abort",
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    };
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/openclaw-cron-abort-test/jobs.json",
      log: noopLogger,
      nowMs: () => Date.now(),
      enqueueSystemEvent,
      requestHeartbeatNow,
      runHeartbeatOnce,
      wakeNowHeartbeatBusyMaxWaitMs: 30,
      wakeNowHeartbeatBusyRetryDelayMs: 5,
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });

    setTimeout(() => {
      abortController.abort();
    }, 10);

    const resultPromise = executeJobCore(state, mainJob, abortController.signal);
    // Advance virtual time so the abort fires before the busy-wait fallback window expires.
    await vi.advanceTimersByTimeAsync(10);
    const result = await resultPromise;

    expect(result.status).toBe("error");
    expect(result.error).toContain("timed out");
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(runHeartbeatOnce).toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
  });

  it("retries cron schedule computation from the next second when the first attempt returns undefined (#17821)", () => {
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
    const cronJob = createIsolatedRegressionJob({
      id: "retry-next-second-17821",
      name: "retry",
      scheduledAt,
      schedule: { kind: "cron", expr: "0 13 * * *", tz: "UTC" },
      payload: { kind: "agentTurn", message: "briefing" },
    });

    const original = schedule.computeNextRunAtMs;
    const spy = vi.spyOn(schedule, "computeNextRunAtMs");
    try {
      spy
        .mockImplementationOnce(() => undefined)
        .mockImplementation((sched, nowMs) => original(sched, nowMs));

      const expected = original(cronJob.schedule, scheduledAt + 1_000);
      expect(expected).toBeDefined();

      const next = computeJobNextRunAtMs(cronJob, scheduledAt);
      expect(next).toBe(expected);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("records per-job start time and duration for batched due jobs", async () => {
    const store = makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:01.000Z");
    const first = createDueIsolatedJob({ id: "batch-first", nowMs: dueAt, nextRunAtMs: dueAt });
    const second = createDueIsolatedJob({ id: "batch-second", nowMs: dueAt, nextRunAtMs: dueAt });
    await fs.writeFile(
      store.storePath,
      JSON.stringify({ version: 1, jobs: [first, second] }),
      "utf-8",
    );

    let now = dueAt;
    const events: CronEvent[] = [];
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      onEvent: (evt) => {
        events.push(evt);
      },
      runIsolatedAgentJob: vi.fn(async (params: { job: { id: string } }) => {
        now += params.job.id === first.id ? 50 : 20;
        return { status: "ok" as const, summary: "ok" };
      }),
    });

    await onTimer(state);

    const jobs = state.store?.jobs ?? [];
    const firstDone = jobs.find((job) => job.id === first.id);
    const secondDone = jobs.find((job) => job.id === second.id);
    const startedAtEvents = events
      .filter((evt) => evt.action === "started")
      .map((evt) => evt.runAtMs);

    expect(firstDone?.state.lastRunAtMs).toBe(dueAt);
    expect(firstDone?.state.lastDurationMs).toBe(50);
    expect(secondDone?.state.lastRunAtMs).toBe(dueAt + 50);
    expect(secondDone?.state.lastDurationMs).toBe(20);
    expect(startedAtEvents).toEqual([dueAt, dueAt + 50]);
  });

  it("#17554: run() clears stale runningAtMs and executes the job", async () => {
    const store = makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const staleRunningAtMs = now - 2 * 60 * 60 * 1000 - 1;

    await writeCronStoreSnapshot(store.storePath, [
      {
        id: "stale-running",
        name: "stale-running",
        enabled: true,
        createdAtMs: now - 3_600_000,
        updatedAtMs: now - 3_600_000,
        schedule: { kind: "at", at: new Date(now - 60_000).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "stale-running" },
        state: {
          runningAtMs: staleRunningAtMs,
          lastRunAtMs: now - 3_600_000,
          lastStatus: "ok",
          nextRunAtMs: now - 60_000,
        },
      },
    ]);

    const enqueueSystemEvent = vi.fn();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
    });

    const result = await run(state, "stale-running", "force");
    expect(result).toEqual({ ok: true, ran: true });
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "stale-running",
      expect.objectContaining({ agentId: undefined }),
    );
  });

  it("honors cron maxConcurrentRuns for due jobs", async () => {
    vi.useRealTimers();
    const store = makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:01.000Z");
    const first = createDueIsolatedJob({ id: "parallel-first", nowMs: dueAt, nextRunAtMs: dueAt });
    const second = createDueIsolatedJob({
      id: "parallel-second",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await fs.writeFile(
      store.storePath,
      JSON.stringify({ version: 1, jobs: [first, second] }),
      "utf-8",
    );

    let now = dueAt;
    let activeRuns = 0;
    let peakActiveRuns = 0;
    const bothRunsStarted = createDeferred<void>();
    const firstRun = createDeferred<{ status: "ok"; summary: string }>();
    const secondRun = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      cronConfig: { maxConcurrentRuns: 2 },
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async (params: { job: { id: string } }) => {
        activeRuns += 1;
        peakActiveRuns = Math.max(peakActiveRuns, activeRuns);
        if (peakActiveRuns >= 2) {
          bothRunsStarted.resolve();
        }
        try {
          const result =
            params.job.id === first.id ? await firstRun.promise : await secondRun.promise;
          now += 10;
          return result;
        } finally {
          activeRuns -= 1;
        }
      }),
    });

    const timerPromise = onTimer(state);
    // Full-suite parallel runs can briefly delay both workers from starting
    // even when `maxConcurrentRuns` is honored, so keep the assertion focused
    // on concurrency rather than a sub-100ms scheduler race.
    const startTimeout = setTimeout(() => {
      bothRunsStarted.reject(new Error("timed out waiting for concurrent job starts"));
    }, 250);
    try {
      await bothRunsStarted.promise;
    } finally {
      clearTimeout(startTimeout);
    }

    expect(peakActiveRuns).toBe(2);

    firstRun.resolve({ status: "ok", summary: "first done" });
    secondRun.resolve({ status: "ok", summary: "second done" });
    await timerPromise;

    const jobs = state.store?.jobs ?? [];
    expect(jobs.find((job) => job.id === first.id)?.state.lastStatus).toBe("ok");
    expect(jobs.find((job) => job.id === second.id)?.state.lastStatus).toBe("ok");
  });

  it("queues manual cron.run requests behind the cron execution lane", async () => {
    vi.useRealTimers();
    clearCommandLane(CommandLane.Cron);
    setCommandLaneConcurrency(CommandLane.Cron, 1);

    const store = makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:02.000Z");
    const first = createDueIsolatedJob({ id: "queued-first", nowMs: dueAt, nextRunAtMs: dueAt });
    const second = createDueIsolatedJob({
      id: "queued-second",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await fs.writeFile(
      store.storePath,
      JSON.stringify({ version: 1, jobs: [first, second] }),
      "utf-8",
    );

    let now = dueAt;
    let activeRuns = 0;
    let peakActiveRuns = 0;
    const firstRun = createDeferred<{ status: "ok"; summary: string }>();
    const secondRun = createDeferred<{ status: "ok"; summary: string }>();
    const secondStarted = createDeferred<void>();
    const runIsolatedAgentJob = vi.fn(async (params: { job: { id: string } }) => {
      activeRuns += 1;
      peakActiveRuns = Math.max(peakActiveRuns, activeRuns);
      if (params.job.id === second.id) {
        secondStarted.resolve();
      }
      try {
        const result =
          params.job.id === first.id ? await firstRun.promise : await secondRun.promise;
        now += 10;
        return result;
      } finally {
        activeRuns -= 1;
      }
    });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      cronConfig: { maxConcurrentRuns: 1 },
      log: createNoopLogger(),
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    const firstAck = await enqueueRun(state, first.id, "force");
    const secondAck = await enqueueRun(state, second.id, "force");
    expect(firstAck).toEqual({ ok: true, enqueued: true, runId: expect.any(String) });
    expect(secondAck).toEqual({ ok: true, enqueued: true, runId: expect.any(String) });

    await vi.waitFor(() => expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1));
    expect(runIsolatedAgentJob.mock.calls[0]?.[0]).toMatchObject({ job: { id: first.id } });
    expect(peakActiveRuns).toBe(1);

    firstRun.resolve({ status: "ok", summary: "first queued run" });
    await secondStarted.promise;
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
    expect(runIsolatedAgentJob.mock.calls[1]?.[0]).toMatchObject({ job: { id: second.id } });
    expect(peakActiveRuns).toBe(1);

    secondRun.resolve({ status: "ok", summary: "second queued run" });
    await vi.waitFor(() => {
      const jobs = state.store?.jobs ?? [];
      expect(jobs.find((job) => job.id === first.id)?.state.lastStatus).toBe("ok");
      expect(jobs.find((job) => job.id === second.id)?.state.lastStatus).toBe("ok");
    });

    clearCommandLane(CommandLane.Cron);
  });

  it("manual isolated cron.run does not deadlock when isolated execution reuses the cron lane", async () => {
    vi.useRealTimers();
    clearCommandLane(CommandLane.Cron);
    clearCommandLane(CommandLane.Nested);
    setCommandLaneConcurrency(CommandLane.Cron, 1);
    setCommandLaneConcurrency(CommandLane.Nested, 1);

    const store = makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:02.500Z");
    const job = createIsolatedRegressionJob({
      id: "manual-cron-lane-deadlock",
      name: "manual cron lane deadlock",
      scheduledAt: dueAt,
      schedule: { kind: "at", at: new Date(dueAt).toISOString() },
      payload: { kind: "agentTurn", message: "manual deadlock", timeoutSeconds: 0.05 },
      state: { nextRunAtMs: dueAt },
    });
    await writeCronJobs(store.storePath, [job]);

    const innerTaskStarted = createDeferred<void>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: createNoopLogger(),
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        return enqueueCommandInLane(CommandLane.Cron, async () => {
          innerTaskStarted.resolve();
          return { status: "ok" as const, summary: "inner cron lane run" };
        });
      }),
    });

    const ack = await enqueueRun(state, job.id, "force");
    expect(ack).toEqual({ ok: true, enqueued: true, runId: expect.any(String) });

    await innerTaskStarted.promise;
    await vi.waitFor(() => {
      const jobs = state.store?.jobs ?? [];
      expect(jobs.find((entry) => entry.id === job.id)?.state.lastStatus).toBe("ok");
    });

    clearCommandLane(CommandLane.Cron);
    clearCommandLane(CommandLane.Nested);
  });

  it("logs unexpected queued manual run background failures once", async () => {
    vi.useRealTimers();
    clearCommandLane(CommandLane.Cron);
    setCommandLaneConcurrency(CommandLane.Cron, 1);

    const dueAt = Date.parse("2026-02-06T10:05:03.000Z");
    const job = createDueIsolatedJob({ id: "queued-failure", nowMs: dueAt, nextRunAtMs: dueAt });
    const log = createNoopLogger();
    const badStore = `${makeStorePath().storePath}.dir`;
    await fs.mkdir(badStore, { recursive: true });
    const state = createRunningCronServiceState({
      storePath: badStore,
      log,
      nowMs: () => dueAt,
      jobs: [job],
    });

    const result = await enqueueRun(state, job.id, "force");
    expect(result).toEqual({ ok: true, enqueued: true, runId: expect.any(String) });

    await vi.waitFor(() => expect(log.error).toHaveBeenCalledTimes(1));
    expect(log.error.mock.calls[0]?.[1]).toBe(
      "cron: queued manual run background execution failed",
    );

    clearCommandLane(CommandLane.Cron);
  });

  // Regression: isolated cron runs must not abort at 1/3 of configured timeoutSeconds.
  // The bug (issue #29774) caused the CLI-provider resume watchdog (ratio 0.3, maxMs 180 s)
  // to be applied on fresh sessions because a persisted cliSessionId was passed to
  // runCliAgent even when isNewSession=true.  At the service level this manifests as a
  // job abort that fires much sooner than the configured outer timeout.
  it("outer cron timeout fires at configured timeoutSeconds, not at 1/3 (#29774)", async () => {
    vi.useRealTimers();
    const store = makeStorePath();
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");

    // Keep this short for suite speed while still separating expected timeout
    // from the 1/3-regression timeout.
    const timeoutSeconds = 0.01;
    const cronJob = createIsolatedRegressionJob({
      id: "timeout-fraction-29774",
      name: "timeout fraction regression",
      scheduledAt,
      schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
      payload: { kind: "agentTurn", message: "work", timeoutSeconds },
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const wallStart = Date.now();
    let abortWallMs: number | undefined;
    let started = false;

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
        started = true;
        await new Promise<void>((resolve) => {
          if (!abortSignal) {
            resolve();
            return;
          }
          if (abortSignal.aborted) {
            abortWallMs = Date.now();
            resolve();
            return;
          }
          abortSignal.addEventListener(
            "abort",
            () => {
              abortWallMs = Date.now();
              resolve();
            },
            { once: true },
          );
        });
        now += 5;
        return { status: "ok" as const, summary: "done" };
      }),
    });

    await onTimer(state);

    expect(started).toBe(true);

    // The abort must not fire at the old ~1/3 regression value.
    // Keep the lower bound conservative for loaded CI runners.
    const elapsedMs = (abortWallMs ?? Date.now()) - wallStart;
    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutSeconds * 1000 * 0.55);

    const job = state.store?.jobs.find((entry) => entry.id === "timeout-fraction-29774");
    expect(job?.state.lastStatus).toBe("error");
    expect(job?.state.lastError).toContain("timed out");
  });

  it("keeps state updates when cron next-run computation throws after a successful run (#30905)", () => {
    const startedAt = Date.parse("2026-03-02T12:00:00.000Z");
    const endedAt = startedAt + 50;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-30905-success.json",
      log: noopLogger,
      nowMs: () => endedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });
    const job = createIsolatedRegressionJob({
      id: "apply-result-success-30905",
      name: "apply-result-success-30905",
      scheduledAt: startedAt,
      schedule: { kind: "cron", expr: "0 7 * * *", tz: "Invalid/Timezone" },
      payload: { kind: "agentTurn", message: "ping" },
      state: { nextRunAtMs: startedAt - 1_000, runningAtMs: startedAt - 500 },
    });

    const shouldDelete = applyJobResult(state, job, {
      status: "ok",
      delivered: true,
      startedAt,
      endedAt,
    });

    expect(shouldDelete).toBe(false);
    expect(job.state.runningAtMs).toBeUndefined();
    expect(job.state.lastRunAtMs).toBe(startedAt);
    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.scheduleErrorCount).toBe(1);
    expect(job.state.lastError).toMatch(/^schedule error:/);
    expect(job.state.nextRunAtMs).toBe(endedAt + 2_000);
    expect(job.enabled).toBe(true);
  });

  it("falls back to backoff schedule when cron next-run computation throws on error path (#30905)", () => {
    const startedAt = Date.parse("2026-03-02T12:05:00.000Z");
    const endedAt = startedAt + 25;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-30905-error.json",
      log: noopLogger,
      nowMs: () => endedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });
    const job = createIsolatedRegressionJob({
      id: "apply-result-error-30905",
      name: "apply-result-error-30905",
      scheduledAt: startedAt,
      schedule: { kind: "cron", expr: "0 7 * * *", tz: "Invalid/Timezone" },
      payload: { kind: "agentTurn", message: "ping" },
      state: { nextRunAtMs: startedAt - 1_000, runningAtMs: startedAt - 500 },
    });

    const shouldDelete = applyJobResult(state, job, {
      status: "error",
      error: "synthetic failure",
      startedAt,
      endedAt,
    });

    expect(shouldDelete).toBe(false);
    expect(job.state.runningAtMs).toBeUndefined();
    expect(job.state.lastRunAtMs).toBe(startedAt);
    expect(job.state.lastStatus).toBe("error");
    expect(job.state.consecutiveErrors).toBe(1);
    expect(job.state.scheduleErrorCount).toBe(1);
    expect(job.state.lastError).toMatch(/^schedule error:/);
    expect(job.state.nextRunAtMs).toBe(endedAt + 30_000);
    expect(job.enabled).toBe(true);
  });

  it("force run preserves 'every' anchor while recording manual lastRunAtMs", () => {
    const nowMs = Date.now();
    const everyMs = 24 * 60 * 60 * 1_000;
    const lastScheduledRunMs = nowMs - 6 * 60 * 60 * 1_000;
    const expectedNextMs = lastScheduledRunMs + everyMs;

    const job: CronJob = {
      id: "daily-job",
      name: "Daily job",
      enabled: true,
      createdAtMs: lastScheduledRunMs - everyMs,
      updatedAtMs: lastScheduledRunMs,
      schedule: { kind: "every", everyMs, anchorMs: lastScheduledRunMs - everyMs },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "daily check-in" },
      state: {
        lastRunAtMs: lastScheduledRunMs,
        nextRunAtMs: expectedNextMs,
      },
    };
    const state = createRunningCronServiceState({
      storePath: "/tmp/cron-force-run-anchor-test.json",
      log: noopLogger as never,
      nowMs: () => nowMs,
      jobs: [job],
    });

    const startedAt = nowMs;
    const endedAt = nowMs + 2_000;

    applyJobResult(state, job, { status: "ok", startedAt, endedAt }, { preserveSchedule: true });

    expect(job.state.lastRunAtMs).toBe(startedAt);
    expect(job.state.nextRunAtMs).toBe(expectedNextMs);
  });
});
