import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { readSqliteDatabaseIntegrityVerification } from "./sqlite-database-admission.js";
import {
  assertSqliteTableIntegrity,
  runSqliteIntegrityOperationSync,
  sqliteIntegrityCheckSteps,
} from "./sqlite-integrity.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function withCapture(
  run: (
    sourcePath: string,
    capture: (check?: "quick" | "full") => Promise<unknown>,
  ) => Promise<void>,
) {
  const directory = fs.realpathSync(directories.make("sqlite-maintenance-integrity-"));
  const sourcePath = path.join(directory, "source.sqlite");
  {
    using source = openNodeSqliteDatabase(sourcePath);
    source.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE touched(value INTEGER CHECK(value > 0));
      CREATE TABLE untouched(value INTEGER CHECK(value > 0));
      INSERT INTO touched VALUES(1);
      INSERT INTO untouched VALUES(1);
    `);
  }
  // Doctor's header preflight leaves an empty WAL behind after a read-only open.
  {
    using source = openNodeSqliteDatabase(sourcePath, { readOnly: true });
    source.prepare("PRAGMA user_version").get();
  }
  const scope = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent() {},
  });
  try {
    await scope.run(() =>
      run(sourcePath, (check = "quick") =>
        createVerifiedSqliteSnapshot({
          sourcePath,
          targetPath: path.join(directory, "backup.sqlite"),
          preserveRowIds: true,
          integrity: { check, tables: ["touched"] },
          transform() {},
        }),
      ),
    );
  } finally {
    await scope.close();
  }
}

it.each(["quick", "full"] as const)(
  "reuses only the captured QUICK source proof before migration (%s)",
  async (check) => {
    await withCapture(async (sourcePath, capture) => {
      await capture(check);
      using source = openNodeSqliteDatabase(sourcePath);
      const prepare = vi.spyOn(source, "prepare");
      runSqliteIntegrityOperationSync(
        sqliteIntegrityCheckSteps(source, sourcePath, undefined, { check, tables: ["touched"] }),
      );
      const checks = prepare.mock.calls.filter(([sql]) =>
        /^PRAGMA (quick|integrity)_check;/.test(sql),
      );
      expect(checks).toHaveLength(check === "quick" ? 0 : 1);
      expect(readSqliteDatabaseIntegrityVerification(source) !== undefined).toBe(check === "full");
    });
  },
);

it("refuses untouched-table corruption before publishing a migration backup", async () => {
  await withCapture(async (sourcePath, capture) => {
    let offset: number;
    {
      using source = openNodeSqliteDatabase(sourcePath);
      const root = source
        .prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'untouched'")
        .get();
      const page = source.prepare("PRAGMA page_size").get();
      offset = (Number(root?.rootpage) - 1) * Number(page?.page_size);
    }
    const file = fs.openSync(sourcePath, "r+");
    try {
      fs.writeSync(file, Buffer.from([0xff]), 0, 1, offset);
    } finally {
      fs.closeSync(file);
    }
    await expect(capture()).rejects.toThrow(/malformed|quick_check/);
  });
});

it.each([false, true])(
  "invalidates captured proof after an unscoped write (uncommitted=%s)",
  async (uncommitted) => {
    await withCapture(async (sourcePath, capture) => {
      await capture();
      using source = openNodeSqliteDatabase(sourcePath);
      source.exec(
        `PRAGMA ignore_check_constraints = ON; ${uncommitted ? "BEGIN;" : ""} INSERT INTO untouched VALUES(-1); PRAGMA ignore_check_constraints = OFF;`,
      );
      try {
        expect(() =>
          runSqliteIntegrityOperationSync(
            sqliteIntegrityCheckSteps(source, sourcePath, undefined, {
              check: "quick",
              tables: ["touched"],
            }),
          ),
        ).toThrow(/quick_check.*CHECK constraint failed in untouched/s);
      } finally {
        if (source.isTransaction) {
          source.exec("ROLLBACK");
        }
      }
    });
  },
);

it("keeps the post-migration scoped FULL check after reusing source proof", async () => {
  await withCapture(async (sourcePath, capture) => {
    await capture();
    using source = openNodeSqliteDatabase(sourcePath);
    const admission = sqliteIntegrityCheckSteps(source, sourcePath, undefined, {
      check: "quick",
      tables: ["touched"],
    });
    expect(admission.next().done).toBe(true);
    source.exec(
      "PRAGMA ignore_check_constraints = ON; INSERT INTO touched VALUES(-1); PRAGMA ignore_check_constraints = OFF;",
    );
    expect(() => assertSqliteTableIntegrity(source, sourcePath, "touched")).toThrow(
      /integrity_check.*CHECK constraint failed in touched/s,
    );
  });
});
