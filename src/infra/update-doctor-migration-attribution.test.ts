import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
  prepareOpenClawStateDatabaseSchema,
  repairOpenClawStateDatabaseIndexesForDoctor,
  repairOpenClawStateDatabaseReadabilityForDoctor,
} from "../state/openclaw-state-db.js";
import { addPreCutoverClientCredentialTablesForTest } from "../state/openclaw-state-schema.test-support.js";
import { readUpdateDatabaseGenerations } from "./update-database-generations.js";
import {
  getDoctorMigrationBackup,
  getUpdateDoctorMigrationSource,
  hasUpdateDoctorMigrationCapture,
  runWithDoctorMigrationBackup,
  runWithUpdateDoctorMigrationCapture,
} from "./update-doctor-migration-attribution.js";
import { createUpdateDoctorDatabaseWriteCapture } from "./update-doctor-result.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

it.each(["lease", "outside"] as const)(
  "settles prior %s writers before acquiring schema repair custody",
  async (writer) => {
    const root = fs.realpathSync(directories.make("captured-maintenance-state-"));
    const pathname = path.join(root, "state", "openclaw.sqlite");
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    openOpenClawStateDatabase({ env });
    await closeOpenClawStateDatabaseAsync();
    fs.rmSync(path.join(root, "client"), { recursive: true });
    {
      using database = new DatabaseSync(pathname);
      addPreCutoverClientCredentialTablesForTest(database);
      database.exec(`PRAGMA user_version = 20;
      UPDATE schema_meta SET schema_version = 20;
      DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion';`);
    }
    const generations = readUpdateDatabaseGenerations([pathname]);
    const capture = createUpdateDoctorDatabaseWriteCapture(generations, {
      env,
      signal: new AbortController().signal,
      warn() {},
    })!;
    const scope = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent() {},
    });
    try {
      await capture.admit();
      await scope.run(() =>
        capture.run(async () => {
          expect(repairOpenClawStateDatabaseIndexesForDoctor({ env }).warnings).toEqual([]);
          expect(repairOpenClawStateDatabaseReadabilityForDoctor({ env }).warnings).toEqual([]);
          expect(
            repairOpenClawStateDatabaseSchema({ env, versionMigrationOnly: true }).warnings,
          ).toEqual([]);
          if (writer === "lease") {
            await withAgentDatabaseMaintenanceLease({ env, processBound: true }, async () => {});
          } else {
            using outside = new DatabaseSync(pathname);
            outside
              .prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)")
              .run("test.outside-write", "99", 1);
          }
          if (writer === "lease") {
            expect((await prepareOpenClawStateDatabaseSchema({ env }, "doctor")).warnings).toEqual(
              [],
            );
          } else {
            await expect(prepareOpenClawStateDatabaseSchema({ env }, "doctor")).rejects.toThrow(
              "SQLite migration source changed after update capture.",
            );
          }
          await closeOpenClawStateDatabaseAsync();
        }),
      );
      await capture.settle();
      // Closing the owned handle attributes its lease writes; outside writes stay unknown.
      expect(capture.receipt?.unchanged).toBe(writer === "lease");
      expect(capture.receipt?.fromGenerations).toEqual(generations);
    } finally {
      await closeOpenClawStateDatabaseAsync();
      await scope.close();
    }
  },
);

it("attributes a captured absent shared store and its new credential companion during bootstrap", async () => {
  const root = fs.realpathSync(directories.make("captured-fresh-state-"));
  const pathname = path.join(root, "state", "openclaw.sqlite");
  const localPath = path.join(root, "client", "credentials.sqlite");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const generations = readUpdateDatabaseGenerations([pathname, localPath]);
  expect(generations).toEqual({ [pathname]: null, [localPath]: null });
  const warnings: string[] = [];
  const capture = createUpdateDoctorDatabaseWriteCapture(generations, {
    env,
    signal: new AbortController().signal,
    warn: (message) => warnings.push(message),
  })!;
  const scope = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent() {},
    assertDatabaseAccess(requested) {
      expect(requested).toBe(pathname);
    },
  });
  try {
    await capture.admit();
    await scope.run(() =>
      capture.run(async () => {
        openOpenClawStateDatabase({ env });
        await closeOpenClawStateDatabaseAsync();
      }),
    );
    await capture.settle();
    expect(warnings).toEqual([]);
    expect(capture.receipt).toMatchObject({
      unchanged: true,
      generations: { [pathname]: expect.any(String), [localPath]: expect.any(String) },
    });
  } finally {
    await closeOpenClawStateDatabaseAsync();
    await scope.close();
  }
});

it.each(["captured-generation", null])(
  "refuses fresh fallback for a captured source (%s)",
  (generation) => {
    using database = new DatabaseSync(":memory:");
    const backup = vi.fn();
    const refuse = vi.fn();
    runWithDoctorMigrationBackup(backup, () =>
      runWithUpdateDoctorMigrationCapture(
        {
          expected: () => generation,
          assertCurrent() {},
          accept() {},
          refuse,
        },
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
      {
        expected: () => undefined,
        assertCurrent() {},
        accept() {},
        refuse,
      },
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
