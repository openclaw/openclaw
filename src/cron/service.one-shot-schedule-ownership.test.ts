import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearCommandLane,
  enqueueCommandInLane,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronEvent, CronServiceDeps } from "./service/state.js";
import {
  DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS,
  MIN_REFIRE_GAP_MS,
} from "./service/timer-execution-timeout.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { readCronTaskRunHistoryPage } from "./task-run-history.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-one-shot-schedule-ownership-",
  baseTimeIso: "2026-07-27T12:00:00.000Z",
});

type IsolatedOutcome =
  | { status: "ok"; summary: string }
  | { status: "error"; error: string }
  | { status: "skipped"; error: string };

function createCron(params: {
  storePath: string;
  runIsolatedAgentJob: CronServiceDeps["runIsolatedAgentJob"];
  onEvent?: (event: CronEvent) => void;
}) {
  return new CronService({
    storePath: params.storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: params.runIsolatedAgentJob,
    ...(params.onEvent ? { onEvent: params.onEvent } : {}),
  });
}

async function addOneShot(params: {
  cron: CronService;
  name: string;
  atMs: number;
  id?: string;
  deleteAfterRun?: boolean;
  enabled?: boolean;
}) {
  return await params.cron.add({
    ...(params.id === undefined ? {} : { id: params.id }),
    name: params.name,
    enabled: params.enabled ?? true,
    ...(params.deleteAfterRun === undefined ? {} : { deleteAfterRun: params.deleteAfterRun }),
    schedule: { kind: "at", at: new Date(params.atMs).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "verify one-shot schedule ownership" },
    delivery: { mode: "none" },
  });
}

async function expectFutureOneShot(params: {
  cron: CronService;
  storePath: string;
  jobId: string;
  atMs: number;
  status: IsolatedOutcome["status"];
  enabled?: boolean;
}) {
  const expected = {
    id: params.jobId,
    enabled: params.enabled ?? true,
    schedule: { kind: "at", at: new Date(params.atMs).toISOString() },
    state: {
      lastRunStatus: params.status,
      lastStatus: params.status,
    },
  };
  const listed = await params.cron.list({ includeDisabled: true });
  const listedJob = listed.find((job) => job.id === params.jobId);
  expect(listedJob).toMatchObject(expected);
  expect(listedJob?.state.nextRunAtMs).toBe(params.enabled === false ? undefined : params.atMs);
  expect(listedJob?.state.runningAtMs).toBeUndefined();
  const durable = await loadCronStore(params.storePath);
  const durableJob = durable.jobs.find((job) => job.id === params.jobId);
  expect(durableJob).toMatchObject(expected);
  expect(durableJob?.state.nextRunAtMs).toBe(params.enabled === false ? undefined : params.atMs);
  expect(durableJob?.state.runningAtMs).toBeUndefined();
  const history = readCronTaskRunHistoryPage({
    storeKey: cronStoreKey(params.storePath),
    jobId: params.jobId,
  });
  expect(history.entries).toEqual([
    expect.objectContaining({
      status: params.status,
      ...(params.status === "ok" ? { completionStatus: "succeeded" } : {}),
    }),
  ]);
}

describe("cron one-shot schedule ownership", () => {
  it.each([
    { mode: "direct", deleteAfterRun: false },
    { mode: "direct", deleteAfterRun: true },
    { mode: "queued", deleteAfterRun: false },
    { mode: "queued", deleteAfterRun: true },
  ] as const)(
    "does not finalize an active $mode run into a removed and recreated one-shot (deleteAfterRun=$deleteAfterRun)",
    async ({ mode, deleteAfterRun }) => {
      const store = await makeStorePath();
      const started = createDeferred();
      const release = createDeferred<{ status: "ok"; summary: string }>();
      const finished = createDeferred();
      const events: CronEvent[] = [];
      const cron = createCron({
        storePath: store.storePath,
        runIsolatedAgentJob: vi.fn(async () => {
          started.resolve();
          return await release.promise;
        }),
        onEvent: (event) => {
          events.push(event);
          if (event.action === "finished") {
            finished.resolve();
          }
        },
      });

      try {
        await cron.start();
        const atMs = Date.now() + 60 * 60_000;
        const original = await addOneShot({
          cron,
          id: `removed-active-${mode}-${deleteAfterRun}`,
          name: "removed original one-shot",
          atMs,
          deleteAfterRun,
        });
        const directRun = mode === "direct" ? cron.run(original.id, "force") : undefined;
        if (mode === "queued") {
          await expect(cron.enqueueRun(original.id, "force")).resolves.toMatchObject({
            ok: true,
            enqueued: true,
          });
        }
        await started.promise;

        await expect(cron.remove(original.id)).resolves.toEqual({ ok: true, removed: true });
        await addOneShot({
          cron,
          id: original.id,
          name: "independent replacement one-shot",
          atMs,
          deleteAfterRun,
        });

        release.resolve({ status: "ok", summary: "original run finished" });
        if (directRun) {
          await expect(directRun).resolves.toEqual({ ok: true, ran: true });
        } else {
          await finished.promise;
        }
        await cron.status();

        for (const jobs of [
          await cron.list({ includeDisabled: true }),
          (await loadCronStore(store.storePath)).jobs,
        ]) {
          const replacement = jobs.find((job) => job.id === original.id);
          expect(replacement).toMatchObject({
            id: original.id,
            name: "independent replacement one-shot",
            enabled: true,
            deleteAfterRun,
            state: { nextRunAtMs: atMs },
          });
          expect(replacement?.state.lastRunAtMs).toBeUndefined();
          expect(replacement?.state.lastRunStatus).toBeUndefined();
          expect(replacement?.state.lastStatus).toBeUndefined();
          expect(replacement?.state.runningAtMs).toBeUndefined();
        }

        // Removal aborts the in-flight run: both direct and queued callers need
        // one durable, visible terminal result for the original run.
        const finishedEvents = events.filter(
          (event) => event.action === "finished" && event.jobId === original.id,
        );
        expect(finishedEvents).toEqual([
          expect.objectContaining({
            status: "error",
            error: "Cron job removed by operator.",
            deliveryStatus: "not-requested",
            job: expect.objectContaining({ name: "removed original one-shot" }),
          }),
        ]);
        const history = readCronTaskRunHistoryPage({
          storeKey: cronStoreKey(store.storePath),
          jobId: original.id,
        });
        expect(history.entries).toEqual([
          expect.objectContaining({
            status: "error",
            error: "Cron job removed by operator.",
            deliveryStatus: "not-requested",
            runId: finishedEvents[0]?.runId,
          }),
        ]);
        const receipts = openOpenClawStateDatabase()
          .db.prepare(
            "SELECT receipt_id AS receiptId, status, error_text AS error FROM cron_run_receipts WHERE store_key = ? AND job_id = ?",
          )
          .all(cronStoreKey(store.storePath), original.id) as Array<{
          receiptId: string;
          status: string;
          error: string | null;
        }>;
        expect(receipts).toEqual([
          expect.objectContaining({
            status: "error",
            error: "Cron job removed by operator.",
          }),
        ]);
      } finally {
        release.resolve({ status: "ok", summary: "original run finished" });
        cron.stop();
      }
    },
  );

  it.each(
    (
      [
        { label: "successful", outcome: { status: "ok", summary: "done" } },
        { label: "failed", outcome: { status: "error", error: "temporary provider failure" } },
        { label: "skipped", outcome: { status: "skipped", error: "temporarily unavailable" } },
      ] satisfies Array<{ label: string; outcome: IsolatedOutcome }>
    ).flatMap(({ label, outcome }) =>
      [true, false].map((enabled) => ({ label, outcome, enabled })),
    ),
  )(
    "keeps the future scheduled fire after a $label manual run (enabled=$enabled)",
    async ({ outcome, enabled }) => {
      const store = await makeStorePath();
      const events: CronEvent[] = [];
      const cron = createCron({
        storePath: store.storePath,
        runIsolatedAgentJob: vi.fn(async () => outcome),
        onEvent: (event) => events.push(event),
      });

      try {
        await cron.start();
        const atMs = Date.now() + 60 * 60_000;
        const job = await addOneShot({ cron, name: `manual ${outcome.status}`, atMs, enabled });

        await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

        await expectFutureOneShot({
          cron,
          storePath: store.storePath,
          jobId: job.id,
          atMs,
          status: outcome.status,
          enabled,
        });
        expect(events.some((event) => event.jobId === job.id && event.action === "removed")).toBe(
          false,
        );
      } finally {
        cron.stop();
      }
    },
  );

  it.each([true, false])(
    "keeps the future scheduled fire after a queued manual run (enabled=%s)",
    async (enabled) => {
      const store = await makeStorePath();
      const finished = createDeferred();
      const events: CronEvent[] = [];
      const cron = createCron({
        storePath: store.storePath,
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "done" })),
        onEvent: (event) => {
          events.push(event);
          if (event.action === "finished") {
            finished.resolve();
          }
        },
      });

      try {
        await cron.start();
        const atMs = Date.now() + 60 * 60_000;
        const job = await addOneShot({ cron, name: "queued manual one-shot", atMs, enabled });

        await expect(cron.enqueueRun(job.id, "force")).resolves.toMatchObject({
          ok: true,
          enqueued: true,
        });
        await finished.promise;
        await cron.status();

        await expectFutureOneShot({
          cron,
          storePath: store.storePath,
          jobId: job.id,
          atMs,
          status: "ok",
          enabled,
        });
        expect(events.some((event) => event.jobId === job.id && event.action === "removed")).toBe(
          false,
        );
      } finally {
        cron.stop();
      }
    },
  );

  it.each([
    { enabled: true, editSchedule: false },
    { enabled: false, editSchedule: false },
    { enabled: false, editSchedule: true },
  ])(
    "preserves a queued pre-deadline occurrence unless its schedule changes (enabled=$enabled, editSchedule=$editSchedule)",
    async ({ enabled, editSchedule }) => {
      const store = await makeStorePath();
      const finished = createDeferred();
      const removed = createDeferred();
      const blockerStarted = createDeferred();
      const releaseBlocker = createDeferred();
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
      const options = {
        storePath: store.storePath,
        runIsolatedAgentJob,
        onEvent: (event: CronEvent) => {
          if (event.action === "finished") {
            finished.resolve();
          }
          if (event.action === "removed") {
            removed.resolve();
          }
        },
      };
      let cron = createCron(options);

      clearCommandLane(CommandLane.Cron);
      setCommandLaneConcurrency(CommandLane.Cron, 1);
      const blocker = enqueueCommandInLane(CommandLane.Cron, async () => {
        blockerStarted.resolve();
        await releaseBlocker.promise;
      });

      try {
        await blockerStarted.promise;
        await cron.start();
        cron.pauseScheduling();
        const atMs = Date.now() + 1_000;
        const job = await addOneShot({
          cron,
          name: "manual queued across deadline",
          atMs,
          enabled,
        });

        await expect(cron.enqueueRun(job.id, "force")).resolves.toMatchObject({
          ok: true,
          enqueued: true,
        });
        vi.setSystemTime(new Date(atMs + 1));
        releaseBlocker.resolve();
        await blocker;
        await finished.promise;
        await cron.status();

        await expectFutureOneShot({
          cron,
          storePath: store.storePath,
          jobId: job.id,
          atMs,
          status: "ok",
          enabled,
        });
        if (!enabled) {
          cron.stop();
          cron = createCron(options);
          cron.pauseScheduling();
          await cron.start();
          await expectFutureOneShot({
            cron,
            storePath: store.storePath,
            jobId: job.id,
            atMs,
            status: "ok",
            enabled,
          });
          if (editSchedule) {
            await cron.update(job.id, { schedule: { kind: "every", everyMs: 60_000 } });
          }
          const resumed = await cron.update(job.id, {
            enabled: true,
            ...(editSchedule
              ? { schedule: { kind: "at" as const, at: new Date(atMs).toISOString() } }
              : {}),
          });
          expect(resumed.state.nextRunAtMs).toBe(editSchedule ? undefined : atMs);
          cron.resumeScheduling();
          await vi.advanceTimersByTimeAsync(MIN_REFIRE_GAP_MS);
          if (!editSchedule) {
            await removed.promise;
          }
          await cron.status();
          expect(runIsolatedAgentJob).toHaveBeenCalledTimes(editSchedule ? 1 : 2);
          expect((await loadCronStore(store.storePath)).jobs).toHaveLength(editSchedule ? 1 : 0);
        }
      } finally {
        releaseBlocker.resolve();
        await blocker;
        cron.stop();
        clearCommandLane(CommandLane.Cron);
      }
    },
  );

  it.each([
    { startOffsetMs: -1, editSchedule: false },
    { startOffsetMs: 1, editSchedule: false },
    { startOffsetMs: 1, editSchedule: true },
  ])(
    "retains only an unchanged occurrence when enabled during a queued manual run (start offset=$startOffsetMs, editSchedule=$editSchedule)",
    async ({ startOffsetMs, editSchedule }) => {
      const store = await makeStorePath();
      const blockerStarted = createDeferred();
      const releaseBlocker = createDeferred();
      const payloadStarted = createDeferred();
      const releasePayload = createDeferred();
      const scheduledOccurrenceConsumed = createDeferred();
      const runIsolatedAgentJob = vi
        .fn(async () => ({ status: "ok" as const, summary: "scheduled" }))
        .mockImplementationOnce(async () => {
          payloadStarted.resolve();
          await releasePayload.promise;
          return { status: "ok" as const, summary: "manual" };
        });
      const options = {
        storePath: store.storePath,
        runIsolatedAgentJob,
        onEvent: (event: CronEvent) => {
          if (event.action === "removed") {
            scheduledOccurrenceConsumed.resolve();
          }
        },
      };
      let cron = createCron(options);
      clearCommandLane(CommandLane.Cron);
      setCommandLaneConcurrency(CommandLane.Cron, 1);
      const blocker = enqueueCommandInLane(CommandLane.Cron, async () => {
        blockerStarted.resolve();
        await releaseBlocker.promise;
      });

      try {
        await blockerStarted.promise;
        await cron.start();
        cron.pauseScheduling();
        const atMs = Date.now() + 1_000;
        const job = await addOneShot({
          cron,
          name: "enable while manual run crosses deadline",
          atMs,
          enabled: false,
        });
        await expect(cron.enqueueRun(job.id, "force")).resolves.toMatchObject({
          ok: true,
          enqueued: true,
        });
        vi.setSystemTime(new Date(atMs + startOffsetMs));
        releaseBlocker.resolve();
        await blocker;
        await payloadStarted.promise;
        vi.setSystemTime(new Date(atMs + 10));
        if (editSchedule) {
          await cron.update(job.id, { schedule: { kind: "every", everyMs: 60_000 } });
          await cron.update(job.id, {
            schedule: { kind: "at", at: new Date(atMs).toISOString() },
          });
        }
        await cron.update(job.id, { enabled: true });
        releasePayload.resolve();
        // Joining the lane successor also joins the manual run's final ownership cleanup.
        await enqueueCommandInLane(CommandLane.Cron, async () => {});
        expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
        await expectFutureOneShot({
          cron,
          storePath: store.storePath,
          jobId: job.id,
          atMs,
          status: "ok",
        });

        cron.stop();
        cron = createCron(options);
        await cron.start();
        if (editSchedule) {
          expect(cron.getJob(job.id)?.state.nextRunAtMs).toBeUndefined();
        } else {
          expect(cron.getJob(job.id)?.state.nextRunAtMs).toEqual(expect.any(Number));
        }
        await vi.advanceTimersByTimeAsync(
          DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS + MIN_REFIRE_GAP_MS,
        );
        if (!editSchedule) {
          await scheduledOccurrenceConsumed.promise;
        }
        await enqueueCommandInLane(CommandLane.Cron, async () => {});
        await cron.status();
        expect(runIsolatedAgentJob).toHaveBeenCalledTimes(editSchedule ? 1 : 2);
        expect((await loadCronStore(store.storePath)).jobs).toHaveLength(editSchedule ? 1 : 0);
      } finally {
        releaseBlocker.resolve();
        releasePayload.resolve();
        await blocker;
        await enqueueCommandInLane(CommandLane.Cron, async () => {});
        cron.stop();
        clearCommandLane(CommandLane.Cron);
      }
    },
  );

  it.each([true, false])(
    "consumes a manually verified one-shot only when its scheduled occurrence fires (enabled=%s)",
    async (enabled) => {
      const store = await makeStorePath();
      const removed = createDeferred();
      const runIsolatedAgentJob = vi.fn(async () => ({
        status: "ok" as const,
        summary: "done",
      }));
      const cron = createCron({
        storePath: store.storePath,
        runIsolatedAgentJob,
        onEvent: (event) => {
          if (event.action === "removed") {
            removed.resolve();
          }
        },
      });

      try {
        await cron.start();
        const atMs = Date.now() + 1_000;
        const job = await addOneShot({
          cron,
          name: "manual then scheduled one-shot",
          atMs,
          enabled,
        });

        await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
        expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
        await expectFutureOneShot({
          cron,
          storePath: store.storePath,
          jobId: job.id,
          atMs,
          status: "ok",
          enabled,
        });
        if (!enabled) {
          const resumed = await cron.update(job.id, { enabled: true });
          expect(resumed.state.nextRunAtMs).toBe(atMs);
        }

        await vi.advanceTimersByTimeAsync(1_000);
        await removed.promise;
        await cron.status();

        expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
        expect(
          (await cron.list({ includeDisabled: true })).find((entry) => entry.id === job.id),
        ).toBe(undefined);
        expect(
          (await loadCronStore(store.storePath)).jobs.find((entry) => entry.id === job.id),
        ).toBe(undefined);
      } finally {
        cron.stop();
      }
    },
  );

  it("preserves every scheduled one-shot in a concurrent queued manual batch", async () => {
    const store = await makeStorePath();
    const completions = new Map<string, ReturnType<typeof createDeferred<void>>>();
    const cron = createCron({
      storePath: store.storePath,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "done" })),
      onEvent: (event) => {
        if (event.action === "finished") {
          completions.get(event.jobId)?.resolve();
        }
      },
    });

    try {
      await cron.start();
      const atMs = Date.now() + 60 * 60_000;
      const jobs = [];
      for (let index = 0; index < 24; index += 1) {
        const job = await addOneShot({ cron, name: `queued one-shot ${index}`, atMs });
        completions.set(job.id, createDeferred());
        jobs.push(job);
      }

      const acknowledgements = await Promise.all(
        jobs.map(async (job) => await cron.enqueueRun(job.id, "force")),
      );
      expect(acknowledgements).toHaveLength(jobs.length);
      for (const acknowledgement of acknowledgements) {
        expect(acknowledgement).toMatchObject({ ok: true, enqueued: true });
      }
      await Promise.all([...completions.values()].map(async (completion) => completion.promise));
      await cron.status();

      const listed = await cron.list({ includeDisabled: true });
      const durable = await loadCronStore(store.storePath);
      expect(listed).toHaveLength(jobs.length);
      expect(durable.jobs).toHaveLength(jobs.length);
      for (const job of jobs) {
        for (const stored of [listed, durable.jobs]) {
          expect(stored.find((entry) => entry.id === job.id)).toMatchObject({
            id: job.id,
            enabled: true,
            state: { lastRunStatus: "ok", nextRunAtMs: atMs },
          });
        }
      }
    } finally {
      cron.stop();
    }
  });

  it.each([false, true])(
    "catches up a replacement that became overdue during an interrupted restart (deleteAfterRun=%s)",
    async (deleteAfterRun) => {
      const store = await makeStorePath();
      const now = Date.now();
      const interruptedAt = now - 30_000;
      const replacementAt = now - 5_000;
      const job: CronJob = {
        id: `restart-overdue-replacement-${deleteAfterRun}`,
        name: "overdue restart replacement",
        enabled: true,
        deleteAfterRun,
        createdAtMs: now - 60_000,
        updatedAtMs: now - 10_000,
        schedule: { kind: "at", at: new Date(replacementAt).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "run the overdue replacement once" },
        state: { nextRunAtMs: replacementAt, runningAtMs: interruptedAt },
      };
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      const enqueueSystemEvent = vi.fn();
      const requestHeartbeat = vi.fn();
      const onEvent = vi.fn((event: CronEvent) => event);
      const cron = new CronService({
        storePath: store.storePath,
        cronEnabled: true,
        log: logger,
        enqueueSystemEvent,
        requestHeartbeat,
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        onEvent,
      });

      try {
        await cron.start();
        expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
        expect(enqueueSystemEvent.mock.calls[0]?.[0]).toBe("run the overdue replacement once");
        expect(requestHeartbeat).toHaveBeenCalledTimes(1);

        const listed = await cron.list({ includeDisabled: true });
        const durable = await loadCronStore(store.storePath);
        for (const stored of [listed, durable.jobs]) {
          const recovered = stored.find((entry) => entry.id === job.id);
          if (deleteAfterRun) {
            expect(recovered).toBeUndefined();
          } else {
            expect(recovered).toMatchObject({
              enabled: false,
              state: { lastRunAtMs: now, lastRunStatus: "ok" },
            });
            expect(recovered?.state.nextRunAtMs).toBeUndefined();
          }
        }

        const finished = onEvent.mock.calls
          .map(([event]) => event)
          .filter((event) => event.action === "finished" && event.jobId === job.id);
        expect(finished).toHaveLength(2);
        expect(finished).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ status: "ok", runAtMs: now }),
            expect.objectContaining({
              status: "error",
              error: "cron: job interrupted by gateway restart",
              runAtMs: interruptedAt,
            }),
          ]),
        );
      } finally {
        cron.stop();
      }
    },
  );

  it("preserves every rescheduled one-shot in a concurrent interrupted restart batch", async () => {
    const store = await makeStorePath();
    const now = Date.now();
    const interruptedAt = now - 30 * 60_000;
    const firstReplacementAt = now + 60 * 60_000;
    const jobs: CronJob[] = Array.from({ length: 32 }, (_, index) => {
      const replacementAt = firstReplacementAt + index * 60_000;
      return {
        id: `restart-concurrent-replacement-${index}`,
        name: `concurrent replacement ${index}`,
        enabled: true,
        deleteAfterRun: index % 2 === 0,
        createdAtMs: now - 2 * 60 * 60_000,
        updatedAtMs: interruptedAt + 60_000,
        schedule: { kind: "at", at: new Date(replacementAt).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: `replacement ${index}` },
        state: { nextRunAtMs: replacementAt, runningAtMs: interruptedAt },
      };
    });
    await saveCronStore(store.storePath, { version: 1, jobs });

    const onEvent = vi.fn((event: CronEvent) => event);
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
    const cron = createCron({ storePath: store.storePath, runIsolatedAgentJob, onEvent });

    try {
      await cron.start();
      const listed = await cron.list({ includeDisabled: true });
      const durable = await loadCronStore(store.storePath);
      expect(listed).toHaveLength(jobs.length);
      expect(durable.jobs).toHaveLength(jobs.length);
      for (const job of jobs) {
        for (const stored of [listed, durable.jobs]) {
          expect(stored.find((entry) => entry.id === job.id)).toMatchObject({
            id: job.id,
            enabled: true,
            state: {
              lastRunAtMs: interruptedAt,
              lastRunStatus: "error",
              nextRunAtMs: job.state.nextRunAtMs,
            },
          });
          expect(stored.find((entry) => entry.id === job.id)?.state.runningAtMs).toBeUndefined();
        }
      }
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      const finishedEvents = onEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.action === "finished");
      expect(finishedEvents).toHaveLength(jobs.length);
      expect(new Set(finishedEvents.map((event) => event.jobId)).size).toBe(jobs.length);
      for (const event of finishedEvents) {
        expect(event).toMatchObject({
          status: "error",
          error: "cron: job interrupted by gateway restart",
          runAtMs: interruptedAt,
        });
      }
    } finally {
      cron.stop();
    }
  });
});
