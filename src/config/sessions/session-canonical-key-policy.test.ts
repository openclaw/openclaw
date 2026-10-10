import path from "node:path";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { runSqlitePinnedReadSnapshotSync } from "../../infra/sqlite-pinned-read-snapshot.js";
import {
  admitSqliteSchema,
  readSqliteDataVersion,
  runSqliteReadOperationSync,
} from "../../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../state/openclaw-agent-schema.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  readCanonicalSessionMainKey,
  setCanonicalSqliteSessionMainKey,
} from "./session-canonical-key.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close();
  }
});

function fixture(filename = ":memory:", canonicalAdmission = true) {
  const db = openNodeSqliteDatabase(filename);
  databases.push(db);
  db.exec(`BEGIN; ${OPENCLAW_AGENT_SCHEMA_SQL} COMMIT;`);
  admitSqliteSchema(db);
  const database = { db, agentId: "main" };
  // Maintenance admission has no physical runtime receipt; it uses the same policy owner.
  if (canonicalAdmission) {
    assertCanonicalSqliteSessionKeysCurrent(database);
  }
  const read = () => runSqliteReadOperationSync(db, () => readCanonicalSessionMainKey(database));
  expect(read()).toBe("main");
  return { db, database, read };
}

describe("canonical main-key policy facts", () => {
  it.each([true, false])(
    "reuses policy with canonical admission %s and observes writes",
    (admitted) => {
      const { db, database, read } = fixture(":memory:", admitted);
      const observation = observeSqliteReadSql(StatementSync.prototype);
      try {
        for (let index = 0; index < 10; index += 1) {
          expect(read()).toBe("main");
        }
        expect(
          observation.queries.filter((sql) => sql.includes('from "session_key_contract"')),
        ).toEqual([]);
        setCanonicalSqliteSessionMainKey(database, "custom");
        expect(read()).toBe("custom");
        db.exec(
          "WITH policy(value) AS (VALUES ('raw')) UPDATE session_key_contract SET main_key = (SELECT value FROM policy) WHERE id = 1",
        );
        expect(read()).toBe("raw");
        db.prepare("DELETE FROM session_key_contract WHERE id = 1").run();
        expect(read()).toBe("main");
        db.prepare(
          "REPLACE INTO session_key_contract (id, main_key, updated_at) VALUES (1, 'replacement', 1)",
        ).run();
        expect(read()).toBe("replacement");
      } finally {
        observation.restore();
      }
    },
  );

  it("reuses current policy across read transactions and refreshes after savepoint rollback", () => {
    const { db, read } = fixture();
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      runSqliteReadOperationSync(db, () => {
        for (let transaction = 0; transaction < 3; transaction += 1) {
          runSqliteDeferredTransactionSync(db, () => {
            for (let index = 0; index < 10; index += 1) {
              expect(read()).toBe("main");
            }
          });
        }
        expect(
          observation.queries.filter((sql) => sql.includes('from "session_key_contract"')),
        ).toHaveLength(0);
      });
      runSqliteDeferredTransactionSync(db, () => {
        const isVersionProbe = (sql: string) =>
          /^PRAGMA data_version$|FROM main\.pragma_data_version\(\)\s*$/iu.test(sql);
        const probes = observation.queries.filter(isVersionProbe).length;
        db.exec("SAVEPOINT policy_change");
        db.exec("UPDATE session_key_contract SET main_key = 'temporary'");
        expect(read()).toBe("temporary");
        db.exec("ROLLBACK TO SAVEPOINT policy_change");
        expect(read()).toBe("main");
        db.exec("RELEASE SAVEPOINT policy_change");
        expect(read()).toBe("main");
        expect(observation.queries.filter(isVersionProbe)).toHaveLength(probes);
      });
      expect(read()).toBe("main");
    } finally {
      observation.restore();
    }
  });

  it.each(["run", "get", "all", "iterate"] as const)(
    "observes prepared %s writes and indirect trigger changes",
    (method) => {
      const { db, read } = fixture();
      db.exec(`CREATE TABLE policy_input (value TEXT);
        CREATE TRIGGER change_policy AFTER INSERT ON policy_input
        BEGIN UPDATE session_key_contract SET main_key = NEW.value WHERE id = 1; END;`);
      admitSqliteSchema(db);
      const write = db.prepare("INSERT INTO policy_input VALUES (?) RETURNING value");
      expect(read()).toBe("main");
      if (method === "iterate") {
        const rows = write.iterate("changed");
        try {
          expect(rows.next().done).toBe(false);
          expect(read()).toBe("changed");
          db.exec("UPDATE session_key_contract SET main_key = 'during-returning' WHERE id = 1");
          expect(read()).toBe("during-returning");
        } finally {
          rows.return?.();
        }
        expect(read()).toBe("during-returning");
      } else {
        write[method]("changed");
        expect(read()).toBe("changed");
      }
    },
  );

  it("does not reuse policy facts during native callbacks or after failed batches and rollback", () => {
    const { db, read } = fixture();
    const observed: string[] = [];
    db.function("read_policy", () => {
      observed.push(read());
      return 0;
    });
    db.exec(`UPDATE session_key_contract SET main_key = 'first'; SELECT read_policy();
      UPDATE session_key_contract SET main_key = 'second'; SELECT read_policy();`);
    expect(observed).toEqual(["first", "second"]);
    expect(() =>
      db.exec(
        "SELECT 1; UPDATE session_key_contract SET main_key = 'partial'; SELECT * FROM missing",
      ),
    ).toThrow();
    expect(read()).toBe("partial");
    db.exec("BEGIN; UPDATE session_key_contract SET main_key = 'rolled-back'");
    expect(read()).toBe("rolled-back");
    db.exec("ROLLBACK");
    expect(read()).toBe("partial");
  });

  it.each(["pinned", "transaction"] as const)(
    "observes foreign commits after %s snapshots",
    (kind) => {
      const filename = path.join(tempDirs.make("canonical-policy-"), "agent.sqlite");
      const { db, read } = fixture(filename);
      db.exec("PRAGMA journal_mode=WAL");
      const peer = new DatabaseSync(filename);
      databases.push(peer);
      peer.exec("UPDATE session_key_contract SET main_key = 'foreign'");
      expect(read()).toBe("foreign");
      const runSnapshot =
        kind === "pinned" ? runSqlitePinnedReadSnapshotSync : runSqliteDeferredTransactionSync;
      runSnapshot(db, () => {
        expect(read()).toBe("foreign");
        peer.exec("UPDATE session_key_contract SET main_key = 'later'");
        expect(read()).toBe("foreign");
      });
      expect(read()).toBe("later");
      runSqliteReadOperationSync(db, () => {
        expect(read()).toBe("later");
        const before = readSqliteDataVersion(db);
        peer.exec("UPDATE session_key_contract SET main_key = 'fresh'");
        expect(readSqliteDataVersion(db)).not.toBe(before);
        expect(read()).toBe("fresh");
      });
    },
  );

  it("refreshes after native BEGIN and pins facts before subsequent foreign commits", () => {
    const filename = path.join(tempDirs.make("canonical-policy-pin-"), "agent.sqlite");
    const { db, read } = fixture(filename);
    db.exec("PRAGMA journal_mode=WAL");
    const peer = new DatabaseSync(filename);
    databases.push(peer);
    runSqliteReadOperationSync(db, () => {
      expect(read()).toBe("main");
      db.exec("BEGIN");
      try {
        peer.exec("UPDATE session_key_contract SET main_key = 'before-probe'");
        runSqliteReadOperationSync(db, () => {
          peer.exec("UPDATE session_key_contract SET main_key = 'after-probe'");
          expect(read()).toBe("before-probe");
        });
      } finally {
        db.exec("COMMIT");
      }
      expect(read()).toBe("after-probe");
      peer.exec("UPDATE session_key_contract SET main_key = 'next-transaction'");
      runSqliteDeferredTransactionSync(db, () => {
        expect(read()).toBe("next-transaction");
      });
    });
  });

  it.each(["tracked", "native", "native-before-begin"] as const)(
    "discards uncommitted policy after %s implicit rollback",
    (mode) => {
      const filename = path.join(tempDirs.make("canonical-policy-rollback-"), "agent.sqlite");
      const { db, read } = fixture(filename);
      db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE policy_abort (value);
      CREATE TRIGGER abort_policy BEFORE INSERT ON policy_abort
      BEGIN SELECT RAISE(ROLLBACK, 'policy rollback'); END;`);
      admitSqliteSchema(db);
      const peer = new DatabaseSync(filename);
      databases.push(peer);
      runSqliteReadOperationSync(db, () => {
        db.exec("BEGIN");
        db.exec("UPDATE session_key_contract SET main_key = 'uncommitted'");
        expect(read()).toBe("uncommitted");
        const abort = db.prepare("INSERT INTO policy_abort VALUES (1)");
        // Direct native stepping models transaction loss outside the tracked mutation wrapper.
        expect(() =>
          mode === "tracked" ? abort.run() : StatementSync.prototype.run.call(abort, {}),
        ).toThrow("policy rollback");
        expect(db.isTransaction).toBe(false);
        if (mode === "native-before-begin") {
          db.exec("BEGIN");
        }
        expect(read()).toBe("main");
        if (db.isTransaction) {
          db.exec("COMMIT");
        }
        peer.exec("UPDATE session_key_contract SET main_key = 'foreign-after-rollback'");
        db.exec("BEGIN");
        try {
          expect(read()).toBe("foreign-after-rollback");
        } finally {
          db.exec("COMMIT");
        }
      });
    },
  );

  it("does not carry a policy value across transaction controls inside a native batch", () => {
    const filename = path.join(tempDirs.make("canonical-policy-batch-"), "agent.sqlite");
    const { db, read } = fixture(filename);
    db.exec("PRAGMA journal_mode=WAL");
    const peer = new DatabaseSync(filename);
    databases.push(peer);
    const observed: string[] = [];
    db.function("read_policy", () => {
      observed.push(read());
      return 0;
    });
    db.function("foreign_commit", () => {
      peer.exec("UPDATE session_key_contract SET main_key = 'foreign'");
      return 0;
    });
    runSqliteReadOperationSync(db, () => {
      db.exec(`BEGIN; SELECT read_policy(); COMMIT;
        SELECT foreign_commit(); BEGIN; SELECT read_policy(); COMMIT;`);
    });
    expect(observed).toEqual(["main", "foreign"]);
    expect(read()).toBe("foreign");
  });

  it("observes schema replacement when native callbacks re-admit intermediate facts", () => {
    const { db, read } = fixture();
    const observed: string[] = [];
    db.function("read_policy", () => {
      admitSqliteSchema(db);
      observed.push(read());
      return 0;
    });
    db.exec(`SELECT read_policy(); DROP TABLE session_key_contract;
      CREATE TABLE session_key_contract AS SELECT 1 AS id, 'replacement' AS main_key;
      SELECT read_policy();`);
    expect(observed).toEqual(["main", "replacement"]);
    expect(read()).toBe("replacement");
  });

  it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function")(
    "does not bypass an authorizer with a retained policy value",
    () => {
      const { db, read } = fixture();
      db.setAuthorizer((action, table) =>
        action === constants.SQLITE_READ && table === "session_key_contract"
          ? constants.SQLITE_DENY
          : constants.SQLITE_OK,
      );
      try {
        expect(read).toThrow(/prohibited|authorized/iu);
      } finally {
        db.setAuthorizer(null);
      }
      expect(read()).toBe("main");
    },
  );
});
