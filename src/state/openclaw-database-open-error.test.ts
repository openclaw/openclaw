import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as transactions from "../infra/sqlite-transaction.js";
import {
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const roots = createTempDirTracker();
const observed = new Set<DatabaseSync>();
const runTransaction = transactions.runSqliteImmediateTransactionSync;

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const db of observed) {
    if (db.isOpen) {
      db.close();
    }
  }
  observed.clear();
  roots.cleanup();
});

it.each(["state", "agent"] as const)(
  "preserves the primary failure through %s schema restoration and physical-open cleanup",
  (kind) => {
    const env = { OPENCLAW_STATE_DIR: roots.make("database-open-primary-error-") };
    const options = { agentId: "primary-error", env };
    const pathname =
      kind === "state"
        ? resolveOpenClawStateSqlitePath(env)
        : resolveOpenClawAgentSqlitePath(options);
    const primary = new Error("synthetic schema transaction lost its transaction");
    let intercepted = 0;
    const transaction = vi
      .spyOn(transactions, "runSqliteImmediateTransactionSync")
      .mockImplementation((db, operation, transactionOptions) => {
        if (db.location() !== pathname) {
          return runTransaction(db, operation, transactionOptions);
        }
        intercepted += 1;
        observed.add(db);
        return runTransaction(
          db,
          () => {
            expect(db.isTransaction).toBe(true);
            db.exec("ROLLBACK");
            throw primary;
          },
          transactionOptions,
        );
      });
    const open = () =>
      kind === "state" ? openOpenClawStateDatabase({ env }) : openOpenClawAgentDatabase(options);
    try {
      let failure: unknown;
      try {
        open();
      } catch (error) {
        failure = error;
      }
      expect(intercepted).toBe(1);
      expect(observed.size).toBe(1);
      const [failedDb] = observed;
      assert(failedDb);
      expect(failedDb.isOpen).toBe(false);
      expect(failure).toBe(primary);
      if (kind === "agent") {
        expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
      }
      transaction.mockRestore();
      const fresh = open();
      expect(fresh.db === failedDb).toBe(false);
      expect(fresh.db.isOpen).toBe(true);
    } finally {
      transaction.mockRestore();
    }
  },
);
