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
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const roots = createTempDirTracker();
const observed: DatabaseSync[] = [];
const runTransaction = transactions.runSqliteImmediateTransactionSync;

function failTransaction(pathname: string, primary: Error) {
  return vi
    .spyOn(transactions, "runSqliteImmediateTransactionSync")
    .mockImplementation((db, operation, options) => {
      if (db.location() !== pathname) {
        return runTransaction(db, operation, options);
      }
      observed.push(db);
      const loseTransaction = () => {
        expect(db.isTransaction).toBe(true);
        db.exec("ROLLBACK");
        throw primary;
      };
      return runTransaction(db, loseTransaction, options);
    });
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const db of observed.splice(0)) {
    if (db.isOpen) {
      db.close();
    }
  }
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
    const transaction = failTransaction(pathname, primary);
    const open = () =>
      kind === "state" ? openOpenClawStateDatabase({ env }) : openOpenClawAgentDatabase(options);
    let failure: unknown;
    try {
      open();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBe(primary);
    expect(observed).toHaveLength(1);
    const [failedDb] = observed;
    expect(failedDb).toMatchObject({ isOpen: false });
    if (kind === "agent") {
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
    }
    transaction.mockRestore();
    const fresh = open();
    expect(fresh.db === failedDb).toBe(false);
    expect(fresh.db.isOpen).toBe(true);
  },
);

it("returns doctor repair warnings when rollback cleanup already closed the state database", () => {
  const env = { OPENCLAW_STATE_DIR: roots.make("state-repair-rollback-cleanup-") };
  const pathname = resolveOpenClawStateSqlitePath(env);
  openOpenClawStateDatabase({ env });
  closeOpenClawStateDatabaseForTest();
  const primary = new Error("synthetic repair transaction lost its transaction");
  failTransaction(pathname, primary);
  const result = repairOpenClawStateDatabaseSchema({ env });
  expect(observed).toHaveLength(1);
  expect(result.changes).toEqual([]);
  expect(result.warnings).toEqual([expect.stringContaining(primary.message)]);
  expect(result.warnings[0]).toContain("Failed migrating shared state database schema");
  const [failedDb] = observed;
  expect(failedDb).toMatchObject({ isOpen: false });
});
