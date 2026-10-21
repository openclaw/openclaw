import { expect, it } from "vitest";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadCronStoreFromDatabase } from "./load.kernel.js";
import { queueJob, queueStore, requestForJob } from "./run-queue.test-support.js";
import { drainCronQueueInWorker } from "./run-queue.worker.js";

const now = 1_800_000_000_000;
const makeJob = (id: string, onExit = false) =>
  queueJob(id, now, {
    payload: { kind: "command", argv: ["echo", "synthetic"] },
    ...(onExit ? { schedule: { kind: "on-exit", command: "synthetic-watch" } as const } : {}),
  });

it.each([false, true])(
  "keeps authored job bytes and row ownership when requesting an exit event: %s",
  async (onExit) => {
    await withOpenClawTestState({ label: "cron-queue-authored-data" }, async (fixture) => {
      const storeKey = fixture.statePath("cron", "jobs.json");
      const job = makeJob("authored", onExit);
      const queue = await queueStore(storeKey, [job], now);
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
      const current = (await queue.read()).jobs[0]!;
      const result = await queue.request([requestForJob(storeKey, current, now)]);
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

it("preserves a durable claim when its runtime queue marker is absent", async () => {
  await withOpenClawTestState({ label: "cron-queue-claim-conflict" }, async (fixture) => {
    const storeKey = fixture.statePath("cron", "jobs.json");
    const job = makeJob("claimed");
    const queue = await queueStore(storeKey, [job], now);
    const request = requestForJob(storeKey, job, now);
    const first = await queue.request([request]);
    expect(first.accepted).toHaveLength(1);
    await closeOpenClawStateDatabaseAsync();
    const db = openOpenClawStateDatabase().db;
    // An offline fixture repair loses the marker but must not release the durable claim.
    db.prepare("UPDATE cron_jobs SET state_json = ? WHERE store_key = ? AND job_id = ?").run(
      JSON.stringify(job.state),
      storeKey,
      job.id,
    );
    const before = db
      .prepare("SELECT * FROM cron_run_receipts WHERE receipt_id = ?")
      .get(request.receiptId);
    await closeOpenClawStateDatabaseAsync();
    const competing = { ...request, mode: "force" as const, receiptId: "cron:request:competing" };
    const retry = await queue.request([request, competing], now + 1);
    expect(retry.accepted).toEqual([]);
    expect(retry.rejected).toEqual([
      { jobId: job.id, receiptId: request.receiptId, reason: "already-requested" },
      { jobId: job.id, receiptId: competing.receiptId, reason: "already-running" },
    ]);
    await closeOpenClawStateDatabaseAsync();
    expect(
      openOpenClawStateDatabase()
        .db.prepare("SELECT * FROM cron_run_receipts WHERE store_key = ?")
        .all(storeKey),
    ).toEqual([before]);
  });
});

it("keeps requested occurrences and siblings intact when activation rolls back", async () => {
  await withOpenClawTestState({ label: "cron-queue-activation-rollback" }, async (fixture) => {
    const storeKey = fixture.statePath("cron", "jobs.json");
    const jobs = ["failing", "sibling"].map((id) => makeJob(id));
    const queue = await queueStore(storeKey, jobs, now);
    const context = captureOpenClawStateWorkerContext();
    await executeOpenClawStateWorker(context, { type: "cron.initializeRunReceipts", input: {} });
    const requests = jobs.map((job) => requestForJob(storeKey, job, now));
    expect((await queue.request(requests)).accepted).toHaveLength(2);
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
