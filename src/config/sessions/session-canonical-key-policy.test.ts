import path from "node:path";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as databaseAdmissions from "../../infra/sqlite-database-admission.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { admitSqliteSchema, runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { ensureSessionKeyContractSchemaInTransaction } from "../../state/openclaw-agent-db-schema-helpers.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../state/openclaw-agent-schema.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  readCanonicalSessionMainKey,
  readStoredCanonicalSessionMainKey,
  setCanonicalSqliteSessionMainKey,
} from "./session-canonical-key.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const databases: DatabaseSync[] = [];
const observations: ReturnType<typeof observeSqliteReadSql>[] = [];
afterEach(() => {
  observations.splice(0).forEach((observation) => observation.restore());
  for (const db of databases.splice(0)) {
    db.close();
  }
});

function observeReads() {
  const observation = observeSqliteReadSql(StatementSync.prototype);
  observations.push(observation);
  return observation;
}

function connect(filename: string, readOnly = false) {
  const db = openNodeSqliteDatabase(filename, { readOnly });
  databases.push(db);
  return db;
}

function diskPath() {
  return path.join(tempDirs.make("canonical-policy-"), "agent.sqlite");
}

function fixture(filename = ":memory:", canonicalAdmission = true) {
  const db = connect(filename);
  db.exec(`BEGIN; ${OPENCLAW_AGENT_SCHEMA_SQL} COMMIT;`);
  admitSqliteSchema(db);
  const database = { db, agentId: "main" };
  // Maintenance admission has no physical runtime receipt; it uses the same policy owner.
  if (canonicalAdmission) {
    assertCanonicalSqliteSessionKeysCurrent(database);
  }
  const read = () => runSqliteReadOperationSync(db, () => readCanonicalSessionMainKey(database));
  expect(read()).toBe("main");
  const observe = (admit = false) => {
    const values: string[] = [];
    db.function("read_policy", () => {
      if (admit) {
        admitSqliteSchema(db);
      }
      values.push(read());
      return 0;
    });
    return values;
  };
  return { db, database, read, observe };
}

it.each([true, false])(
  "reuses policy with canonical admission %s and observes writes",
  (admitted) => {
    const { db, database, read } = fixture(":memory:", admitted);
    const observation = observeReads();
    expect(Array.from({ length: 10 }, read)).toEqual(Array(10).fill("main"));
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
    expect(readStoredCanonicalSessionMainKey(database)).toBeNull();
    setCanonicalSqliteSessionMainKey(database, undefined);
    expect(readStoredCanonicalSessionMainKey(database)).toBe("main");
    db.prepare(
      "REPLACE INTO session_key_contract (id, main_key, updated_at) VALUES (1, 'replacement', 1)",
    ).run();
    expect(read()).toBe("replacement");
  },
);

it("keeps current policy inside read transactions and refreshes after savepoint rollback", () => {
  const { db, read } = fixture();
  const observation = observeReads();
  runSqliteReadOperationSync(db, () => {
    for (let transaction = 0; transaction < 3; transaction += 1) {
      runSqliteDeferredTransactionSync(db, () => {
        expect(Array.from({ length: 10 }, read)).toEqual(Array(10).fill("main"));
      });
    }
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
  const { db, read, observe } = fixture();
  const observed = observe();
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

it("shares the physical policy across handles and unrelated writes without rereading it", () => {
  const filename = diskPath();
  const { db, database, read } = fixture(filename);
  const peer = connect(filename, true);
  admitSqliteSchema(peer);
  const observation = observeReads();
  expect(readCanonicalSessionMainKey({ db: peer })).toBe("main");
  db.exec("UPDATE session_nodes SET updated_at = updated_at + 1");
  expect(read()).toBe("main");
  setCanonicalSqliteSessionMainKey(database, "configured");
  expect(read()).toBe("configured");
  expect(readCanonicalSessionMainKey({ db: peer })).toBe("configured");
  db.exec("CREATE TABLE unrelated_policy_data (value TEXT)");
  admitSqliteSchema(db);
  expect(read()).toBe("configured");
  expect(readCanonicalSessionMainKey({ db: peer })).toBe("configured");
  expect(observation.queries.filter((sql) => sql.includes('from "session_key_contract"'))).toEqual(
    [],
  );
  db.exec("BEGIN");
  try {
    expect(() => setCanonicalSqliteSessionMainKey(database, "unmanaged")).toThrow(
      "Canonical main-key changes require managed transaction publication",
    );
  } finally {
    db.exec("ROLLBACK");
  }
  expect(read()).toBe("configured");
});

it("observes the schema owner's seed after reading a missing policy row", () => {
  const filename = diskPath();
  const db = connect(filename);
  db.exec(`BEGIN; ${OPENCLAW_AGENT_SCHEMA_SQL}
      DELETE FROM session_key_contract; COMMIT;`);
  admitSqliteSchema(db);
  const reader = connect(filename, true);
  admitSqliteSchema(reader);
  expect(readStoredCanonicalSessionMainKey({ db })).toBeNull();
  expect(readStoredCanonicalSessionMainKey({ db: reader })).toBeNull();
  withSqlitePostCommitPublications(db, () =>
    runSqliteDeferredTransactionSync(db, () => ensureSessionKeyContractSchemaInTransaction(db)),
  );
  expect(readStoredCanonicalSessionMainKey({ db: reader })).toBe("main");
  expect(readCanonicalSessionMainKey({ db })).toBe("main");
});

it.each(["tracked", "native", "native-before-begin"] as const)(
  "discards uncommitted policy after %s implicit rollback",
  (mode) => {
    const { db, database, read } = fixture();
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE policy_abort (value);
      CREATE TRIGGER abort_policy BEFORE INSERT ON policy_abort
      BEGIN SELECT RAISE(ROLLBACK, 'policy rollback'); END;`);
    admitSqliteSchema(db);
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
      setCanonicalSqliteSessionMainKey(database, "committed-after-rollback");
      db.exec("BEGIN");
      try {
        expect(read()).toBe("committed-after-rollback");
      } finally {
        db.exec("COMMIT");
      }
    });
  },
);

it.each(["autocommit", "managed"] as const)(
  "retires stale policy when %s committed fact installation fails",
  (mode) => {
    const { db, database, read } = fixture(diskPath());
    setCanonicalSqliteSessionMainKey(database, "previous");
    const publish = databaseAdmissions.publishSqliteDatabaseAdmission;
    let injected = false;
    const publication = vi
      .spyOn(databaseAdmissions, "publishSqliteDatabaseAdmission")
      .mockImplementation((...args) => {
        if (!injected && args[1].name === "canonical-session-main-key-write") {
          injected = true;
          throw new Error("publication failed");
        }
        return publish(...args);
      });
    const write = () => setCanonicalSqliteSessionMainKey(database, "committed");
    try {
      if (mode === "managed") {
        expect(() =>
          withSqlitePostCommitPublications(db, () => runSqliteDeferredTransactionSync(db, write)),
        ).not.toThrow();
      } else {
        expect(write).toThrow("publication failed");
      }
    } finally {
      publication.mockRestore();
    }
    expect(injected).toBe(true);
    expect(db.prepare("SELECT main_key FROM session_key_contract WHERE id = 1").get()).toEqual({
      main_key: "committed",
    });
    expect(read()).toBe("committed");
  },
);

it.each([
  [
    false,
    "changed",
    `BEGIN; SELECT read_policy(); COMMIT;
        UPDATE session_key_contract SET main_key = 'changed';
        BEGIN; SELECT read_policy(); COMMIT;`,
  ],
  [
    true,
    "replacement",
    `SELECT read_policy(); DROP TABLE session_key_contract;
      CREATE TABLE session_key_contract AS SELECT 1 AS id, 'replacement' AS main_key;
      SELECT read_policy();`,
  ],
] as const)("observes native batch %s policy changes to %s", (admit, expected, sql) => {
  const { db, read, observe } = fixture();
  const observed = observe(admit);
  if (admit) {
    db.exec(sql);
  } else {
    runSqliteReadOperationSync(db, () => db.exec(sql));
  }
  expect(observed).toEqual(["main", expected]);
  expect(read()).toBe(expected);
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
