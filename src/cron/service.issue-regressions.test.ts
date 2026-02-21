import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schedule from "./schedule.js";
import { CronService } from "./service.js";
import { createRunningCronServiceState } from "./service.test-harness.js";
import { computeJobNextRunAtMs } from "./service/jobs.js";
import { createCronServiceState, type CronEvent } from "./service/state.js";
import { onTimer } from "./service/timer.js";
import type { CronJob, CronJobState } from "./types.js";

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};
const TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1_000;
type CronServiceOptions = ConstructorParameters<typeof CronService>[0];

function topOfHourOffsetMs(jobId: string) {
  const digest = crypto.createHash("sha256").update(jobId).digest();
  return digest.readUInt32BE(0) % TOP_OF_HOUR_STAGGER_MS;
}

let fixtureRoot = "";
let fixtureCount = 0;

async function makeStorePath() {
  const dir = path.join(fixtureRoot, `case-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  const storePath = path.join(dir, "jobs.json");
  return {
    storePath,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createDueIsolatedJob(params: {
  id: string;
  nowMs: number;
  nextRunAtMs: number;
  deleteAfterRun?: boolean;
}): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    deleteAfterRun: params.deleteAfterRun ?? false,
    createdAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
    schedule: { kind: "at", at: new Date(params.nextRunAtMs).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: params.id },
    delivery: { mode: "none" },
    state: { nextRunAtMs: params.nextRunAtMs },
  };
}

function createDefaultIsolatedRunner(): CronServiceOptions["runIsolatedAgentJob"] {
  return vi.fn().mockResolvedValue({
    status: "ok",
    summary: "ok",
  }) as CronServiceOptions["runIsolatedAgentJob"];
}

function createIsolatedRegressionJob(params: {
  id: string;
  name: string;
  scheduledAt: number;
  schedule: CronJob["schedule"];
  payload: CronJob["payload"];
  state?: CronJobState;
}): CronJob {
  return {
    id: params.id,
    name: params.name,
    enabled: true,
    createdAtMs: params.scheduledAt - 86_400_000,
    updatedAtMs: params.scheduledAt - 86_400_000,
    schedule: params.schedule,
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: params.payload,
    delivery: { mode: "announce" },
    state: params.state ?? {},
  };
}

async function writeCronJobs(storePath: string, jobs: CronJob[]) {
  await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs }, null, 2), "utf-8");
}

async function startCronForStore(params: {
  storePath: string;
  cronEnabled?: boolean;
  enqueueSystemEvent?: CronServiceOptions["enqueueSystemEvent"];
  requestHeartbeatNow?: CronServiceOptions["requestHeartbeatNow"];
  runIsolatedAgentJob?: CronServiceOptions["runIsolatedAgentJob"];
  onEvent?: CronServiceOptions["onEvent"];
}) {
  const enqueueSystemEvent =
    params.enqueueSystemEvent ?? (vi.fn() as unknown as CronServiceOptions["enqueueSystemEvent"]);
  const requestHeartbeatNow =
    params.requestHeartbeatNow ?? (vi.fn() as unknown as CronServiceOptions["requestHeartbeatNow"]);
  const runIsolatedAgentJob = params.runIsolatedAgentJob ?? createDefaultIsolatedRunner();

  const cron = new CronService({
    cronEnabled: params.cronEnabled ?? true,
    storePath: params.storePath,
    log: noopLogger,
    enqueueSystemEvent,
    requestHeartbeatNow,
    runIsolatedAgentJob,
    ...(params.onEvent ? { onEvent: params.onEvent } : {}),
  });
  await cron.start();
  return cron;
}

describe("Cron issue regressions", () => {
  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cron-issues-"));
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-06T10:05:00.000Z"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("covers schedule updates, force runs, isolated wake scheduling, and payload patching", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const cron = await startCronForStore({
      storePath: store.storePath,
      enqueueSystemEvent,
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

    const forceNow = await cron.add({
      name: "force-now",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "force" },
    });

    const result = await cron.run(forceNow.id, "force");

    expect(result).toEqual({ ok: true, ran: true });
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "force",
      expect.objectContaining({ agentId: undefined }),
    );

    const job = await cron.add({
      name: "isolated",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "hi" },
    });
    const status = await cron.status();

    expect(typeof job.state.nextRunAtMs).toBe("number");
    expect(typeof status.nextWakeAtMs).toBe("number");

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

  it("repairs missing nextRunAtMs on non-schedule updates without touching other jobs", async () => {
    const store = await makeStorePath();
    const cron = await startCronForStore({ storePath: store.storePath });

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
    const store = await makeStorePath();
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
    const store = await makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    await fs.writeFile(
      store.storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
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
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const cron = await startCronForStore({ storePath: store.storePath });

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
    const store = await makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const dueAt = now - 30_000;
    await fs.writeFile(
      store.storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
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
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

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
    const store = await makeStorePath();
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
    const store = await makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const state = createRunningCronServiceState({
      storePath: store.storePath,
      log: noopLogger,
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
    const store = await makeStorePath();
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

  it("#13845: one-shot jobs with terminal statuses do not re-fire on restart", async () => {
    const store = await makeStorePath();
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
      await fs.writeFile(
        store.storePath,
        JSON.stringify({ version: 1, jobs: [job] }, null, 2),
        "utf-8",
      );
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

  it("prevents spin loop when cron job completes within the scheduled second (#17821)", async () => {
    const store = await makeStorePath();
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
    const store = await makeStorePath();
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
    const store = await makeStorePath();
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
    const store = await makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:01.000Z");
    const first = createDueIsolatedJob({ id: "batch-first", nowMs: dueAt, nextRunAtMs: dueAt });
    const second = createDueIsolatedJob({ id: "batch-second", nowMs: dueAt, nextRunAtMs: dueAt });
    await fs.writeFile(
      store.storePath,
      JSON.stringify({ version: 1, jobs: [first, second] }, null, 2),
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

  it("honors cron maxConcurrentRuns for due jobs", async () => {
    vi.useRealTimers();
    const store = await makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:01.000Z");
    const first = createDueIsolatedJob({ id: "parallel-first", nowMs: dueAt, nextRunAtMs: dueAt });
    const second = createDueIsolatedJob({
      id: "parallel-second",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await fs.writeFile(
      store.storePath,
      JSON.stringify({ version: 1, jobs: [first, second] }, null, 2),
      "utf-8",
    );

    let now = dueAt;
    let activeRuns = 0;
    let peakActiveRuns = 0;
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
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(peakActiveRuns).toBe(2);

    firstRun.resolve({ status: "ok", summary: "first done" });
    secondRun.resolve({ status: "ok", summary: "second done" });
    await timerPromise;

    const jobs = state.store?.jobs ?? [];
    expect(jobs.find((job) => job.id === first.id)?.state.lastStatus).toBe("ok");
    expect(jobs.find((job) => job.id === second.id)?.state.lastStatus).toBe("ok");
  });
});
