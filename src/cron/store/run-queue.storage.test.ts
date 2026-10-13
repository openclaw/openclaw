import { expect, it } from "vitest";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { loadCronStoreFromDatabase } from "./load.kernel.js";
import { drainCronQueueInWorker } from "./run-queue.worker.js";
import { createCronScheduledRunId } from "./run-request-id.js";

it.each([false, true])(
  "keeps authored job bytes and row ownership when requesting an exit event: %s",
  async (onExit) => {
    await withOpenClawTestState({ label: "cron-queue-authored-data" }, async (fixture) => {
      const now = 1_800_000_000_000;
      const storeKey = fixture.statePath("cron", "jobs.json");
      const job: CronJob = {
        id: "authored",
        name: "authored",
        agentId: "main",
        enabled: true,
        createdAtMs: now - 1000,
        updatedAtMs: now - 1000,
        schedule: onExit
          ? { kind: "on-exit", command: "synthetic-watch" }
          : { kind: "every", everyMs: 60_000 },
        payload: { kind: "command", argv: ["echo", "synthetic"] },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        delivery: { mode: "none" },
        state: { nextRunAtMs: now },
      };
      await saveCronStore(storeKey, { version: 1, jobs: [job] });
      await closeOpenClawStateDatabaseAsync();
      let db = openOpenClawStateDatabase().db;
      db.prepare(
        "UPDATE cron_jobs SET owner_agent_id = 'main', grant_definition_generation = 17, job_json = json_set(json_remove(job_json, '$.enabled'), '$.authoredNote', 'preserve me') WHERE store_key = ? AND job_id = ?",
      ).run(storeKey, job.id);
      const read = () =>
        db
          .prepare(
            "SELECT job_json, agent_id, owner_agent_id, sort_order, updated_at, grant_definition_revision, grant_definition_generation, grant_definition_updated_at FROM cron_jobs WHERE store_key = ? AND job_id = ?",
          )
          .get(storeKey, job.id);
      const before = read()!;
      await closeOpenClawStateDatabaseAsync();
      const context = captureOpenClawStateWorkerContext();
      await executeOpenClawStateWorker(context, { type: "cron.initializeRunReceipts", input: {} });
      const loaded = await executeOpenClawStateWorker(context, {
        type: "cron.loadMutable",
        input: { storeKey },
      });
      if (!loaded.ok) {
        throw new Error(loaded.error.message);
      }
      const current = loaded.loaded.store.jobs[0]!;
      const result = await executeOpenClawStateWorker(context, {
        type: "cron.requestRuns",
        input: {
          storeKey,
          nowMs: now,
          requests: [
            {
              jobId: job.id,
              receiptId: onExit
                ? "cron:request:exit"
                : createCronScheduledRunId(storeKey, job.id, now),
              configRevision: resolveCronJobConfigRevision(current),
              mode: onExit ? "on-exit" : "scheduled",
              onExitSchedule: onExit ? { kind: "on-exit", command: "synthetic-watch" } : undefined,
              scheduledSlotMs: onExit ? undefined : now,
            },
          ],
        },
      });
      expect(result.rejected).toEqual([]);
      expect(result.accepted).toHaveLength(1);
      await closeOpenClawStateDatabaseAsync();
      db = openOpenClawStateDatabase().db;
      const after = read()!;
      expect({ ...after, job_json: undefined }).toEqual({ ...before, job_json: undefined });
      expect(onExit ? JSON.parse(String(after.job_json)) : after.job_json).toEqual(
        onExit ? { ...JSON.parse(String(before.job_json)), enabled: false } : before.job_json,
      );
      expect(result.accepted[0]?.job.state.queuedAtMs).toBe(now);
    });
  },
);

it("keeps requested occurrences and siblings intact when activation rolls back", async () => {
  await withOpenClawTestState({ label: "cron-queue-activation-rollback" }, async (fixture) => {
    const now = 1_800_000_000_000;
    const storeKey = fixture.statePath("cron", "jobs.json");
    const jobs: CronJob[] = ["failing", "sibling"].map((id) => ({
      id,
      name: id,
      agentId: "main",
      enabled: true,
      createdAtMs: now - 1000,
      updatedAtMs: now - 1000,
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "command", argv: ["echo", "synthetic"] },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      delivery: { mode: "none" },
      state: { nextRunAtMs: now },
    }));
    await saveCronStore(storeKey, { version: 1, jobs });
    const context = captureOpenClawStateWorkerContext();
    await executeOpenClawStateWorker(context, { type: "cron.initializeRunReceipts", input: {} });
    const requests = jobs.map((job) => ({
      jobId: job.id,
      receiptId: createCronScheduledRunId(storeKey, job.id, now),
      configRevision: resolveCronJobConfigRevision(job),
      mode: "scheduled" as const,
      scheduledSlotMs: now,
    }));
    expect(
      (
        await executeOpenClawStateWorker(context, {
          type: "cron.requestRuns",
          input: { storeKey, nowMs: now, requests },
        })
      ).accepted,
    ).toHaveLength(2);
    await closeOpenClawStateDatabaseAsync();
    const database = openOpenClawStateDatabase();
    // Install the fault after admission on the connection this storage operation owns.
    database.db.exec(`CREATE TRIGGER fail_queue_activation
      BEFORE UPDATE OF state_json ON cron_jobs
      WHEN NEW.job_id = 'failing' AND json_extract(NEW.state_json, '$.runningAtMs') IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'synthetic activation failure'); END;`);
    const drain = () =>
      runWithSqliteWorkerStateContext(
        {
          environment: {
            ...fixture.env,
            OPENCLAW_STATE_DIR: fixture.stateDir,
            OPENCLAW_SUPERVISOR_MODE: undefined,
          },
        },
        () =>
          drainCronQueueInWorker(database, {
            storeKey,
            nowMs: now + 1,
            maxConcurrentRuns: 2,
            requests: [],
          }),
      );
    try {
      expect(drain).toThrow("synthetic activation failure");
      const loaded = loadCronStoreFromDatabase(database.db, storeKey);
      expect(
        loaded.store.jobs.map((job) => [job.id, job.state.queuedAtMs, job.state.runningAtMs]),
      ).toEqual([
        ["failing", now, undefined],
        ["sibling", now, undefined],
      ]);
    } finally {
      database.db.exec("DROP TRIGGER fail_queue_activation");
    }
    expect(drain().launches.map((entry) => entry.runReceipt.receiptId)).toEqual(
      requests.map((request) => request.receiptId),
    );
  });
});
