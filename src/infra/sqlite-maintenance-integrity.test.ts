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

type Capture = (check?: "quick" | "full") => Promise<unknown>;
async function withCapture(run: (sourcePath: string, capture: Capture) => Promise<void>) {
  const directory = fs.realpathSync(directories.make("sqlite-maintenance-integrity-"));
  const sourcePath = path.join(directory, "source.sqlite");
  {
    using source = openNodeSqliteDatabase(sourcePath);
    source.exec("PRAGMA journal_mode = WAL");
    for (const table of ["touched", "untouched"]) {
      source.exec(
        `CREATE TABLE ${table}(value INTEGER CHECK(value > 0)); INSERT INTO ${table} VALUES(1);`,
      );
    }
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

function checkSteps(
  source: ReturnType<typeof openNodeSqliteDatabase>,
  sourcePath: string,
  check: "quick" | "full" = "quick",
) {
  return sqliteIntegrityCheckSteps(source, sourcePath, undefined, { check, tables: ["touched"] });
}

it.each(["quick", "full"] as const)(
  "reuses only the captured QUICK source proof before migration (%s)",
  async (check) => {
    await withCapture(async (sourcePath, capture) => {
      await capture(check);
      using source = openNodeSqliteDatabase(sourcePath);
      const prepare = vi.spyOn(source, "prepare");
      runSqliteIntegrityOperationSync(checkSteps(source, sourcePath, check));
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
    const bytes = fs.readFileSync(sourcePath);
    bytes[offset] = 0xff;
    fs.writeFileSync(sourcePath, bytes);
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
        expect(() => runSqliteIntegrityOperationSync(checkSteps(source, sourcePath))).toThrow(
          /quick_check.*CHECK constraint failed in untouched/s,
        );
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
    expect(checkSteps(source, sourcePath).next().done).toBe(true);
    source.exec(
      "PRAGMA ignore_check_constraints = ON; INSERT INTO touched VALUES(-1); PRAGMA ignore_check_constraints = OFF;",
    );
    expect(() => assertSqliteTableIntegrity(source, sourcePath, "touched")).toThrow(
      /integrity_check.*CHECK constraint failed in touched/s,
    );
  });
});
