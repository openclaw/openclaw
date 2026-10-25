import { expect, it } from "vitest";
import { createDueIsolatedJob } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { runWithSqliteWorkerStateContext as withWorkerState } from "../../infra/sqlite-worker-state-context.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { claimCronRecoveryReceipt } from "../service/run-recovery.test-support.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { mutateCronJobsInWorker } from "./guarded-mutation.worker.js";
import { cronStoreKey } from "./key.js";
import { loadCronStoreFromDatabase } from "./load.kernel.js";
import { finalizeCronRunsInWorker } from "./run-finalization.worker.js";
import { queueJob, queueStore, requestForJob, scheduled } from "./run-queue.test-support.js";
import {
  cancelCronRequestsInWorker,
  drainCronQueueInWorker,
  requestCronRunsInWorker,
} from "./run-queue.worker.js";

it("commits execution, delivery, and history once despite an owner edit and a duplicate terminal result", async () => {
  await withOpenClawTestState({ label: "cron-terminal-result" }, async (fixture) => {
    const now = Date.now();
    const storePath = fixture.statePath("cron", "jobs.json");
    const job = createDueIsolatedJob({ id: "completed", nowMs: now, nextRunAtMs: now });
    job.payload = { kind: "command", argv: ["echo", "synthetic"] };
    job.state.runningAtMs = now;
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const receipt = claimCronRecoveryReceipt(storePath, job, now, "main");
    job.state.runningReceiptId = receipt.receiptId;
    const edited = { ...job, name: "edited while running", agentId: "replacement-agent" };
    await saveCronStore(storePath, { version: 1, jobs: [edited] });
    const database = openOpenClawStateDatabase();
    const row = (sql: string, id: string) => database.db.prepare(sql).get(id);
    // Clock-skewed history must not evict the pending marker, even after clearing the live job.
    const seedHistory = database.db.prepare(`
      INSERT INTO cron_run_receipts (
        receipt_id, cursor_id, store_key, job_id, config_revision, agent_id, status,
        owner_pid, owner_start_time, started_at_ms, finished_at_ms
      ) SELECT ?, (SELECT COALESCE(MAX(cursor_id), 0) + 1 FROM cron_run_receipts),
               store_key, job_id, config_revision, agent_id, 'ok',
               owner_pid, owner_start_time, ?, ?
        FROM cron_run_receipts WHERE receipt_id = ?
    `);
    for (let index = 0; index < 64; index += 1) {
      seedHistory.run(`history-${index}`, now + 100 + index, now + 101 + index, receipt.receiptId);
    }
    const finalize = (status: "ok" | "error") =>
      withWorkerState({ environment: { OPENCLAW_STATE_DIR: fixture.stateDir } }, () =>
        finalizeCronRunsInWorker(database, {
          storeKey: cronStoreKey(storePath),
          snapshot: {
            nowMs: now + 10,
            defaultAgentId: "main",
            outcomes: [
              {
                jobId: job.id,
                job,
                runReceipt: receipt,
                status,
                completionStatus: status === "ok" ? "succeeded" : "failed",
                deliveryState: {
                  status: "delivered",
                  delivered: true,
                  failureNotification: { status: "not-requested" },
                },
                startedAt: now,
                endedAt: now + 10,
              },
            ],
          },
        }),
      );
    database.db.exec(`
      CREATE TEMP TRIGGER fail_cron_history BEFORE INSERT ON task_runs
      BEGIN SELECT RAISE(ABORT, 'synthetic history failure'); END
    `);
    expect(() => finalize("ok")).toThrow("synthetic history failure");
    const receiptStatus = () =>
      row("SELECT status FROM cron_run_receipts WHERE receipt_id = ?", receipt.receiptId)?.status;
    expect({
      receipt: receiptStatus(),
      history: row("SELECT COUNT(*) AS count FROM task_runs WHERE source_id = ?", job.id)?.count,
      marker: (await loadCronStore(storePath)).jobs[0]?.state.runningReceiptId,
    }).toEqual({ receipt: "running", history: 0, marker: receipt.receiptId });
    database.db.exec("DROP TRIGGER fail_cron_history");
    expect(finalize("ok").outcome.eventPlans).toHaveLength(1);
    expect(finalize("error").outcome.eventPlans).toHaveLength(0);
    expect((await loadCronStore(storePath)).jobs[0]).toMatchObject({
      name: edited.name,
      agentId: edited.agentId,
      state: { lastRunStatus: "ok", lastDelivered: true, lastDeliveryStatus: "delivered" },
    });
    expect(receiptStatus()).toBe("ok");
    expect(row("SELECT COUNT(*) AS count FROM cron_run_receipts WHERE job_id = ?", job.id)).toEqual(
      { count: 64 },
    );
    expect(
      database.db.prepare("SELECT status, ended_at FROM task_runs WHERE source_id = ?").all(job.id),
    ).toEqual([{ status: "succeeded", ended_at: now + 10 }]);
  });
});

it.each(["cancel", "disable"] as const)(
  "retains an unstarted due slot across receipt pruning without replay after %s",
  async (terminalAction) => {
    await withOpenClawTestState({ label: "cron-deferred-receipts" }, async (fixture) => {
      const now = 1_800_000_000_000;
      const storeKey = fixture.statePath("cron", "jobs.json");
      const original = queueJob("deferred", now, {
        schedule: { kind: "every", everyMs: 60_000, anchorMs: now },
        state: { nextRunAtMs: now, lastRunStatus: "ok", lastRunAtMs: now - 60_000 },
      });
      await saveCronStore(storeKey, { version: 1, jobs: [original] });
      await closeOpenClawStateDatabaseAsync();
      const database = openOpenClawStateDatabase();
      withWorkerState({ environment: { OPENCLAW_STATE_DIR: fixture.stateDir } }, () => {
        const request = scheduled(storeKey, original, now);
        const claim = () =>
          requestCronRunsInWorker(database, { storeKey, nowMs: now, requests: [request] });
        const current = () => loadCronStoreFromDatabase(database.db, storeKey).store.jobs[0]!;
        // Exercise real retention: the first receipt must disappear, but the slot remains due.
        for (let index = 0; index < 65; index += 1) {
          expect(claim().accepted).toHaveLength(1);
          const run = drainCronQueueInWorker(database, {
            storeKey,
            nowMs: now + 1,
            requests: [],
            maxConcurrentRuns: 1,
          }).launches[0]!;
          expect(run).toBeDefined();
          const result = finalizeCronRunsInWorker(database, {
            storeKey,
            snapshot: {
              nowMs: now + index + 10,
              defaultAgentId: "main",
              outcomes: [
                {
                  jobId: original.id,
                  job: run.job,
                  runReceipt: run.runReceipt,
                  status: "skipped",
                  completionStatus: "failed",
                  deliveryState: {
                    status: "not-requested",
                    failureNotification: { status: "not-requested" },
                  },
                  admissionDeferred: true,
                  executionStarted: false,
                  startedAt: run.runReceipt.startedAtMs,
                  endedAt: now + index + 10,
                },
              ],
            },
          });
          expect(result.outcome.eventPlans).toEqual([]);
          expect(current().state).toMatchObject(original.state);
          expect(current().state.runningAtMs).toBeUndefined();
        }
        expect(
          database.db
            .prepare("SELECT receipt_id FROM cron_run_receipts WHERE receipt_id = ?")
            .get(request.receiptId),
        ).toBeUndefined();
        expect(database.db.prepare("SELECT COUNT(*) AS count FROM task_runs").get()).toEqual({
          count: 0,
        });
        const retried = claim().accepted[0]!;
        expect(retried.runReceipt.receiptId).not.toBe(request.receiptId);
        // The final decision is authoritative even after a backward clock adjustment.
        if (terminalAction === "cancel") {
          cancelCronRequestsInWorker(database, {
            storeKey,
            receiptIds: [retried.runReceipt.receiptId],
            nowMs: now + 2,
            reason: "synthetic cancellation",
          });
        } else {
          mutateCronJobsInWorker(database, {
            storeKey,
            jobMutation: {
              kind: "update",
              id: original.id,
              patch: { enabled: false },
              options: { captured: false },
            },
            snapshot: { nowMs: now + 2 },
          });
        }
        expect(
          database.db
            .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
            .get(retried.runReceipt.receiptId),
        ).toEqual({ status: "skipped" });
        expect(claim().rejected).toEqual([
          { jobId: original.id, receiptId: request.receiptId, reason: "already-requested" },
        ]);
        if (terminalAction === "cancel") {
          expect(current().state.nextRunAtMs).toBe(now + 60_000);
        }
        expect(current().state.queuedAtMs).toBeUndefined();
        expect(database.db.prepare("SELECT COUNT(*) AS count FROM task_runs").get()).toEqual({
          count: 1,
        });
      });
    });
  },
);

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
      withWorkerState(
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

it("reads one receipt set while preserving capacity and cancellation contexts", async () => {
  await withOpenClawTestState({ label: "cron-drain-receipt-reads" }, async (fixture) => {
    const storeKey = fixture.statePath("cron", "local.json");
    const foreignStoreKey = fixture.statePath("cron", "foreign.json");
    const jobs = ["blocker", "z-first", "a-second", "cancelled", "omitted"].map((id) =>
      queueJob(id, now),
    );
    const foreignJob = queueJob("foreign-cancelled", now);
    await saveCronStore(storeKey, { version: 1, jobs });
    await saveCronStore(foreignStoreKey, { version: 1, jobs: [foreignJob] });
    await closeOpenClawStateDatabaseAsync();
    const database = openOpenClawStateDatabase();
    withWorkerState({ environment: { OPENCLAW_STATE_DIR: fixture.stateDir } }, () => {
      const requests = jobs.map((job) => scheduled(storeKey, job, now));
      const [blocker, first, second, cancelled, omitted] = requests;
      const foreign = scheduled(foreignStoreKey, foreignJob, now);
      const request = (key: string, entries: typeof requests) =>
        requestCronRunsInWorker(database, { storeKey: key, nowMs: now, requests: entries });
      const drain = (contexts: typeof requests, maxConcurrentRuns: number, nowMs = now + 3) =>
        drainCronQueueInWorker(database, {
          storeKey,
          nowMs,
          requests: contexts,
          maxConcurrentRuns,
        });
      request(storeKey, [blocker!]);
      expect(drain([], 1, now + 1).launches.map(({ job }) => job.id)).toEqual(["blocker"]);
      request(storeKey, [second!, cancelled!, omitted!, first!]);
      request(foreignStoreKey, [foreign]);
      for (const [key, entries] of [
        [storeKey, [cancelled!, omitted!]],
        [foreignStoreKey, [foreign]],
      ] as const) {
        expect(
          cancelCronRequestsInWorker(database, {
            storeKey: key,
            receiptIds: entries.map(({ receiptId }) => receiptId),
            nowMs: now + 2,
            reason: "",
          }).skipped,
        ).toHaveLength(entries.length);
      }
      const reads = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(database.db),
        ["receipts"],
        (sql) =>
          /^select\b/i.test(sql) && /\bfrom\s+"cron_run_receipts"(?:\s|$)/i.test(sql)
            ? "receipts"
            : null,
      );
      try {
        const withoutContexts = drain([], 2);
        const emptyReads = reads.counts.receipts;
        const withContexts = drain([cancelled!, foreign], 3);
        expect(withoutContexts.launches.map(({ job }) => job.id)).toEqual(["z-first"]);
        expect(withContexts.launches.map(({ job }) => job.id)).toEqual(["a-second"]);
        expect(withoutContexts.skipped).toEqual([]);
        expect(
          withContexts.skipped.map(({ runReceipt, error }) => [runReceipt.receiptId, error]),
        ).toEqual([[cancelled!.receiptId, ""]]);
        // The empty drain stays at one SELECT; the contextful drain removes its second SELECT.
        expect([emptyReads, reads.counts.receipts]).toEqual([1, 2]);
      } finally {
        reads.restore();
      }
    });
  });
});
