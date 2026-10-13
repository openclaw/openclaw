import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import {
  createSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { withLeaseWriteTransaction } from "./openclaw-state-lease-storage.js";
import {
  acquireOpenClawStateLeaseInTransaction,
  readOpenClawStateLease,
  releaseOpenClawStateLeaseInTransaction,
} from "./openclaw-state-lease-store.js";
import { executeOpenClawStateLeaseCommand } from "./openclaw-state-lease-worker.js";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => ({
      ...actual.createSubsystemLogger(...args),
      warn,
    }),
  };
});

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["native", "existing", "worker"] as const)(
  "keeps %s lease try-locks quiet without hiding ordinary transaction contention",
  async (kind) => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("lease-diagnostics-") };
    const database = openOpenClawStateDatabase({ env });
    const identity = { scope: "synthetic", key: "release", owner: "owner" };
    runOpenClawStateWriteTransaction(
      ({ db }) => acquireOpenClawStateLeaseInTransaction(db, identity, 30_000),
      { database, env },
    );
    const peer = new DatabaseSync(database.path);
    const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      admission.service();
      return "ok";
    });
    const release = () =>
      kind === "worker"
        ? runWithSqliteWorkerStateContext({ environment: env }, () =>
            withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
              executeOpenClawStateLeaseCommand(
                {
                  type: "stateLease.release",
                  input: {
                    identity,
                    operationLabel: "test.lease.release",
                    databaseIdentity: readDatabasePathIdentitySync(database.path).key,
                  },
                },
                database,
              ),
            ),
          )
        : withLeaseWriteTransaction(
            {
              scope: "shared",
              schemaPolicy: kind === "existing" ? "existing" : undefined,
              options: { env, path: database.path },
            },
            "test.lease.release",
            (db) => releaseOpenClawStateLeaseInTransaction(db, identity),
          );
    try {
      peer.exec("BEGIN IMMEDIATE");
      warn.mockClear();
      expect(release).toThrow(expect.objectContaining({ errcode: 5 }));
      expect(warn).not.toHaveBeenCalled();
      expect(readOpenClawStateLease(database.db, identity)?.owner).toBe(identity.owner);
      expect(() =>
        runOpenClawStateWriteTransaction(() => undefined, { database, env }, { busyTimeoutMs: 0 }),
      ).toThrow(expect.objectContaining({ errcode: 5 }));
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "SQLite transaction lock wait failed",
        expect.objectContaining({ step: "begin", failureKind: "lock-contention" }),
      );
      peer.exec("ROLLBACK");
      release();
      expect(readOpenClawStateLease(database.db, identity)).toBeUndefined();
    } finally {
      admission.finish();
      peer.close();
      await closeOpenClawStateDatabaseAsync();
    }
  },
);

it("still reports commit contention after nonblocking admission succeeds", () => {
  const pathname = path.join(dirs.make("lease-commit-diagnostics-"), "state.sqlite");
  const db = new DatabaseSync(pathname);
  db.exec("PRAGMA busy_timeout=0; CREATE TABLE entries (value TEXT)");
  const peer = new DatabaseSync(pathname);
  try {
    peer.exec("BEGIN");
    peer.prepare("SELECT * FROM entries").all();
    warn.mockClear();
    expect(() =>
      runSqliteImmediateTransactionSync(db, () => db.exec("INSERT INTO entries VALUES ('new')"), {
        beginLockFailureReporting: "suppress",
        busyTimeoutMs: 0,
      }),
    ).toThrow(expect.objectContaining({ errcode: 5 }));
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "SQLite transaction lock wait failed",
      expect.objectContaining({ step: "commit", failureKind: "lock-contention" }),
    );
    peer.exec("ROLLBACK");
    expect(db.prepare("SELECT * FROM entries").all()).toEqual([]);
  } finally {
    peer.close();
    db.close();
  }
});
