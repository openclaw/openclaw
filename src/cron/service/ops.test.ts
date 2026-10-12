// Cron service ops tests cover high-level service operations and state transitions.
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../../test/helpers/cron/service-regression-fixtures.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { findCronRunForTests, readCronRunRecordsForTests } from "../run-history.test-support.js";
import { createCronExecutionId } from "../run-id.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import * as cronStoreModule from "../store.js";
import { loadCronJobsStoreWithConfigJobs, loadCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import * as runReceiptStore from "../store/run-receipt-store.js";
import { inspectActiveCronRunReceipt } from "../store/run-receipt-store.test-support.js";
import type { CronJob } from "../types.js";
import { start, stop } from "./ops-lifecycle.js";
import { add, remove, removeStaleJobFamily, update } from "./ops-mutations.js";
import { list } from "./ops-read.js";
import { run } from "./ops-run.js";
import { createOkIsolatedCronStateFactory } from "./ops.test-support.js";
import * as taskRuns from "./run-history.js";
import {
  claimCronRecoveryReceipt,
  observeCronRecoveryForTest,
  recoverCronRunForTest,
} from "./run-recovery.test-support.js";
import type { CronEvent } from "./state.js";
import { runMissedJobs } from "./timer.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-ops-seam",
});
const createOkIsolatedCronState = createOkIsolatedCronStateFactory(logger);

function createCronServiceState(params: Parameters<typeof createCronRegressionState>[0]) {
  return createCronRegressionState({ log: logger, ...params });
}

async function withStateDirForStorePath<T>(
  storePath: string,
  runWithStateDir: () => Promise<T>,
): Promise<T> {
  const stateRoot = path.dirname(path.dirname(storePath));
  await closeOpenClawStateDatabaseAsync();
  return await withEnvAsync({ OPENCLAW_STATE_DIR: stateRoot }, async () => {
    try {
      return await runWithStateDir();
    } finally {
      await closeOpenClawStateDatabaseAsync();
    }
  });
}

function createTimedOutIsolatedCronState(params: { storePath: string; now: number }) {
  return createCronServiceState({
    storePath: params.storePath,
    nowMs: () => params.now,
    runIsolatedAgentJob: vi.fn(async () => {
      throw new Error("cron: job execution timed out");
    }),
  });
}

function createFutureEveryJob(params: { id: string; now: number; nextRunAtMs?: number }): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: params.now },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: params.id },
    state: params.nextRunAtMs === undefined ? {} : { nextRunAtMs: params.nextRunAtMs },
  };
}

function createInterruptedMainJob(now: number): CronJob {
  return {
    id: "startup-interrupted",
    name: "startup interrupted",
    enabled: true,
    createdAtMs: now - 86_400_000,
    updatedAtMs: now - 30 * 60_000,
    schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "should not replay on startup" },
    state: {
      nextRunAtMs: now - 60_000,
      runningAtMs: now - 30 * 60_000,
      lastFailureNotificationDelivered: true,
      lastFailureNotificationDeliveryStatus: "delivered",
    },
  };
}

function createDueIsolatedJob(now: number): CronJob {
  return {
    id: "isolated-timeout",
    name: "isolated timeout",
    enabled: true,
    createdAtMs: now - 60_000,
    updatedAtMs: now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "do work" },
    sessionKey: "agent:main:main",
    state: { nextRunAtMs: now - 1 },
  };
}

async function writeDueIsolatedJobSnapshot(storePath: string, now: number) {
  await writeCronStoreSnapshot({
    storePath,
    jobs: [createDueIsolatedJob(now)],
  });
}

function insertCronJobRow(storePath: string, job: CronJob) {
  const { state, ...jobConfig } = job;
  runOpenClawStateWriteTransaction(({ db }) => {
    db.prepare(
      `INSERT INTO cron_jobs (
        store_key, job_id, declaration_key, name, description, enabled, payload_kind,
        job_json, state_json, updated_at
      ) VALUES (
        $storeKey, $jobId, $declarationKey, $name, $description, $enabled, $payloadKind,
        $jobJson, $stateJson, $updatedAt
      )`,
    ).run({
      $storeKey: path.resolve(storePath),
      $jobId: job.id,
      $declarationKey: job.declarationKey ?? null,
      $name: job.name,
      $description: job.description ?? null,
      $enabled: job.enabled ? 1 : 0,
      $payloadKind: job.payload.kind,
      $jobJson: JSON.stringify(jobConfig),
      $stateJson: JSON.stringify(state),
      $updatedAt: job.updatedAtMs,
    });
  });
}

describe("cron stale job-family adoption", () => {
  it("removes owner-tagged legacy rows outside the active store", async () => {
    const { storePath } = await makeStorePath();
    const staleStorePath = path.join(path.dirname(storePath), "legacy-copy", "jobs.json");
    const now = Date.parse("2026-07-29T12:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });
    const family = {
      declarationKey: "memory-core:memory-dreaming-promotion",
      name: "Memory Dreaming Promotion",
      ownerPluginTag: "[managed-by=memory-core.short-term-promotion]",
    };
    await add(state, {
      declarationKey: family.declarationKey,
      name: family.name,
      description: `${family.ownerPluginTag} current`,
      enabled: true,
      schedule: { kind: "cron", expr: "*/3 * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "dream" },
    });
    const legacy = {
      id: "75e182e6-8728-43ae-832b-01f50702feed",
      name: family.name,
      description: `${family.ownerPluginTag} legacy`,
      enabled: true,
      createdAtMs: now - 10_000,
      updatedAtMs: now - 10_000,
      schedule: { kind: "cron" as const, expr: "0 3 * * *" },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "dream" },
      state: {},
    } satisfies CronJob;
    insertCronJobRow(staleStorePath, legacy);
    insertCronJobRow(staleStorePath, {
      ...legacy,
      id: "operator-same-name",
      description: "Operator-owned job with the same display name",
    });

    await expect(removeStaleJobFamily(state, family)).resolves.toBe(1);

    const remaining = runOpenClawStateWriteTransaction(({ db }) =>
      db
        .prepare("SELECT store_key, job_id FROM cron_jobs WHERE name = ? ORDER BY job_id")
        .all(family.name),
    );
    expect(remaining).toHaveLength(2);
    expect(remaining).toEqual(
      expect.arrayContaining([
        { store_key: path.resolve(storePath), job_id: expect.any(String) },
        { store_key: path.resolve(staleStorePath), job_id: "operator-same-name" },
      ]),
    );
    state.timer?.cancel();
  });
});

function expectCronRun(params: { runId: string; status: string; jobId: string }) {
  const task = findCronTaskByBaseRunId(params.runId);
  expect(task?.status).toBe(params.status);
  expect(task?.jobId).toBe(params.jobId);
}

function findCronTaskByBaseRunId(baseRunId: string) {
  return (
    findCronRunForTests(baseRunId) ??
    readCronRunRecordsForTests().find((task) => task.runId?.startsWith(`${baseRunId}:`))
  );
}

function createMissedIsolatedJob(now: number): CronJob {
  return {
    id: "startup-timeout",
    name: "startup timeout",
    enabled: true,
    createdAtMs: now - 86_400_000,
    updatedAtMs: now - 30 * 60_000,
    schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "should timeout" },
    sessionKey: "agent:main:main",
    state: {
      nextRunAtMs: now - 60_000,
    },
  };
}

describe("cron service ops seam coverage", () => {
  it("starts and lists future jobs after upgrading from a database without receipts", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-05-20T08:30:00.000Z");
    const job = createFutureEveryJob({ id: "pre-receipt-upgrade", now });
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    openOpenClawStateDatabase().db.exec("DROP TABLE cron_run_receipts");
    const state = createOkIsolatedCronState({ storePath, now });

    try {
      await start(state);

      await expect(list(state)).resolves.toEqual([
        expect.objectContaining({ id: job.id, enabled: true }),
      ]);
      expect(
        openOpenClawStateDatabase()
          .db.prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'cron_run_receipts'",
          )
          .get(),
      ).toEqual({ name: "cron_run_receipts" });
    } finally {
      stop(state);
      inspectActiveCronRunReceipt({ storePath, jobId: job.id });
    }
  });

  it("leaves legacy notify fallback for doctor instead of migrating during startup", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-05-20T09:00:00.000Z");
    const legacyJob = {
      id: "legacy-notify",
      name: "legacy notify",
      enabled: true,
      createdAtMs: now - 60_000,
      updatedAtMs: now - 60_000,
      schedule: { kind: "every", everyMs: 3_600_000, anchorMs: now },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "do work" },
      delivery: { to: "telegram:chat-1" },
      notify: true,
      state: { nextRunAtMs: now + 3_600_000 },
    } as CronJob & { notify: true };
    insertCronJobRow(storePath, legacyJob);
    const database = openOpenClawStateDatabase().db;
    const readDefinition = () =>
      database
        .prepare("SELECT job_json FROM cron_jobs WHERE store_key = ? AND job_id = ?")
        .get(cronStoreKey(storePath), legacyJob.id)?.job_json;
    const before = readDefinition();
    expect(typeof before).toBe("string");
    const state = createCronServiceState({
      storePath,
      cronConfig: { webhook: "https://example.invalid/cron" } as never,
      nowMs: () => now,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await start(state);
    state.timer?.cancel();

    const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const persisted = loaded.store.jobs[0] as CronJob & { notify?: unknown };
    expect(persisted.notify).toBeUndefined();
    expect(persisted.delivery).toEqual({ to: "telegram:chat-1" });
    expect(readDefinition()).toBe(before);
    expect(loaded.configJobs[0]?.notify).toBe(true);
    expect(logger.info).not.toHaveBeenCalledWith(
      { storePath },
      "cron: migrated legacy notify fallback jobs before scheduler startup",
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ storePath }),
      "cron: legacy notify fallback jobs need cron.webhook before migration",
    );
  });

  it("preserves a foreign completion committed after recovery is proposed", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const startedAt = now - 30_000;
    const job = createInterruptedMainJob(now);
    job.state.runningAtMs = startedAt;
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const receipt = claimCronRecoveryReceipt(storePath, job, startedAt, "main");
    const completedJob = structuredClone(job);
    delete completedJob.state.runningAtMs;
    completedJob.state.lastRunAtMs = startedAt;
    completedJob.state.lastRunStatus = "ok";
    completedJob.state.lastStatus = "ok";
    completedJob.state.nextRunAtMs = now + 60_000;
    const state = createCronServiceState({
      storePath,
      nowMs: () => now,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const proposal = await observeCronRecoveryForTest(state, job.id, undefined, startedAt);
    await cronStoreModule.saveCronJobsStore(
      storePath,
      { version: 1, jobs: [completedJob] },
      {
        transactionHooks: {
          afterWrite: (db, receiptSchema) => {
            runReceiptStore.finishCronRunReceiptInDatabase({
              database: db,
              receiptSchema,
              handle: receipt,
              status: "ok",
              finishedAtMs: now,
            });
          },
        },
      },
    );
    runReceiptStore.releaseLocalCronRunReceiptOwnership(receipt);

    expect(await recoverCronRunForTest(state, proposal)).toEqual({ kind: "superseded" });

    await start(state);

    const persisted = (await loadCronStore(storePath)).jobs[0];
    expect(persisted?.state).toMatchObject({
      lastRunAtMs: startedAt,
      lastRunStatus: "ok",
      lastStatus: "ok",
    });
    expect(persisted?.state.nextRunAtMs).toEqual(expect.any(Number));
    expect(persisted?.state.runningAtMs).toBeUndefined();
    expect(persisted?.state.lastError).toBeUndefined();
    stop(state);
  });

  it.each([
    { outcome: "restores", identity: "canonical receipt-keyed", receipt: true },
    {
      outcome: "fails closed for",
      identity: "pre-upgrade reservation-keyed",
      receipt: true,
      reservationOffsetMs: 250,
    },
    {
      outcome: "fails closed for",
      identity: "receiptless foreign",
      receipt: false,
      foreignRunId: "foreign-run",
    },
  ])(
    "$outcome a finalized $identity task run when startup finds its stale marker",
    async ({ outcome, receipt: hasReceipt, reservationOffsetMs, foreignRunId }) => {
      const { storePath } = await makeStorePath();
      const now = Date.parse("2026-03-23T12:00:00.000Z");
      const startedAt = now - 30 * 60_000 + 250;
      const endedAt = startedAt + 4_000;

      await withStateDirForStorePath(storePath, async () => {
        const job = createInterruptedMainJob(now);
        job.state.runningAtMs = startedAt;
        job.trigger = { script: "json({ fire: true })", once: true };
        job.payload = { kind: "script", script: "return { state: { cursor: 'payload' } }" };
        job.state.triggerState = { cursor: "old" };
        await writeCronStoreSnapshot({ storePath, jobs: [job] });
        const receipt = hasReceipt
          ? claimCronRecoveryReceipt(storePath, job, startedAt, "main")
          : undefined;
        const events: CronEvent[] = [];
        const state = createCronServiceState({
          storePath,
          nowMs: () => now,
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
          onEvent: (event) => events.push(structuredClone(event)),
        });
        const taskRunId =
          reservationOffsetMs === undefined && foreignRunId === undefined
            ? taskRuns.createCronRunHandle({ state, job, startedAt, runReceipt: receipt })?.runId
            : (foreignRunId ??
              `${createCronExecutionId(job.id, startedAt - reservationOffsetMs!)}:legacy-upgrade`);
        if (!taskRunId) {
          throw new Error("expected reserved cron task run");
        }

        await taskRuns.finishCronRun(state, {
          taskRunId,
          job,
          triggerEval: { fired: true, stateChanged: true, state: { cursor: "new" } },
          scriptResult: { scriptStateChanged: true, scriptState: { cursor: "payload" } },
          event: {
            jobId: job.id,
            action: "finished",
            job,
            status: "ok",
            summary: "completed before crash",
            delivered: true,
            deliveryStatus: "delivered",
            failureNotificationDelivery: { status: "not-requested" },
            runAtMs: startedAt,
            durationMs: endedAt - startedAt,
            triggerFired: true,
          },
        });

        if (receipt) {
          runReceiptStore.releaseLocalCronRunReceiptOwnership(receipt);
        }
        await start(state);

        expect(findCronRunForTests(taskRunId)).toMatchObject({
          status: "succeeded",
          startedAt,
          summary: "completed before crash",
          endedAt,
          detail: {
            kind: "cron-run",
            status: "ok",
            triggerFired: true,
            scriptStateChanged: true,
            scriptState: { cursor: "payload" },
          },
        });
        const persisted = await loadCronStore(storePath);
        const receiptRow = receipt
          ? (runOpenClawStateWriteTransaction(({ db }) =>
              db
                .prepare(
                  "SELECT status, finished_at_ms AS finishedAtMs, error_text AS error FROM cron_run_receipts WHERE receipt_id = ?",
                )
                .get(receipt.receiptId),
            ) as { status: string; finishedAtMs: number; error: string | null })
          : undefined;
        if (outcome === "fails closed for") {
          expect(persisted.jobs[0]?.state).toMatchObject({
            lastRunAtMs: startedAt,
            lastRunStatus: "error",
            lastStatus: "error",
            lastError: "cron: job interrupted by gateway restart",
            triggerState: { cursor: "old" },
          });
          expect(persisted.jobs[0]?.state.runningAtMs).toBeUndefined();
          if (receipt) {
            expect(receiptRow).toEqual({
              status: "interrupted",
              finishedAtMs: now,
              error: "cron: job interrupted because owner is unavailable",
            });
          }
          expect(events.filter((event) => event.action === "finished")).toEqual([
            expect.objectContaining({
              jobId: job.id,
              status: "error",
              error: "cron: job interrupted by gateway restart",
            }),
          ]);
          stop(state);
          return;
        }
        expect(persisted.jobs[0]).toMatchObject({
          enabled: false,
          state: {
            lastRunAtMs: startedAt,
            lastRunStatus: "ok",
            lastStatus: "ok",
            lastDurationMs: endedAt - startedAt,
            lastDelivered: true,
            lastDeliveryStatus: "delivered",
            lastTriggerEvalAtMs: endedAt,
            lastTriggerFireAtMs: endedAt,
            triggerState: { cursor: "payload" },
          },
        });
        expect(persisted.jobs[0]?.state.runningAtMs).toBeUndefined();
        expect(persisted.jobs[0]?.state.lastError).toBeUndefined();
        expect(persisted.jobs[0]?.state.nextRunAtMs).toBeUndefined();
        if (receipt) {
          expect(receiptRow).toEqual({ status: "ok", finishedAtMs: endedAt, error: null });
        }
        expect(events.filter((event) => event.action === "finished")).toEqual([]);
        stop(state);
      });
    },
  );

  it("keeps an interrupted receipt when finalized task restoration is invalid", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const startedAt = now - 30_000;
    await withStateDirForStorePath(storePath, async () => {
      const job = createInterruptedMainJob(now);
      job.id = "invalid-finalized-receipt";
      job.state.runningAtMs = startedAt;
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const receipt = claimCronRecoveryReceipt(storePath, job, startedAt, "main");
      runReceiptStore.releaseLocalCronRunReceiptOwnership(receipt);
      const state = createCronServiceState({
        storePath,
        nowMs: () => now,
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      const taskRunId = taskRuns.createCronRunHandle({
        state,
        job,
        startedAt,
        runReceipt: receipt,
      })?.runId;
      if (!taskRunId) {
        throw new Error("expected invalid finalized cron task run");
      }
      await taskRuns.finishCronRun(state, {
        taskRunId,
        job,
        event: {
          jobId: job.id,
          action: "finished",
          job,
          status: "ok",
          completionStatus: "succeeded",
          runAtMs: startedAt,
          durationMs: 1_000,
        },
      });
      runOpenClawStateWriteTransaction(({ db }) => {
        db.prepare(
          "UPDATE task_runs SET created_at = -1, started_at = -1, ended_at = -1, last_event_at = -1 WHERE run_id = ?",
        ).run(taskRunId);
      });

      await start(state);

      const persisted = (await loadCronStore(storePath)).jobs[0];
      expect(persisted?.state.lastRunStatus).toBe("error");
      const receiptRow = runOpenClawStateWriteTransaction(({ db }) =>
        db
          .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
          .get(receipt.receiptId),
      ) as { status: string };
      expect(receiptRow.status).toBe("interrupted");
      stop(state);
    });
  });

  it("keeps a finalized one-shot disabled when startup restores its stale marker", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const startedAt = now - 30_000;
    const endedAt = startedAt + 4_000;

    await withStateDirForStorePath(storePath, async () => {
      const job = createDueIsolatedJob(now);
      job.id = "startup-post-execution-conflict";
      job.name = "startup post-execution conflict";
      job.schedule = { kind: "at", at: new Date(startedAt).toISOString() };
      job.state = { runningAtMs: startedAt, nextRunAtMs: startedAt };
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const state = createCronServiceState({
        storePath,
        nowMs: () => now,
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      const taskRunId = taskRuns.createCronRunHandle({ state, job, startedAt })?.runId;
      if (!taskRunId) {
        throw new Error("expected cron task run");
      }
      await taskRuns.finishCronRun(state, {
        taskRunId,
        job,
        event: {
          jobId: job.id,
          action: "finished",
          job,
          status: "error",
          error: 'Session "agent:main:cron:job-1" changed while starting work. Retry.',
          runAtMs: startedAt,
          durationMs: endedAt - startedAt,
        },
      });

      await start(state);

      const persisted = await loadCronStore(storePath);
      expect(persisted.jobs[0]?.enabled).toBe(false);
      expect(persisted.jobs[0]?.state.nextRunAtMs).toBeUndefined();
      stop(state);
    });
  });

  it.each([
    { deleteAfterRun: false, status: "ok" as const, overdue: false },
    { deleteAfterRun: true, status: "error" as const, overdue: true },
  ])(
    "recovers a rescheduled one-shot after a finalized $status run (deleteAfterRun=$deleteAfterRun, overdue=$overdue)",
    async ({ deleteAfterRun, status, overdue }) => {
      const { storePath } = await makeStorePath();
      const now = Date.parse("2026-03-23T12:00:00.000Z");
      const startedAt = now - 30_000;
      const endedAt = startedAt + 4_000;
      const replacementAt = overdue ? now - 5_000 : now + 3_600_000;

      await withStateDirForStorePath(storePath, async () => {
        const replacement = createDueIsolatedJob(now);
        replacement.id = `startup-rescheduled-finalized-one-shot-${deleteAfterRun}`;
        replacement.name = "startup rescheduled finalized one-shot";
        replacement.deleteAfterRun = deleteAfterRun;
        replacement.schedule = { kind: "at", at: new Date(replacementAt).toISOString() };
        replacement.updatedAtMs = now - 10_000;
        replacement.state = { runningAtMs: startedAt, nextRunAtMs: replacementAt };
        await writeCronStoreSnapshot({ storePath, jobs: [replacement] });

        const original = structuredClone(replacement);
        original.schedule = { kind: "at", at: new Date(startedAt).toISOString() };
        original.updatedAtMs = startedAt;
        original.state.nextRunAtMs = startedAt;

        const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
        const state = createCronServiceState({
          storePath,
          nowMs: () => now,
          runIsolatedAgentJob,
        });
        const taskRunId = taskRuns.createCronRunHandle({
          state,
          job: original,
          startedAt,
        })?.runId;
        if (!taskRunId) {
          throw new Error("expected cron task run");
        }
        await taskRuns.finishCronRun(state, {
          taskRunId,
          job: original,
          event: {
            jobId: original.id,
            action: "finished",
            job: original,
            status,
            completionStatus: status === "ok" ? "succeeded" : "failed",
            ...(status === "error" ? { error: "original failed before restart" } : {}),
            summary: "original completed before restart",
            runAtMs: startedAt,
            durationMs: endedAt - startedAt,
          },
        });

        try {
          await start(state);

          const persisted = await loadCronStore(storePath);
          const restored = persisted.jobs.find((job) => job.id === replacement.id);
          expect(restored?.enabled).toBe(true);
          if (overdue) {
            expect(restored?.state.nextRunAtMs).toBeGreaterThan(now);
            expect(restored?.state.startupCatchupAtMs).toBe(restored?.state.nextRunAtMs);
          } else {
            expect(restored?.state.nextRunAtMs).toBe(replacementAt);
            expect(restored?.state.startupCatchupAtMs).toBeUndefined();
          }
          expect(restored?.state.runningAtMs).toBeUndefined();
          expect(restored?.state.lastRunAtMs).toBe(startedAt);
          expect(restored?.state.lastRunStatus).toBe(status);
          expect(runIsolatedAgentJob).not.toHaveBeenCalled();
          expect(findCronRunForTests(taskRunId)?.status).toBe(
            status === "ok" ? "succeeded" : "failed",
          );
        } finally {
          stop(state);
        }
      });
    },
  );

  it("restores finalized failure-alert cooldown without redelivery", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const startedAt = now - 30 * 60_000;
    const endedAt = startedAt + 4_000;

    await withStateDirForStorePath(storePath, async () => {
      const job = createInterruptedMainJob(now);
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const sendCronFailureAlert = vi.fn(async () => undefined);
      const state = createCronServiceState({
        storePath,
        cronConfig: { failureAlert: { enabled: true, after: 1, cooldownMs: 60_000 } },
        nowMs: () => now,
        sendCronFailureAlert,
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });

      await taskRuns.finishCronRun(state, {
        job,
        event: {
          jobId: job.id,
          action: "finished",
          job,
          status: "error",
          error: "provider unavailable",
          failureNotificationDelivery: { status: "unknown" },
          runAtMs: startedAt,
          durationMs: endedAt - startedAt,
          nextRunAtMs: now + 30 * 60_000,
        },
      });

      await start(state);

      const persisted = await loadCronStore(storePath);
      expect(persisted.jobs[0]?.state.lastFailureAlertAtMs).toBe(endedAt);
      expect(persisted.jobs[0]?.state.consecutiveErrors).toBe(1);
      expect(persisted.jobs[0]?.state.lastFailureNotificationDelivered).toBeUndefined();
      expect(persisted.jobs[0]?.state.lastFailureNotificationDeliveryStatus).toBe("unknown");
      expect(persisted.jobs[0]?.state.lastFailureNotificationDeliveryError).toBeUndefined();
      expect(sendCronFailureAlert).not.toHaveBeenCalled();
      stop(state);
    });
  });

  it("keeps manual acknowledgement IDs separate from recoverable task run IDs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await withStateDirForStorePath(storePath, async () => {
      await writeDueIsolatedJobSnapshot(storePath, now);

      const state = createOkIsolatedCronState({ storePath, now, summary: "done" });
      const manualRunId = `manual:isolated-timeout:${now}:1`;

      await expect(
        run(state, "isolated-timeout", "force", { runId: manualRunId }),
      ).resolves.toEqual({
        ok: true,
        ran: true,
      });

      const receipt = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT receipt_id AS receiptId FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC, receipt_id DESC LIMIT 1",
        )
        .get(cronStoreKey(storePath), "isolated-timeout") as { receiptId: string };
      expect(receipt.receiptId).toBe(manualRunId);
      const taskRunId = `cron:isolated-timeout:${now}:${manualRunId}`;
      expectCronRun({
        runId: taskRunId,
        status: "succeeded",
        jobId: "isolated-timeout",
      });
      expect(findCronRunForTests(manualRunId)).toBeUndefined();
    });
  });

  it("persists successful script state from a manual run", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-18T12:00:00.000Z");
    const job: CronJob = {
      id: "manual-script-state",
      name: "manual script state",
      enabled: true,
      createdAtMs: now - 60_000,
      updatedAtMs: now - 60_000,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "script", script: "return { state: { revision: 2 } }" },
      state: { nextRunAtMs: now - 1, triggerState: { revision: 1 } },
    };
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = createCronServiceState({
      storePath,
      cronConfig: { triggers: { enabled: true } },
      nowMs: () => now,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runScriptJob: vi.fn(async () => ({
        status: "ok" as const,
        stateChanged: true,
        state: { revision: 2 },
      })),
    });

    await expect(run(state, job.id)).resolves.toEqual({ ok: true, ran: true });

    const persisted = await loadCronStore(storePath);
    expect(persisted.jobs[0]?.state.triggerState).toEqual({ revision: 2 });
  });

  it("records failed manual runs with cron outcome detail", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await withStateDirForStorePath(storePath, async () => {
      await writeDueIsolatedJobSnapshot(storePath, now);
      const state = createCronServiceState({
        storePath,
        nowMs: () => now,
        runIsolatedAgentJob: vi.fn(async () => ({
          status: "error" as const,
          error: "provider failed",
          provider: "openai",
          model: "gpt-test",
        })),
      });

      await run(state, "isolated-timeout");

      const task = findCronTaskByBaseRunId(`cron:isolated-timeout:${now}`);
      expect(task).toMatchObject({
        status: "failed",
        error: "provider failed",
        detail: {
          kind: "cron-run",
          status: "error",
          provider: "openai",
          model: "gpt-test",
          runAtMs: now,
          durationMs: 0,
        },
      });
    });
  });

  it("does not reschedule a manual lifecycle conflict after execution starts", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const job = createDueIsolatedJob(now);
    job.id = "manual-post-execution-conflict";
    job.name = "manual post-execution conflict";
    job.schedule = { kind: "at", at: new Date(now - 1).toISOString() };

    await withStateDirForStorePath(storePath, async () => {
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const state = createCronServiceState({
        storePath,
        nowMs: () => now,
        runIsolatedAgentJob: vi.fn(async () => ({
          status: "error" as const,
          error: 'Session "agent:main:cron:job-1" changed while starting work. Retry.',
          executionStarted: true,
        })),
      });

      await expect(run(state, job.id)).resolves.toEqual({ ok: true, ran: true });

      const persisted = await loadCronStore(storePath);
      expect(persisted.jobs[0]).toMatchObject({
        id: job.id,
        enabled: false,
        state: {
          consecutiveErrors: 1,
        },
      });
      expect(persisted.jobs[0]?.state.nextRunAtMs).toBeUndefined();
    });
  });

  it("repairs nextRunAtMs=0 on non-schedule edit (#63499)", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-04-09T08:00:00.000Z");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: "broken-job",
          name: "broken",
          enabled: true,
          createdAtMs: now - 86_400_000,
          updatedAtMs: now - 3_600_000,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "test" },
          state: { nextRunAtMs: 0 },
        },
      ],
    });

    const state = createOkIsolatedCronState({ storePath, now });

    const updated = await update(state, "broken-job", { description: "fixed" });

    expect(updated.description).toBe("fixed");
    expect(updated.state.nextRunAtMs).toBeGreaterThan(0);
    expect(updated.state.nextRunAtMs).toBeGreaterThan(now);
  });

  it("records startup catch-up timeouts as timed_out in the shared task registry", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await withStateDirForStorePath(storePath, async () => {
      await writeCronStoreSnapshot({
        storePath,
        jobs: [createMissedIsolatedJob(now)],
      });

      const state = createTimedOutIsolatedCronState({
        storePath,
        now,
      });

      await runMissedJobs(state);

      expectCronRun({
        runId: `cron:startup-timeout:${now}`,
        status: "timed_out",
        jobId: "startup-timeout",
      });
    });
  });

  it("uses explicit lifecycle events instead of scheduled duplicates for the target job", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const events: CronEvent[] = [];
    const state = createOkIsolatedCronState({
      storePath,
      now,
      onEvent: (event) => events.push(structuredClone(event)),
    });

    const job = await add(state, {
      id: "lifecycle-target",
      name: "lifecycle target",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: now },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "tick" },
    });
    expect(events.map((event) => event.action)).toEqual(["added"]);

    events.length = 0;
    await update(state, job.id, {
      schedule: { kind: "every", everyMs: 120_000, anchorMs: now },
    });
    expect(events.map((event) => event.action)).toEqual(["updated"]);

    events.length = 0;
    await remove(state, job.id);
    expect(events.map((event) => event.action)).toEqual(["removed"]);
    state.timer?.cancel();
  });

  it("emits repaired sibling schedules during add before the target lifecycle event", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const sibling = createFutureEveryJob({ id: "repair-during-add", now });
    await writeCronStoreSnapshot({ storePath, jobs: [sibling] });
    const events: CronEvent[] = [];
    const state = createOkIsolatedCronState({
      storePath,
      now,
      onEvent: (event) => events.push(structuredClone(event)),
    });

    const added = await add(state, {
      id: "added-target",
      name: "added target",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: now },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "added" },
    });

    expect(events.map(({ jobId, action }) => ({ jobId, action }))).toEqual([
      { jobId: sibling.id, action: "scheduled" },
      { jobId: added.id, action: "added" },
    ]);
    state.timer?.cancel();
  });
});
