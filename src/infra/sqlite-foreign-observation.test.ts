import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import {
  createSqliteForeignObservation,
  runSqliteForeignUse,
} from "./sqlite-foreign-observation.js";
import { runSqlitePinnedReadSnapshotSync } from "./sqlite-pinned-read-snapshot.js";

const schema = `CREATE TABLE observation_facts (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
  INSERT INTO observation_facts VALUES ('guard', 1), ('own', 0);`;
const databases: DatabaseSync[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    for (const database of databases.splice(0)) {
      if (database.isOpen) {
        database.close();
      }
    }
    cleanup();
  }),
);

function openDatabase(location: string) {
  const database = openNodeSqliteDatabase(location);
  databases.push(database);
  return database;
}

function fixture() {
  const pathname = path.join(tempDirs.make("sqlite-foreign-observation-"), "facts.sqlite");
  const database = openDatabase(pathname);
  database.exec(schema);
  const foreign = openDatabase(pathname);
  const observation = createSqliteForeignObservation(database, () => {});
  const certification = observation.createCertification();
  expect(certification.beginRefresh().accept()).toBe(true);
  return { database, foreign, observation, certification };
}

describe("SQLite foreign observation", () => {
  it("shares one probe across domain guards and probes each physical database independently", () => {
    const first = fixture();
    const second = fixture();
    const sibling = first.observation.createCertification();
    expect(sibling.beginRefresh().accept()).toBe(true);
    const sql = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    try {
      runSqliteForeignUse((use) => {
        expect(first.certification.isCurrent(use)).toBe(true);
        expect(sibling.isCurrent(use)).toBe(true);
        expect(first.certification.isCurrent(use)).toBe(true);
        runSqliteForeignUse((nested) => expect(sibling.isCurrent(nested)).toBe(true));
      });
      expect(sql.queries).toHaveLength(1);
      sql.queries.length = 0;
      first.foreign.prepare("UPDATE observation_facts SET value = 0 WHERE key = 'guard'").run();
      runSqliteForeignUse((use) => {
        expect(first.certification.isCurrent(use)).toBe(false);
        expect(sibling.isCurrent(use)).toBe(false);
        expect(second.certification.isCurrent(use)).toBe(true);
      });
      expect(sql.queries).toHaveLength(2);
    } finally {
      sql.restore();
    }
  });

  it("expires a use frame before a later await continuation or refresh acceptance", async () => {
    const { certification } = fixture();
    const refresh = certification.beginRefresh();
    const retained = runSqliteForeignUse((use) => use);
    await Promise.resolve();
    expect(() => refresh.accept(retained)).toThrow("use has ended");
    expect(() => certification.isCurrent(retained)).toThrow("use has ended");
    expect(() => runSqliteForeignUse(async () => {})).toThrow("must remain synchronous");
    expect(certification.beginRefresh().accept()).toBe(true);
  });

  it("refuses use while refreshing without superseding an unchanged pending refresh", () => {
    const { certification } = fixture();
    const pending = certification.beginRefresh();
    expect(runSqliteForeignUse((use) => certification.isCurrent(use))).toBe(false);
    expect(pending.accept()).toBe(true);
    expect(runSqliteForeignUse((use) => certification.isCurrent(use))).toBe(true);
  });

  it.each(["exec", "prepared", "schema", "unknown"] as const)(
    "rejects a retained frame and its certification after %s invalidation",
    (kind) => {
      const { database, observation, certification } = fixture();
      runSqliteForeignUse((use) => {
        expect(certification.isCurrent(use)).toBe(true);
        if (kind === "exec") {
          database.exec("UPDATE observation_facts SET value = 0 WHERE key = 'guard'");
        } else if (kind === "prepared") {
          database
            .prepare("UPDATE observation_facts SET value = 0 WHERE key = 'guard' RETURNING value")
            .get();
        } else if (kind === "schema") {
          database.exec("ALTER TABLE observation_facts ADD COLUMN note TEXT");
        } else {
          observation.invalidate();
        }
        expect(() => certification.isCurrent(use)).toThrow("changed during use");
      });
      expect(runSqliteForeignUse((use) => certification.isCurrent(use))).toBe(false);
      expect(certification.beginRefresh().accept()).toBe(true);
    },
  );

  it.each(["transaction", "pinned", "closed"] as const)(
    "refuses the %s observation handle even within an already-probed frame",
    (kind) => {
      const { database, certification } = fixture();
      runSqliteForeignUse((use) => {
        expect(certification.isCurrent(use)).toBe(true);
        if (kind === "pinned") {
          runSqlitePinnedReadSnapshotSync(database, () => {
            expect(() => certification.isCurrent(use)).toThrow("requires an unpinned handle");
          });
        } else if (kind === "transaction") {
          database.exec("BEGIN");
          try {
            expect(() => certification.isCurrent(use)).toThrow("requires an unpinned handle");
          } finally {
            database.exec("ROLLBACK");
          }
        } else {
          database.close();
          expect(() => certification.isCurrent(use)).toThrow("owner is closed");
        }
      });
      if (kind !== "closed") {
        expect(runSqliteForeignUse((use) => certification.isCurrent(use))).toBe(false);
      }
    },
  );

  it("revalidates domain custody after a shared observer was already checked", () => {
    const { observation, certification } = fixture();
    let retired = false;
    const borrower = observation.createCertification(() => {
      if (retired) {
        throw new Error("borrower retired");
      }
    });
    expect(borrower.beginRefresh().accept()).toBe(true);
    runSqliteForeignUse((use) => {
      expect(certification.isCurrent(use)).toBe(true);
      expect(borrower.isCurrent(use)).toBe(true);
      retired = true;
      expect(() => borrower.isCurrent(use)).toThrow("borrower retired");
      expect(certification.isCurrent(use)).toBe(true);
    });
  });
});
