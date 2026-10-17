import { spawnSync } from "node:child_process";
import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { readUpdateDatabaseGenerations } from "./update-database-generations.js";
import {
  getDoctorMigrationBackup,
  getUpdateDoctorMigrationSource,
  hasUpdateDoctorMigrationCapture,
  runUpdateSqliteMigration,
  runWithDoctorMigrationBackup,
  runWithUpdateDoctorMigrationCapture,
} from "./update-doctor-migration-attribution.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

it.each(["foreign", "reversed"] as const)(
  "refuses a %s payload write while acquiring native migration custody",
  async (change) => {
    const pathname = path.join(directories.make("update-migration-custody-"), "state.sqlite");
    using database = new DatabaseSync(pathname);
    database.exec("CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('before')");
    const expected = readUpdateDatabaseGenerations([pathname])[pathname];
    const operation = vi.fn();
    const accept = vi.fn();
    let injected = false;
    let foreign: ReturnType<typeof spawnSync> | undefined;
    // A real native admission callback puts an independent writer between the
    // verified source and its exclusive migration lock, without timing races.
    database.setAuthorizer((action, pragma) => {
      if (!injected && action === constants.SQLITE_PRAGMA && pragma === "schema_version") {
        injected = true;
        foreign = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { DatabaseSync } from 'node:sqlite';
             const db = new DatabaseSync(process.argv[1]);
             db.exec("UPDATE evidence SET value = 'foreign'");
             if (process.argv[2] === 'reversed') db.exec("UPDATE evidence SET value = 'before'");
             db.close();`,
            pathname,
            change,
          ],
          { encoding: "utf8", timeout: 10_000 },
        );
      }
      return constants.SQLITE_OK;
    });
    const scope = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent() {},
      assertDatabaseAccess: (requested) => expect(requested).toBe(pathname),
    });
    try {
      scope.run(() =>
        runWithUpdateDoctorMigrationCapture(
          { expected: () => expected, assertCurrent() {}, accept, refuse() {} },
          () => {
            expect(() => runUpdateSqliteMigration(database, pathname, operation)).toThrow(
              "SQLite migration source changed after update capture",
            );
          },
        ),
      );
      expect(injected).toBe(true);
      expect(foreign?.status, String(foreign?.stderr)).toBe(0);
      expect(operation).not.toHaveBeenCalled();
      expect(accept).not.toHaveBeenCalled();
      expect(database.prepare("SELECT value FROM evidence").get()).toEqual({
        value: change === "foreign" ? "foreign" : "before",
      });
    } finally {
      database.setAuthorizer(null);
      await scope.close();
    }
  },
);

it.each(["captured-generation", null])(
  "refuses fresh fallback for a captured source (%s)",
  (generation) => {
    using database = new DatabaseSync(":memory:");
    const backup = vi.fn();
    const refuse = vi.fn();
    runWithDoctorMigrationBackup(backup, () =>
      runWithUpdateDoctorMigrationCapture(
        { expected: () => generation, assertCurrent() {}, accept() {}, refuse },
        () => {
          expect(() =>
            getDoctorMigrationBackup(database, {
              path: "/synthetic/state.sqlite",
              env: {},
              tables: ["retained"],
            }),
          ).toThrow("Updater migration requires its captured source generation");
        },
      ),
    );
    expect(backup).not.toHaveBeenCalled();
    expect(refuse).not.toHaveBeenCalled();
  },
);

it("preserves an uncaptured relocated source without certifying updater rollback", () => {
  using database = new DatabaseSync(":memory:");
  const pathname = "/synthetic/relocated/state.sqlite";
  const refuse = vi.fn();
  const backup = vi.fn(() => {
    expect(refuse).toHaveBeenCalledOnce();
    expect(hasUpdateDoctorMigrationCapture()).toBe(false);
    expect(getUpdateDoctorMigrationSource(pathname)).toBeUndefined();
    return {
      capture: { path: pathname, generation: "fresh-generation", assertCurrent() {} },
      backupPath: "/synthetic/relocated/scoped.bak",
    };
  });
  runWithDoctorMigrationBackup(backup, () =>
    runWithUpdateDoctorMigrationCapture(
      { expected: () => undefined, assertCurrent() {}, accept() {}, refuse },
      () => {
        expect(
          getDoctorMigrationBackup(database, { path: pathname, env: {}, tables: ["retained"] }),
        ).toMatchObject({ capture: { path: pathname, generation: "fresh-generation" } });
        expect(hasUpdateDoctorMigrationCapture()).toBe(true);
      },
    ),
  );
  expect(backup).toHaveBeenCalledOnce();
  expect(hasUpdateDoctorMigrationCapture()).toBe(false);
});
