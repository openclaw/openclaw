import { DatabaseSync, StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import * as stateRead from "../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import { releaseLocalCronRunReceiptOwnership } from "../store/run-receipt-store.js";
import { makeCronRecoveryJob as makeJob } from "../store/run-receipt-store.test-support.js";
import type { CronRunRecoveryProposal } from "../store/run-recovery-read.types.js";
import { start, stop } from "./ops-lifecycle.js";
import { recoverCronRunProposals } from "./run-recovery.js";
import {
  claimCronRecoveryReceipt as claimReceipt,
  makeCronRecoveryState as makeState,
} from "./run-recovery.test-support.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-recovery-observation-" });

describe("cron recovery observations", () => {
  it("observes a cold receipt and its running association off the host", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.now();
    const job = makeJob("proposal-placement", startedAtMs);
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const receipt = claimReceipt(storePath, job, startedAtMs);
    job.state.runningReceiptId = receipt.receiptId;
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    await closeOpenClawStateDatabaseAsync();
    const sqlite = requireNodeSqlite();
    const originalDatabase = sqlite.DatabaseSync;
    const construct = vi.fn();
    Reflect.set(
      sqlite,
      "DatabaseSync",
      new Proxy(originalDatabase, {
        construct(target, args, newTarget) {
          construct();
          return Reflect.construct(target, args, newTarget);
        },
      }),
    );
    const spies = {
      construct,
      prepare: vi.spyOn(DatabaseSync.prototype, "prepare"),
      exec: vi.spyOn(DatabaseSync.prototype, "exec"),
      close: vi.spyOn(DatabaseSync.prototype, "close"),
      get: vi.spyOn(StatementSync.prototype, "get"),
      all: vi.spyOn(StatementSync.prototype, "all"),
      run: vi.spyOn(StatementSync.prototype, "run"),
      iterate: vi.spyOn(StatementSync.prototype, "iterate"),
    };
    try {
      // Calibrate the constructor observer before the cold canonical database read.
      new sqlite.DatabaseSync(":memory:").close();
      expect(construct).toHaveBeenCalledOnce();
      for (const spy of Object.values(spies)) {
        spy.mockClear();
      }
      const state = makeState(logger, storePath, startedAtMs);
      let proposal: CronRunRecoveryProposal | undefined;
      await recoverCronRunProposals(state, [{ jobId: job.id, runningAtMs: startedAtMs }], {
        onRecovery(observed, result) {
          proposal = observed;
          expect(result).toEqual({ kind: "live", receipt });
        },
      });
      expect(proposal).toEqual({
        jobId: job.id,
        runningAtMs: startedAtMs,
        runningReceiptId: receipt.receiptId,
        receipt,
      });
      expect(
        Object.fromEntries(Object.entries(spies).map(([key, spy]) => [key, spy.mock.calls.length])),
      ).toEqual({
        construct: 0,
        prepare: 0,
        exec: 0,
        close: 0,
        get: 0,
        all: 0,
        run: 0,
        iterate: 0,
      });
    } finally {
      Reflect.set(sqlite, "DatabaseSync", originalDatabase);
      for (const spy of Object.values(spies)) {
        spy.mockRestore();
      }
      releaseLocalCronRunReceiptOwnership(receipt);
    }
  });

  it("initializes missing receipt storage before repairing an interrupted legacy marker", async () => {
    const { storePath } = await makeStorePath();
    const nowMs = Date.now();
    const job = makeJob("missing-receipt-storage", nowMs - 1_000);
    job.enabled = false;
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const database = openOpenClawStateDatabase().db;
    database.exec("DROP TABLE cron_run_receipts");
    const observed: string[] = [];
    const read = stateRead.executeExistingOpenClawStateRead;
    const capture = vi
      .spyOn(stateRead, "executeExistingOpenClawStateRead")
      .mockImplementation(async (...args) => {
        const result = await read(...args);
        if (result?.ok && result.type === "cron.observeRunRecovery") {
          observed.push(result.observation.kind);
          if (result.observation.kind === "schema-uninitialized") {
            expect(
              database
                .prepare("SELECT name FROM sqlite_schema WHERE name = 'cron_run_receipts'")
                .get(),
            ).toBeUndefined();
          }
        }
        return result;
      });
    const state = makeState(logger, storePath, nowMs);
    try {
      await start(state);
      expect(observed).toEqual(["schema-uninitialized", "observed"]);
      expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject({
        lastRunStatus: "error",
      });
      expect((await loadCronStore(storePath)).jobs[0]?.state.runningAtMs).toBeUndefined();
      expect(
        database.prepare("SELECT name FROM sqlite_schema WHERE name = 'cron_run_receipts'").get(),
      ).toEqual({ name: "cron_run_receipts" });
    } finally {
      capture.mockRestore();
      stop(state);
    }
  });
});
