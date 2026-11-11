import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../../test/helpers/cron/service-regression-fixtures.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { findCronRunForTests, readCronRunRecordsForTests } from "../run-history.test-support.js";
import { createCronExecutionId } from "../run-id.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import { loadCronJobsStoreWithConfigJobs, loadCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { inspectActiveCronRunReceipt } from "../store/run-receipt-store.test-support.js";
import type { CronEvent, CronJob } from "../types.js";
import { start, stop } from "./ops-lifecycle.js";
import { add, remove, removeStaleJobFamily, update } from "./ops-mutations.js";
import { list } from "./ops-read.js";
import { run } from "./ops-run.js";
import { createOkIsolatedCronStateFactory } from "./ops.test-support.js";
import * as taskRuns from "./run-history.js";
import { claimCronRecoveryReceipt } from "./run-recovery.test-support.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-ops-seam",
});
const createOkIsolatedCronState = createOkIsolatedCronStateFactory(logger);
let storePath: string;
beforeEach(async () => {
  ({ storePath } = await makeStorePath());
});

type RegressionParams = Parameters<typeof createCronRegressionState>[0];
function createCronServiceState(now: number, params: Partial<RegressionParams> = {}) {
  return createCronRegressionState({
    log: logger,
    storePath,
    nowMs: () => now,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...params,
  });
}

async function withStateDirForStorePath<T>(
  targetStorePath: string,
  runWithStateDir: () => Promise<T>,
): Promise<T> {
  const stateRoot = path.dirname(path.dirname(targetStorePath));
  await closeOpenClawStateDatabaseAsync();
  return await withEnvAsync({ OPENCLAW_STATE_DIR: stateRoot }, async () => {
    try {
      return await runWithStateDir();
    } finally {
      await closeOpenClawStateDatabaseAsync();
    }
  });
}

function createFutureEveryJob(now: number, id: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: now - 60_000,
    updatedAtMs: now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: now },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: id },
    state: {},
    ...overrides,
  };
}

function createDueIsolatedJob(now: number): CronJob {
  return createFutureEveryJob(now, "isolated-timeout", {
    schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "do work" },
    sessionKey: "agent:main:main",
    state: { nextRunAtMs: now - 1 },
  });
}

function insertCronJobRow(targetStorePath: string, job: CronJob) {
  const { state, ...config } = job;
  runOpenClawStateWriteTransaction(({ db }) => {
    requireNativeSqliteDatabase(db)
      .prepare(`
      INSERT INTO cron_jobs (
        store_key, job_id, declaration_key, name, description, enabled, payload_kind,
        job_json, state_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        path.resolve(targetStorePath),
        job.id,
        job.declarationKey ?? null,
        job.name,
        job.description ?? null,
        job.enabled ? 1 : 0,
        job.payload.kind,
        JSON.stringify(config),
        JSON.stringify(state),
        job.updatedAtMs,
      );
  });
}

describe("cron service operations", () => {
  it("removes owner-tagged legacy rows outside the active store", async () => {
    const staleStorePath = path.join(path.dirname(storePath), "legacy-copy", "jobs.json");
    const now = Date.parse("2026-07-29T12:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });
    const family = {
      declarationKey: "memory-core:memory-dreaming-promotion",
      name: "Memory Dreaming Promotion",
      ownerPluginTag: "[managed-by=memory-core.short-term-promotion]",
    };
    const current = await add(state, {
      declarationKey: family.declarationKey,
      name: family.name,
      description: `${family.ownerPluginTag} current`,
      enabled: true,
      schedule: { kind: "cron", expr: "*/3 * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "dream" },
    });
    const legacy = createFutureEveryJob(now, "75e182e6-8728-43ae-832b-01f50702feed", {
      name: family.name,
      description: `${family.ownerPluginTag} legacy`,
      createdAtMs: now - 10_000,
      updatedAtMs: now - 10_000,
      schedule: { kind: "cron", expr: "0 3 * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "dream" },
    });
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
    expect(remaining).toEqual(
      [
        { store_key: path.resolve(storePath), job_id: current.id },
        { store_key: path.resolve(staleStorePath), job_id: "operator-same-name" },
      ].toSorted((a, b) => a.job_id.localeCompare(b.job_id)),
    );
  });
  it("starts and lists future jobs after upgrading from a database without receipts", async () => {
    const now = Date.parse("2026-05-20T08:30:00.000Z");
    const job = createFutureEveryJob(now, "pre-receipt-upgrade");
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
    const now = Date.parse("2026-05-20T09:00:00.000Z");
    const legacyJob = {
      ...createFutureEveryJob(now, "legacy-notify"),
      schedule: { kind: "every", everyMs: 3_600_000, anchorMs: now },
      sessionTarget: "isolated",
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
    const state = createCronServiceState(now, {
      cronConfig: { webhook: "https://example.invalid/cron" } as never,
    });

    await start(state);

    const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const persisted = loaded.store.jobs[0] as CronJob & { notify?: unknown };
    expect(persisted.notify).toBeUndefined();
    expect(persisted.delivery).toEqual({ to: "telegram:chat-1" });
    expect(readDefinition()).toBe(before);
    expect(loaded.configJobs[0]?.notify).toBe(true);
  });

  it.each(["canonical", "pre-upgrade", "foreign"] as const)(
    "recovers a finalized %s task run when startup finds its stale marker",
    async (identity) => {
      const now = Date.parse("2026-03-23T12:00:00.000Z");
      const startedAt = now - 30 * 60_000 + 250;
      const endedAt = startedAt + 4_000;

      await withStateDirForStorePath(storePath, async () => {
        const job = createFutureEveryJob(now, "startup-interrupted", {
          createdAtMs: now - 86_400_000,
          updatedAtMs: now - 30 * 60_000,
          schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
          trigger: { script: "json({ fire: true })", once: true },
          payload: { kind: "script", script: "return { state: { cursor: 'payload' } }" },
          state: {
            nextRunAtMs: now - 60_000,
            runningAtMs: startedAt,
            lastFailureNotificationDelivered: true,
            lastFailureNotificationDeliveryStatus: "delivered",
            triggerState: { cursor: "old" },
          },
        });
        await writeCronStoreSnapshot({ storePath, jobs: [job] });
        const receipt =
          identity !== "foreign"
            ? claimCronRecoveryReceipt(storePath, job, startedAt, "main")
            : undefined;
        const events: CronEvent[] = [];
        const state = createCronServiceState(now, {
          onEvent: (event) => events.push(structuredClone(event)),
        });
        const taskRunId =
          identity === "canonical"
            ? taskRuns.createCronRunHandle({ state, job, startedAt, runReceipt: receipt }).runId
            : identity === "foreign"
              ? "foreign-run"
              : `${createCronExecutionId(job.id, startedAt - 250)}:legacy-upgrade`;

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
        const restored = (await loadCronStore(storePath)).jobs[0];
        const receiptRow = receipt
          ? runOpenClawStateWriteTransaction(({ db }) =>
              db
                .prepare(
                  "SELECT status, finished_at_ms AS finishedAtMs, error_text AS error FROM cron_run_receipts WHERE receipt_id = ?",
                )
                .get(receipt.receiptId),
            )
          : undefined;
        expect(restored?.state).toMatchObject({ lastRunAtMs: startedAt });
        expect(restored?.state.runningAtMs).toBeUndefined();
        if (identity !== "canonical") {
          expect(restored?.state).toMatchObject({
            lastRunStatus: "error",
            lastStatus: "error",
            lastError: "cron: job interrupted by gateway restart",
            triggerState: { cursor: "old" },
          });
          if (receipt) {
            expect(receiptRow).toEqual({
              status: "interrupted",
              finishedAtMs: now,
              error: "cron: job interrupted by gateway restart",
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
        expect(restored).toMatchObject({
          enabled: false,
          state: {
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
        for (const field of ["lastError", "nextRunAtMs"] as const) {
          expect(restored?.state[field]).toBeUndefined();
        }
        if (receipt) {
          expect(receiptRow).toEqual({ status: "ok", finishedAtMs: endedAt, error: null });
        }
        expect(events.filter((event) => event.action === "finished")).toEqual([]);
        stop(state);
      });
    },
  );

  it("recovers a rescheduled delete-after-run one-shot after a finalized error", async () => {
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const startedAt = now - 30_000;
    const endedAt = startedAt + 4_000;
    const replacementAt = now - 5_000;

    await withStateDirForStorePath(storePath, async () => {
      const replacement = createDueIsolatedJob(now);
      replacement.id = "startup-rescheduled-finalized-one-shot-true";
      replacement.deleteAfterRun = true;
      replacement.schedule = { kind: "at", at: new Date(replacementAt).toISOString() };
      replacement.updatedAtMs = now - 10_000;
      replacement.state = { runningAtMs: startedAt, nextRunAtMs: replacementAt };
      await writeCronStoreSnapshot({ storePath, jobs: [replacement] });

      const original = structuredClone(replacement);
      original.schedule = { kind: "at", at: new Date(startedAt).toISOString() };
      original.updatedAtMs = startedAt;
      original.state.nextRunAtMs = startedAt;

      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronServiceState(now, { runIsolatedAgentJob });
      const { runId: taskRunId } = taskRuns.createCronRunHandle({
        state,
        job: original,
        startedAt,
      });
      await taskRuns.finishCronRun(state, {
        taskRunId,
        job: original,
        event: {
          jobId: original.id,
          action: "finished",
          job: original,
          status: "error",
          completionStatus: "failed",
          error: "original failed before restart",
          summary: "original completed before restart",
          runAtMs: startedAt,
          durationMs: endedAt - startedAt,
        },
      });

      try {
        await start(state);

        const restored = (await loadCronStore(storePath)).jobs.find(
          (job) => job.id === replacement.id,
        );
        expect(restored).toMatchObject({
          enabled: true,
          state: { lastRunAtMs: startedAt, lastRunStatus: "error" },
        });
        expect(restored?.state.nextRunAtMs).toBeGreaterThan(now);
        expect(restored?.state.startupCatchupAtMs).toBe(restored?.state.nextRunAtMs);
        expect(restored?.state.runningAtMs).toBeUndefined();
        expect(runIsolatedAgentJob).not.toHaveBeenCalled();
        expect(findCronRunForTests(taskRunId)?.status).toBe("failed");
      } finally {
        stop(state);
      }
    });
  });

  it("keeps manual acknowledgement IDs separate from recoverable task run IDs", async () => {
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await withStateDirForStorePath(storePath, async () => {
      await writeCronStoreSnapshot({ storePath, jobs: [createDueIsolatedJob(now)] });

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
      expect(
        findCronRunForTests(taskRunId) ??
          readCronRunRecordsForTests().find((task) => task.runId?.startsWith(`${taskRunId}:`)),
      ).toMatchObject({ status: "succeeded", jobId: "isolated-timeout" });
      expect(findCronRunForTests(manualRunId)).toBeUndefined();
    });
  });

  it("does not reschedule a manual lifecycle conflict after execution starts", async () => {
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const job = createDueIsolatedJob(now);
    job.id = "manual-post-execution-conflict";
    job.schedule = { kind: "at", at: new Date(now - 1).toISOString() };

    await withStateDirForStorePath(storePath, async () => {
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const state = createCronServiceState(now, {
        runIsolatedAgentJob: vi.fn(async () => ({
          status: "error" as const,
          error: 'Session "agent:main:cron:job-1" changed while starting work. Retry.',
          executionStarted: true,
        })),
      });

      await expect(run(state, job.id)).resolves.toEqual({ ok: true, ran: true });

      const restored = (await loadCronStore(storePath)).jobs[0];
      expect(restored).toMatchObject({
        id: job.id,
        enabled: false,
        state: { consecutiveErrors: 1 },
      });
      expect(restored?.state.nextRunAtMs).toBeUndefined();
    });
  });

  it("repairs nextRunAtMs=0 on non-schedule edit (#63499)", async () => {
    const now = Date.parse("2026-04-09T08:00:00.000Z");

    const job = createFutureEveryJob(now, "broken-job", {
      createdAtMs: now - 86_400_000,
      updatedAtMs: now - 3_600_000,
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      payload: { kind: "systemEvent", text: "test" },
      state: { nextRunAtMs: 0 },
    });
    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const state = createOkIsolatedCronState({ storePath, now });

    const updated = await update(state, "broken-job", { description: "fixed" });

    expect(updated.description).toBe("fixed");
    expect(updated.state.nextRunAtMs).toBeGreaterThan(now);
  });

  it("uses explicit lifecycle events instead of scheduled duplicates for the target job", async () => {
    const { storePath: lifecycleStorePath } = await makeStorePath();
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const events: CronEvent[] = [];
    const state = createOkIsolatedCronState({
      storePath: lifecycleStorePath,
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
  });

  it("emits repaired sibling schedules during add before the target lifecycle event", async () => {
    const now = Date.parse("2026-06-09T00:00:00.000Z");
    const sibling = createFutureEveryJob(now, "repair-during-add");
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
  });
});
