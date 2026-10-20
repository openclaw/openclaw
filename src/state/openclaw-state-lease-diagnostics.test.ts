import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import {
  createSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { releaseOpenClawStateLease } from "./openclaw-state-lease-storage.js";
import {
  acquireOpenClawStateLeaseInTransaction,
  readOpenClawStateLease,
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
        : releaseOpenClawStateLease({
            ...identity,
            leaseLabel: "state lease",
            operationLabel: "test.lease.release",
            database: {
              scope: "shared",
              schemaPolicy: kind === "existing" ? "existing" : undefined,
              options: { env, path: database.path },
            },
          });
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
      expect(readOpenClawStateLease(peer, identity)).toBeUndefined();
    } finally {
      admission.finish();
      peer.close();
      await closeOpenClawStateDatabaseAsync();
    }
  },
);

it.each(["released", "admission-refused", "identity-mismatch", "replacement-owner"] as const)(
  "settles worker lease release at its final admission (%s)",
  async (outcome) => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("lease-release-admission-") };
    const database = openOpenClawStateDatabase({ env });
    const db = requireNativeSqliteDatabase(database.db);
    const identity = { scope: "synthetic", key: "release", owner: "original-owner" };
    runOpenClawStateWriteTransaction(
      ({ db: connection }) => acquireOpenClawStateLeaseInTransaction(connection, identity, 30_000),
      { database, env },
    );
    let databaseIdentity = readDatabasePathIdentitySync(database.path).key;
    if (outcome === "identity-mismatch") {
      const otherPath = path.join(dirs.make("lease-other-file-"), "state.sqlite");
      const other = new DatabaseSync(otherPath);
      other.close();
      databaseIdentity = readDatabasePathIdentitySync(otherPath).key;
    }
    const refused = new Error("Lease cleanup owner refused its final grant");
    const admission = createSqliteWorkerOperationAdmission((request, grant) => {
      if (request.stage === "commit") {
        if (outcome === "admission-refused") {
          throw refused;
        }
        if (outcome === "replacement-owner") {
          db.prepare("UPDATE state_leases SET owner = ? WHERE scope = ? AND lease_key = ?").run(
            "replacement-owner",
            identity.scope,
            identity.key,
          );
        }
      }
      grant();
    });
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      admission.service();
      return "ok";
    });
    const deletes = trackSqliteStatementExecutions(db, ["release"], (sql) =>
      /^delete from "state_leases"(?:\s|$)/i.test(sql) ? "release" : null,
    );
    const exec = vi.spyOn(db, "exec");
    const release = () =>
      runWithSqliteWorkerStateContext({ environment: env }, () =>
        withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
          executeOpenClawStateLeaseCommand(
            {
              type: "stateLease.release",
              input: { identity, operationLabel: "test.lease.release", databaseIdentity },
            },
            database,
          ),
        ),
      );
    try {
      if (outcome === "admission-refused") {
        expect(release).toThrow("SQLite transaction admission was refused");
        expect(admission.failure).toBe(refused);
      } else if (outcome === "identity-mismatch") {
        expect(release).toThrow("SQLite database file identity changed before existing-only open");
      } else {
        release();
      }
      expect(deletes.counts.release).toBe(
        outcome === "admission-refused" || outcome === "identity-mismatch" ? 0 : 1,
      );
      expect(
        exec.mock.calls.filter(([sql]) =>
          /^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql),
        ),
      ).toEqual([]);
      expect(readOpenClawStateLease(db, identity)?.owner).toBe(
        outcome === "released"
          ? undefined
          : outcome === "replacement-owner"
            ? "replacement-owner"
            : identity.owner,
      );
    } finally {
      deletes.restore();
      admission.finish();
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
