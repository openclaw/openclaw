import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as sqliteQuery from "../../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { CronService } from "../service.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import type { CronServiceDeps } from "../service/state.js";
import { loadCronStore } from "../store.js";
import { cronStoreKey } from "./key.js";
import {
  claimCronRunReceiptInDatabase,
  finishCronRunReceipt,
  prepareCronRunReceiptClaim,
} from "./run-receipt-store.js";
import { inspectActiveCronRunReceipt } from "./run-receipt-store.test-support.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-pending-retention-" });

describe("pending cron receipt retention", () => {
  it("keeps the pending terminal receipt within 64 rows until reconciliation releases it", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const started = createDeferred();
    const completion = createDeferred<{ status: "ok" }>();
    const runCommandJob = vi
      .fn<NonNullable<CronServiceDeps["runCommandJob"]>>()
      .mockResolvedValue({ status: "ok" })
      .mockImplementationOnce(async () => {
        started.resolve();
        return completion.promise;
      });
    const makeService = (cronEnabled = true) =>
      new CronService({
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
    // A clock adjustment can leave all existing terminal rows newer than the
    // next admitted run. Its pending job association must keep the receipt.
    for (let index = 0; index < 64; index += 1) {
      const prepared = prepareCronRunReceiptClaim({
        storePath,
        job,
        agentId: "alpha",
        startedAtMs: now + 100 + index * 2,
      });
      const receipt = runOpenClawStateWriteTransaction(({ db }) =>
        claimCronRunReceiptInDatabase({
          database: db,
          prepared,
          resolveAgentId: (current) => current.agentId!,
        }),
      );
      history.push(receipt.receiptId);
      finishCronRunReceipt({
        handle: receipt,
        status: "ok",
        finishedAtMs: now + 101 + index * 2,
      });
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
        CREATE TEMP TRIGGER reject_pending_receipt_completion
        BEFORE UPDATE ON cron_jobs
        WHEN NEW.job_id = '${job.id}'
          AND json_extract(NEW.state_json, '$.runningAtMs') IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'pending receipt completion unavailable');
        END;
      `);
      completion.resolve({ status: "ok" });
      await expect(running).rejects.toThrow("pending receipt completion unavailable");
      database.exec("DROP TRIGGER reject_pending_receipt_completion");
      owner.stop();
      await editor.update(job.id, { agentId: "beta" });

      expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
      // A late settlement still prunes after an owner edit closes its receipt.
      const queries = vi.spyOn(sqliteQuery, "executeSqliteQuerySync");
      let fetchedRows: number;
      try {
        finishCronRunReceipt({ handle: pending!, status: "ok", finishedAtMs: now });
        fetchedRows = queries.mock.results.flatMap((result) =>
          result.type === "return" ? result.value.rows : [],
        ).length;
      } finally {
        queries.mockRestore();
      }
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
      // Read the companion directly so a dangling retirement cannot hide
      // behind its receipt join after ordinary terminal pruning.
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
});
