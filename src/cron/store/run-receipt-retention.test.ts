import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as sqliteQuery from "../../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction as write,
} from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { CronService } from "../service.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import { cronStoreKey } from "./key.js";
import { finishCronRunReceiptInDatabase as finishReceipt } from "./run-receipt-store.js";
import {
  claimCronRunReceiptForTest,
  inspectActiveCronRunReceipt,
  finishCronRunReceiptAsync as finish,
} from "./run-receipt-store.test-support.js";
import { prepareCronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-pending-retention-" });
afterEach(() => vi.restoreAllMocks());

it("keeps the pending terminal receipt within 64 rows until reconciliation releases it", async () => {
  const { storePath } = await makeStorePath();
  const now = Date.now();
  const started = createDeferred();
  const completion = createDeferred<{ status: "ok" }>();
  const runCommandJob = vi.fn(async () => {
    started.resolve();
    return completion.promise;
  });
  const makeService = (cronEnabled = true) =>
    new CronService({
      scheduler: createTestGatewayScheduler(),
      nowMs: () => Date.now(),
      storePath,
      cronEnabled,
      log: logger,
      enqueueSystemEvent() {},
      requestHeartbeat() {},
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runCommandJob,
    });
  const owner = makeService();
  const editor = makeService(false);
  const reconciler = makeService();
  const job = await editor.add({
    name: "pending receipt retention",
    agentId: "alpha",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: now + 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "command", argv: ["true"] },
  });
  const history: string[] = [];
  // Clock-skewed history must not evict the pending receipt.
  for (let index = 0; index < 64; index += 1) {
    const receipt = claimCronRunReceiptForTest(storePath, job, now + 100 + index * 2);
    history.push(receipt.receiptId);
    await finish({ handle: receipt, status: "ok", finishedAtMs: now + 101 + index * 2 });
  }
  const database = openOpenClawStateDatabase().db;
  const terminalIds = () =>
    database
      .prepare(
        `SELECT receipt_id AS receiptId FROM cron_run_receipts
           WHERE store_key = ? AND job_id = ? AND status != 'running'
           ORDER BY finished_at_ms DESC, started_at_ms DESC, receipt_id DESC`,
      )
      .all(cronStoreKey(storePath), job.id)
      .map((row) => row.receiptId);
  const running = owner.run(job.id, "force");
  try {
    await started.promise;
    const pending = inspectActiveCronRunReceipt({ storePath, jobId: job.id });
    expect(pending).toBeDefined();
    await editor.update(job.id, { state: { triggerState: { owner: "saved edit" } } });
    const retirement = () =>
      database
        .prepare("SELECT receipt_id FROM cron_run_trigger_state_retirements WHERE receipt_id = ?")
        .get(pending!.receiptId);
    expect(retirement()).toEqual({ receipt_id: pending!.receiptId });

    database.exec(`
        CREATE TRIGGER reject_pending_receipt_completion BEFORE UPDATE ON cron_jobs
        WHEN NEW.job_id = '${job.id}' AND json_extract(NEW.state_json, '$.runningAtMs') IS NULL
        BEGIN SELECT RAISE(ABORT, 'pending receipt completion unavailable'); END;
      `);
    completion.resolve({ status: "ok" });
    await expect(running).rejects.toThrow("pending receipt completion unavailable");
    database.exec("DROP TRIGGER reject_pending_receipt_completion");
    owner.stop();
    await editor.update(job.id, { agentId: "beta" });

    expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toMatchObject({
      receiptId: pending!.receiptId,
    });
    // A late result prunes while preserving the unreconciled run marker after an owner edit.
    const queries = vi.spyOn(sqliteQuery, "executeSqliteQuerySync");
    write(({ db }) =>
      finishReceipt({
        database: db,
        receiptSchema: prepareCronRunReceiptWriteSchema(db),
        handle: pending!,
        pendingReceiptId: pending!.receiptId,
        status: "ok",
        finishedAtMs: now,
      }),
    );
    const fetchedRows = queries.mock.results.flatMap((result) =>
      result.type === "return" ? result.value.rows : [],
    ).length;
    queries.mockRestore();
    expect(terminalIds()).toEqual([...history.slice(1).toReversed(), pending!.receiptId]);
    expect(retirement()).toEqual({ receipt_id: pending!.receiptId });
    expect((await loadCronStore(storePath)).jobs[0]?.state.runningReceiptId).toBe(
      pending!.receiptId,
    );
    expect(fetchedRows).toBeLessThanOrEqual(8);

    await reconciler.start();
    expect(runCommandJob).toHaveBeenCalledOnce();
    const recovered = (await loadCronStore(storePath)).jobs[0]!;
    expect(recovered.state.runningAtMs).toBeUndefined();
    expect(recovered.state.runningReceiptId).toBeUndefined();
    expect(recovered.state.triggerState).toEqual({ owner: "saved edit" });
    expect(retirement()).toEqual({ receipt_id: pending!.receiptId });

    vi.setSystemTime(now + 1_000);
    await expect(reconciler.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
    expect(runCommandJob).toHaveBeenCalledTimes(2);
    expect(terminalIds()).toHaveLength(64);
    expect(terminalIds()).not.toContain(pending!.receiptId);
    // Query directly: a receipt join would hide a dangling retirement after pruning.
    expect(retirement()).toBeUndefined();
  } finally {
    database.exec("DROP TRIGGER IF EXISTS reject_pending_receipt_completion");
    completion.resolve({ status: "ok" });
    await running.catch(() => undefined);
    owner.stop();
    editor.stop();
    reconciler.stop();
  }
});
