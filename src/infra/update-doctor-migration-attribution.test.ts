import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
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
import {
  runUpdateStateInspectionWorker,
  parseUpdateStateInspectionWorker,
} from "./update-candidate-state.inspection.js";
import { readUpdateDatabaseGenerationsIsolated } from "./update-candidate-state.js";
import { readUpdateStateDatabaseSizes } from "./update-candidate-state.sizes.js";
import { readUpdateDatabaseGenerations } from "./update-database-generations.js";
import * as updateGenerations from "./update-database-generations.js";
import {
  getDoctorMigrationBackup,
  getUpdateDoctorMigrationSource,
  hasUpdateDoctorMigrationCapture,
  runUpdateSqliteMigration,
  runWithDoctorMigrationBackup,
  runWithUpdateDoctorMigrationCapture,
} from "./update-doctor-migration-attribution.js";
import { createUpdateDoctorDatabaseWriteCapture } from "./update-doctor-result.js";
import { readUpdateRunDriver } from "./update-run-driver.js";
import { createUpdateRun } from "./update-run-ledger.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function fixture(relative = "source.sqlite", sql?: string) {
  const root = fs.realpathSync(directories.make("captured-migration-"));
  const pathname = path.join(root, relative);
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  if (sql) {
    using database = new DatabaseSync(pathname);
    database.exec(`PRAGMA journal_mode=WAL; CREATE TABLE retained(value); ${sql}`);
  }
  return { root, pathname, env };
}

function migrate(database: DatabaseSync, pathname: string) {
  runUpdateSqliteMigration(database, pathname, () => {
    database.exec("ALTER TABLE retained ADD COLUMN migrated;");
  });
}

function captureContext(expected: () => string | null | undefined, refuse = vi.fn()) {
  return { expected, assertCurrent() {}, accept() {}, refuse };
}

it.each([
  "read-only reader opens",
  "last writable reader closes",
  "read-only reader opens before admission",
])("migrates a captured WAL database when its %s without writing", async (transition) => {
  const { pathname, env } = fixture("source.sqlite", "INSERT INTO retained VALUES (7);");
  // SQLite only removes the zero-write WAL index when a writable handle closes.
  const reader =
    transition === "last writable reader closes" ? new DatabaseSync(pathname) : undefined;
  reader?.prepare("SELECT * FROM retained").all();
  const generations = readUpdateDatabaseGenerations([pathname]);
  if (transition === "read-only reader opens before admission") {
    using readOnly = new DatabaseSync(pathname, { readOnly: true });
    readOnly.prepare("SELECT * FROM retained").all();
  }
  const { receipt, warnings } = await withCapture(env, generations, async () => {
    reader?.close();
    if (transition === "read-only reader opens") {
      using readOnly = new DatabaseSync(pathname, { readOnly: true });
      readOnly.prepare("SELECT * FROM retained").all();
    }
    expect(readUpdateDatabaseGenerations([pathname])[pathname]).not.toBe(generations[pathname]);
    const database = new DatabaseSync(pathname);
    try {
      migrate(database, pathname);
      expect(database.prepare("SELECT value FROM retained").all()).toEqual([{ value: 7 }]);
    } finally {
      // Migration installs a close observer after acquisition; using would retain the old disposer.
      database.close();
    }
  });
  expect(warnings).toEqual([]);
  expect(receipt).toMatchObject({ unchanged: true, fromGenerations: generations });
});

it.each(["already exclusive", "retain exclusive"])(
  "keeps native custody when a migration is %s",
  async (mode) => {
    const { pathname, env } = fixture();
    using database = new DatabaseSync(pathname);
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE retained(value);");
    const generations = readUpdateDatabaseGenerations([pathname]);
    if (mode === "already exclusive") {
      database.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; ROLLBACK;");
    }
    const { receipt, warnings } = await withCapture(env, generations, async () => {
      const inProcess = vi.spyOn(updateGenerations, "readMatchingUpdateDatabaseGeneration");
      runUpdateSqliteMigration(
        database,
        pathname,
        () => {
          database.exec("INSERT INTO retained VALUES (7);");
        },
        { retainExclusive: true },
      );
      expect(inProcess).toHaveBeenCalledTimes(mode === "already exclusive" ? 0 : 1);
      expect(database.prepare("PRAGMA locking_mode").get()?.locking_mode).toBe("exclusive");
      database.close();
    });
    expect(warnings).toEqual([]);
    expect(receipt).toMatchObject({ unchanged: true, fromGenerations: generations });
  },
);

it.each(["different content", "same content"])(
  "rejects a captured WAL database after an outside commit with %s",
  async (change) => {
    const { pathname, env } = fixture("source.sqlite", "INSERT INTO retained VALUES (7);");
    const generations = readUpdateDatabaseGenerations([pathname]);
    const { receipt } = await withCapture(env, generations, async () => {
      using writer = new DatabaseSync(pathname);
      writer.exec("UPDATE retained SET value = 8;");
      if (change === "same content") {
        writer.exec("UPDATE retained SET value = 7;");
      }
      writer.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      using database = new DatabaseSync(pathname);
      expect(() => migrate(database, pathname)).toThrow(
        "SQLite migration source changed after update capture:",
      );
    });
    expect(receipt).toMatchObject({ unchanged: false });
  },
);

// Published v2026.9.34's unversioned wire format, independent of the current digest owner.
function legacyGeneration(file: string): string {
  const fingerprint = (pathname: string) => {
    const stat = fs.statSync(pathname, { bigint: true });
    return {
      birthtimeNs: String(stat.birthtimeNs),
      ctimeNs: String(stat.ctimeNs),
      dev: String(stat.dev),
      ino: String(stat.ino),
      mtimeNs: String(stat.mtimeNs),
      sha256: createHash("sha256").update(fs.readFileSync(pathname)).digest("hex"),
      size: String(stat.size),
    };
  };
  const journal = fs.existsSync(`${file}-journal`) ? fingerprint(`${file}-journal`) : undefined;
  const wal =
    fs.existsSync(`${file}-wal`) && fs.statSync(`${file}-wal`).size > 0
      ? fingerprint(`${file}-wal`)
      : undefined;
  const header = fs.existsSync(`${file}-shm`)
    ? fs.readFileSync(`${file}-shm`).subarray(0, 96).toString("hex")
    : null;
  return createHash("sha256")
    .update(
      JSON.stringify([
        JSON.stringify({
          database: fingerprint(file),
          ...(journal ? { journal } : {}),
          ...(wal ? { wal } : {}),
        }),
        header,
      ]),
    )
    .digest("hex");
}

it.each(["unchanged", "changed data", "same-content commit", "replaced file"])(
  "verifies a 2026.9.34 inventory through migration and native close: %s",
  async (change) => {
    const { root, pathname, env } = fixture("source.sqlite", "INSERT INTO retained VALUES (7);");
    const missing = path.join(root, "missing.sqlite");
    const generations = { [pathname]: legacyGeneration(pathname), [missing]: null };
    expect(readUpdateDatabaseGenerations([pathname])[pathname]).not.toBe(generations[pathname]);
    if (change === "replaced file") {
      fs.renameSync(pathname, `${pathname}.old`);
      fs.copyFileSync(`${pathname}.old`, pathname);
    } else if (change !== "unchanged") {
      using writer = new DatabaseSync(pathname);
      writer.exec("UPDATE retained SET value = 8;");
      if (change === "same-content commit") {
        writer.exec("UPDATE retained SET value = 7;");
      }
    }
    const { receipt, warnings } = await withCapture(env, generations, async () => {
      const database = new DatabaseSync(pathname);
      try {
        if (change === "unchanged") {
          migrate(database, pathname);
          expect(database.prepare("SELECT value FROM retained").all()).toEqual([{ value: 7 }]);
        } else {
          expect(() => migrate(database, pathname)).toThrow(
            "SQLite migration source changed after update capture:",
          );
        }
      } finally {
        database.close();
      }
    });
    expect(receipt?.unchanged).toBe(change === "unchanged");
    if (change === "unchanged") {
      expect(warnings).toEqual([]);
      expect(receipt).toMatchObject({
        fromGenerations: generations,
        generations: { [pathname]: legacyGeneration(pathname), [missing]: null },
      });
    }
  },
);

it.each(["2026.9.33", "2026.9.34"])(
  "answers the unmarked %s parent in its original format",
  async (version) => {
    const root = fs.realpathSync(directories.make("legacy-rollback-generation-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    const pathname = path.join(root, "source.sqlite");
    {
      using db = new DatabaseSync(pathname);
      db.exec("CREATE TABLE retained(value);");
    }
    const parent = readUpdateRunDriver();
    expect(parent).toBeDefined();
    createUpdateRun({ trigger: "cli", before: { version }, origin: { driver: parent } }, { env });
    try {
      const stagingRoot = path.join(root, "staging");
      fs.mkdirSync(stagingRoot);
      const worker = { nodeRunner: process.execPath, sourceEnv: env, stagingRoot };
      const inspect = async () =>
        parseUpdateStateInspectionWorker(
          await runUpdateStateInspectionWorker({
            ...worker,
            input: { mode: "database-generations", paths: [pathname], stateDir: root, config: {} },
            databases: await readUpdateStateDatabaseSizes([pathname], worker),
          }),
          z.record(z.string(), z.string()),
        );
      expect(await inspect()).toEqual({ [pathname]: legacyGeneration(pathname) });
      // A candidate-produced recapture must stay current even in the old updater's run.
      expect(await readUpdateDatabaseGenerationsIsolated([pathname], { env })).toEqual(
        readUpdateDatabaseGenerations([pathname]),
      );
    } finally {
      await closeOpenClawStateDatabaseAsync();
    }
  },
);

async function withCapture(
  env: NodeJS.ProcessEnv,
  generations: ReturnType<typeof readUpdateDatabaseGenerations>,
  operation: () => Promise<void>,
  assertDatabaseAccess?: (requested: string) => void,
) {
  const warnings: string[] = [];
  const capture = createUpdateDoctorDatabaseWriteCapture(generations, {
    env,
    signal: new AbortController().signal,
    warn: (message) => warnings.push(message),
  })!;
  const scope = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent() {},
    assertDatabaseAccess,
  });
  try {
    await capture.admit();
    await scope.run(() => capture.run(operation));
    await capture.settle();
    return { receipt: capture.receipt, warnings };
  } finally {
    await closeOpenClawStateDatabaseAsync();
    await scope.close();
  }
}

it.each(["lease", "outside"] as const)(
  "settles prior %s writers before acquiring schema repair custody",
  async (writer) => {
    const { root, pathname, env } = fixture(path.join("state", "openclaw.sqlite"));
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
    const { receipt } = await withCapture(env, generations, async () => {
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
        expect((await prepareOpenClawStateDatabaseSchema({ env }, "doctor")).warnings).toEqual([]);
      } else {
        await expect(prepareOpenClawStateDatabaseSchema({ env }, "doctor")).rejects.toThrow(
          "SQLite migration source changed after update capture:",
        );
      }
      await closeOpenClawStateDatabaseAsync();
    });
    expect(receipt).toMatchObject({ unchanged: writer === "lease", fromGenerations: generations });
  },
);

it("attributes a captured absent shared store and its new credential companion during bootstrap", async () => {
  const { root, pathname, env } = fixture(path.join("state", "openclaw.sqlite"));
  const localPath = path.join(root, "client", "credentials.sqlite");
  const generations = readUpdateDatabaseGenerations([pathname, localPath]);
  expect(generations).toEqual({ [pathname]: null, [localPath]: null });
  const { receipt, warnings } = await withCapture(
    env,
    generations,
    async () => {
      openOpenClawStateDatabase({ env });
      await closeOpenClawStateDatabaseAsync();
    },
    (requested) => expect(requested).toBe(pathname),
  );
  expect(warnings).toEqual([]);
  expect(receipt).toMatchObject({
    unchanged: true,
    generations: { [pathname]: expect.any(String), [localPath]: expect.any(String) },
  });
});

it.each(["captured-generation", null])(
  "refuses fresh fallback for a captured source (%s)",
  (generation) => {
    using database = new DatabaseSync(":memory:");
    const backup = vi.fn();
    const refuse = vi.fn();
    runWithDoctorMigrationBackup(backup, () =>
      runWithUpdateDoctorMigrationCapture(
        captureContext(() => generation, refuse),
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
      captureContext(() => undefined, refuse),
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
