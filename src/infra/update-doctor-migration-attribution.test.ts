import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPersistedSharedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import {
  adoptUpdateBootDatabaseWrites,
  restoreFailedUpdateDatabases,
} from "../cli/update-cli/update-command-database-backup.js";
import {
  observeUpdateParentDatabaseWrites,
  recordUpdateDatabaseWrites,
} from "../cli/update-cli/update-command-database-receipts.js";
import { runDoctorConfigPreflight } from "../commands/doctor-config-preflight.js";
import { resolveDoctorUpdateAdmission } from "../commands/doctor-maintenance-admission.js";
import { repairAuthProfileMigration } from "../commands/doctor/auth-profile-repair.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { stateNativeProcessEntrypoints } from "../state/native-process-runtime.test-support.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { openClawStateDatabaseCache } from "../state/openclaw-state-db-cache.js";
import { repairDoctorStateSchemaAsync } from "../state/openclaw-state-db-doctor-repair.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  openOpenClawStateDatabaseForDoctor,
  repairOpenClawStateDatabaseIndexesForDoctor,
  repairOpenClawStateDatabaseReadabilityForDoctor,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runClientCredentialOperation } from "./client-credential-store.js";
import { readExecApprovalsConfigRow } from "./exec-approvals-sqlite.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import * as sqliteReadOnlyWorker from "./sqlite-readonly-worker.js";
import * as sqliteTransactions from "./sqlite-transaction.js";
import {
  detectLegacyExecApprovals,
  migrateLegacyExecApprovals,
} from "./state-migrations.exec-approvals.js";
import { storageProcessTestEntrypoints } from "./storage-process-runtime.test-support.js";
import {
  runUpdateStateInspectionWorker,
  parseUpdateStateInspectionWorker,
} from "./update-candidate-state.inspection.js";
import { readUpdateDatabaseGenerationsIsolated } from "./update-candidate-state.js";
import { readUpdateStateDatabaseSizes } from "./update-candidate-state.sizes.js";
import { UPDATE_RUN_ID_ENV } from "./update-control-plane-sentinel.js";
import type { UpdateDatabaseBackup } from "./update-database-backup.js";
import { readUpdateDatabaseGenerations } from "./update-database-generations.js";
import * as updateGenerations from "./update-database-generations.js";
import { recordUpdateModelRetirement } from "./update-deferred-model-retirement.js";
import {
  runWithDoctorMigrationBackup,
  runWithUpdateDoctorMigrationCapture,
} from "./update-doctor-migration-attribution.js";
import {
  beginUpdateSqliteCompanion,
  getDoctorMigrationBackup,
  getUpdateDoctorMigrationSource,
  hasUpdateDoctorMigrationCapture,
  runUpdateSqliteMigration,
  runUpdateSqliteMigrationAsync,
} from "./update-doctor-migration-context.js";
import { createUpdateDoctorDatabaseWriteCapture } from "./update-doctor-result.js";
import { readUpdateRunDriver } from "./update-run-driver.js";
import { createUpdateRun, getUpdateRun, recordUpdateRunStep } from "./update-run-ledger.js";
import { recordUpdateRunStepAsync } from "./update-run-write.async.js";
import type { UpdateRunResult } from "./update-runner-types.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
function fixture(relative = "source.sqlite", sql?: string) {
  const root = fs.realpathSync(directories.make("captured-migration-"));
  const pathname = path.join(root, relative);
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "alias") };
  fs.symlinkSync(root, env.OPENCLAW_STATE_DIR, "junction");
  if (sql) {
    using database = new DatabaseSync(pathname);
    database.exec(`PRAGMA journal_mode=WAL; CREATE TABLE retained(value); ${sql}`);
  }
  return { root, pathname, env };
}

function migrate(database: DatabaseSync, pathname: string) {
  const alias = path.join(path.dirname(pathname), "alias", path.basename(pathname));
  runUpdateSqliteMigration(database, alias, () => {
    expect(getUpdateDoctorMigrationSource(alias)?.path).toBe(alias);
    database.exec("ALTER TABLE retained ADD COLUMN migrated;");
  });
}

it.each([false, true])(
  "attributes successful boot writes and preserves preexisting-write rollback refusal: %s",
  async (preexistingWrite) => {
    const { root, pathname, env } = fixture(
      "credentials.sqlite",
      "INSERT INTO retained VALUES (7);",
    );
    const generations = readUpdateDatabaseGenerations([pathname]);
    const backup: UpdateDatabaseBackup = {
      directory: root,
      databases: [
        {
          path: pathname,
          snapshotPath: pathname,
          userVersion: 0,
          sha256: "0".repeat(64),
          sizeBytes: fs.statSync(pathname).size,
        },
      ],
      sourcePaths: [pathname],
      missingPaths: [],
      sourceGenerations: generations,
      warnings: [],
      migration: { name: "first Doctor", backup: root, from: generations, to: generations },
    };
    if (preexistingWrite) {
      using database = new DatabaseSync(pathname);
      database.exec("UPDATE retained SET value = 8;");
    }
    const result = await adoptUpdateBootDatabaseWrites(backup, env, async () => {
      using database = new DatabaseSync(pathname);
      database.exec("UPDATE retained SET value = 9;");
      return { status: "ok", mode: "npm", steps: [], durationMs: 0 };
    });
    expect(result.status).toBe("ok");
    const { receipt, warnings } = await withCapture(env, backup.migration!.to, async () => {
      using database = new DatabaseSync(pathname);
      migrate(database, pathname);
      expect(database.prepare("SELECT value FROM retained").all()).toEqual([{ value: 9 }]);
    });
    expect(receipt?.unchanged).toBe(!preexistingWrite);
    expect(backup.migration!.from).toEqual(generations);
    expect(warnings).toEqual(
      preexistingWrite
        ? [
            "Databases changed after the updater captured them; continuing Doctor with current state, but automatic database restoration is unavailable for this update.",
          ]
        : [],
    );
  },
);

it("refuses a changed companion the session never opened", async () => {
  const { pathname, env } = fixture("source.sqlite", "INSERT INTO retained VALUES (7);");
  const { pathname: companionPath } = fixture("companion.sqlite", "PRAGMA journal_mode=DELETE;");
  const generations = readUpdateDatabaseGenerations([pathname, companionPath]);
  const { receipt } = await withCapture(env, generations, async () => {
    using source = new DatabaseSync(pathname);
    using companion = new DatabaseSync(companionPath);
    companion.exec("PRAGMA locking_mode=EXCLUSIVE; INSERT INTO retained VALUES (9);");
    runUpdateSqliteMigration(source, pathname, () => {
      expect(() => beginUpdateSqliteCompanion(companion, companionPath, false)).toThrow(
        "Database migration companion no longer matches its capture.",
      );
    });
  });
  expect(receipt?.unchanged).toBe(false);
});

it.each([
  "read-only reader opens",
  "last writable reader closes",
  "read-only reader opens before admission",
  "read-only reader rebuilds a checkpointed index",
])("migrates a captured WAL database when its %s without writing", async (transition) => {
  const { pathname, env } = fixture("source.sqlite", "INSERT INTO retained VALUES (7);");
  if (transition === "read-only reader rebuilds a checkpointed index") {
    const writer = new DatabaseSync(pathname);
    const pin = new DatabaseSync(pathname, { readOnly: true });
    pin.prepare("SELECT * FROM retained").all();
    writer.exec(
      "UPDATE retained SET value = 8; UPDATE retained SET value = 7; PRAGMA wal_checkpoint(TRUNCATE);",
    );
    writer.close();
    pin.close();
    expect(fs.statSync(`${pathname}-wal`).size).toBe(0);
    expect(fs.readFileSync(`${pathname}-shm`).readUInt32LE(8)).not.toBe(0);
  }
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
    if (
      transition === "read-only reader opens" ||
      transition === "read-only reader rebuilds a checkpointed index"
    ) {
      using readOnly = new DatabaseSync(pathname, { readOnly: true });
      readOnly.prepare("PRAGMA user_version").get();
      readOnly.prepare("SELECT name FROM sqlite_master").all();
    }
    expect(readUpdateDatabaseGenerations([pathname])[pathname]).not.toBe(generations[pathname]);
    using database = new DatabaseSync(pathname);
    migrate(database, pathname);
    expect(database.prepare("SELECT value FROM retained").all()).toEqual([{ value: 7 }]);
  });
  expect(warnings).toEqual([]);
  expect(receipt).toMatchObject({ unchanged: true, fromGenerations: generations });
});

it.each([
  "complete",
  "cancel before mutation",
  "lose authority before mutation",
  "cancel after commit",
] as const)("settles awaited native migration observations (%s)", async (outcome) => {
  const { pathname, env } = fixture("source.sqlite", "INSERT INTO retained VALUES (7);");
  const generations = readUpdateDatabaseGenerations([pathname]);
  const controller = new AbortController();
  const failure = new Error(outcome);
  let current = true;
  let observations = 0;
  const { receipt } = await withCapture(
    env,
    generations,
    async () => {
      using database = new DatabaseSync(pathname);
      const inspections = await import("./update-candidate-state.inspection.js");
      const read = inspections.readUpdateSqliteDatabaseGenerationPairIsolated;
      const observer = vi
        .spyOn(inspections, "readUpdateSqliteDatabaseGenerationPairIsolated")
        .mockImplementation(async (...args) => {
          observations += 1;
          expect(database.isTransaction).toBe(false);
          if (observations === 2) {
            expect(database.prepare("PRAGMA locking_mode").get()?.locking_mode).toBe("exclusive");
          }
          const observed = await read(...args);
          if (observations === 1) {
            if (outcome === "cancel before mutation") {
              controller.abort(failure);
            }
            if (outcome === "lose authority before mutation") {
              current = false;
            }
          } else if (outcome === "cancel after commit") {
            controller.abort(failure);
          }
          return observed;
        });
      const synchronous = vi.spyOn(sqliteReadOnlyWorker, "runSqliteReadOnlyWorkerSync");
      let serviced = false;
      const immediate = setImmediate(() => {
        serviced = true;
      });
      const mutate = vi.fn(() => {
        expect(serviced).toBe(true);
        expect(getUpdateDoctorMigrationSource(pathname)?.path).toBe(pathname);
        database.exec("INSERT INTO retained VALUES (8);");
      });
      try {
        const migration = sqliteReadOnlyWorker.withSqliteReadOnlyWorkerScope(
          () => runUpdateSqliteMigrationAsync(database, pathname, mutate),
          { signal: controller.signal, deadlineOwnedByCaller: false },
        );
        if (outcome === "complete") {
          await expect(migration).resolves.toBeUndefined();
        } else {
          await expect(migration).rejects.toBe(failure);
        }
        expect(mutate).toHaveBeenCalledTimes(
          outcome === "complete" || outcome === "cancel after commit" ? 1 : 0,
        );
        expect(observations).toBe(
          outcome === "complete" || outcome === "cancel after commit" ? 2 : 1,
        );
        expect(synchronous).not.toHaveBeenCalled();
        expect(database.isTransaction).toBe(false);
        expect(database.prepare("PRAGMA locking_mode").get()?.locking_mode).toBe("normal");
        expect(database.prepare("SELECT value FROM retained ORDER BY value").all()).toEqual(
          outcome === "complete" || outcome === "cancel after commit"
            ? [{ value: 7 }, { value: 8 }]
            : [{ value: 7 }],
        );
      } finally {
        clearImmediate(immediate);
        current = true;
        observer.mockRestore();
        synchronous.mockRestore();
      }
    },
    undefined,
    () => {
      if (!current) {
        throw failure;
      }
    },
  );
  expect(receipt?.unchanged).toBe(outcome === "complete");
});

it.each(["already exclusive", "retain exclusive"])(
  "keeps native custody when a migration is %s without probing on close",
  async (mode) => {
    const { pathname, env } = fixture();
    using database = new DatabaseSync(pathname);
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE retained(value);");
    const { pathname: companionPath } = fixture("companion.sqlite", "SELECT 1;");
    using companion = new DatabaseSync(companionPath);
    const paths = [pathname, companionPath];
    const generations = readUpdateDatabaseGenerations(paths);
    if (mode === "already exclusive") {
      database.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; ROLLBACK;");
    }
    const authority = vi.fn();
    const { receipt, warnings } = await withCapture(
      env,
      generations,
      async () => {
        runUpdateSqliteMigration(companion, companionPath, () => {});
        companion.exec("PRAGMA locking_mode=EXCLUSIVE; INSERT INTO retained VALUES (9);");
        const inProcess = vi.spyOn(updateGenerations, "readMatchingUpdateDatabaseGeneration");
        runUpdateSqliteMigration(
          database,
          pathname,
          () => {
            database.exec("INSERT INTO retained VALUES (7);");
            beginUpdateSqliteCompanion(companion, companionPath, false)!.complete();
          },
          { retainExclusive: true },
        );
        expect(inProcess).toHaveBeenCalledTimes(mode === "already exclusive" ? 0 : 1);
        expect(database.prepare("PRAGMA locking_mode").get()?.locking_mode).toBe("exclusive");
        const generation = vi.spyOn(sqliteReadOnlyWorker, "runSqliteReadOnlyWorkerSync");
        authority.mockClear();
        database.close();
        companion.close();
        expect(generation).not.toHaveBeenCalled();
        expect(authority).not.toHaveBeenCalled();
      },
      authority,
    );
    expect(warnings).toEqual([]);
    expect(receipt).toMatchObject({
      unchanged: true,
      fromGenerations: generations,
      generations: readUpdateDatabaseGenerations(paths),
    });
  },
);

it.each(["different content", "same content", "different content with a rebuilt index"])(
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
      if (change === "different content with a rebuilt index") {
        writer.close();
        using reader = new DatabaseSync(pathname, { readOnly: true });
        reader.prepare("PRAGMA user_version").get();
        reader.prepare("SELECT name FROM sqlite_master").all();
      }
      using database = new DatabaseSync(pathname);
      expect(() => migrate(database, pathname)).toThrow(
        "SQLite migration source changed after update capture:",
      );
    });
    expect(receipt).toMatchObject({ unchanged: false });
  },
);

it.each(["credential write", "WAL index rebuild"])(
  "migrates after a %s while the parent's restore stays refused",
  async (change) => {
    const { root, pathname, env } = fixture(
      "credentials.sqlite",
      "INSERT INTO retained VALUES (7);",
    );
    // A status reader outlives the parent's last ledger commit, so capture binds live WAL evidence.
    const reader = new DatabaseSync(pathname, { readOnly: true });
    reader.prepare("SELECT value FROM retained").all();
    const writer = new DatabaseSync(pathname);
    writer.exec("INSERT INTO retained VALUES (8);");
    writer.close();
    const captured = readUpdateDatabaseGenerations([pathname]);
    reader.close();
    if (change === "credential write") {
      using credentials = new DatabaseSync(pathname);
      credentials.exec("INSERT INTO retained VALUES (9); PRAGMA wal_checkpoint(TRUNCATE);");
    }
    // The next native open after the readers leave rebuilds the index without a commit.
    const rebuilt = new DatabaseSync(pathname, { readOnly: true });
    rebuilt.prepare("SELECT value FROM retained").all();
    rebuilt.close();
    const admitted = readUpdateDatabaseGenerations([pathname]);
    expect(admitted).not.toEqual(captured);

    const { receipt, warnings } = await withCapture(env, captured, async () => {
      using database = new DatabaseSync(pathname);
      migrate(database, pathname);
    });
    expect(warnings).toEqual([
      "Databases changed after the updater captured them; continuing Doctor with current state, but automatic database restoration is unavailable for this update.",
    ]);
    expect(receipt).toMatchObject({ unchanged: false, fromGenerations: admitted });
    const backup: UpdateDatabaseBackup = {
      directory: root,
      databases: [],
      missingPaths: [],
      sourcePaths: [pathname],
      sourceGenerations: captured,
      warnings: [],
    };
    recordUpdateDatabaseWrites(backup, receipt, { name: "openclaw doctor" });
    expect(backup.restoreRefusal).toBe(
      "databases changed after snapshot capture; the writer is unknown",
    );
    const result: UpdateRunResult = { status: "error", mode: "npm", steps: [], durationMs: 0 };
    expect(
      await restoreFailedUpdateDatabases({
        backup,
        result,
        runId: "stale-capture",
        env,
        assertCurrent() {},
      }),
    ).toBe(false);
    expect(result.rollbackOutcome?.status).toBe("not-attempted");
    using preserved = new DatabaseSync(pathname, { readOnly: true });
    expect(preserved.prepare("SELECT value, migrated FROM retained ORDER BY value").all()).toEqual(
      (change === "credential write" ? [7, 8, 9] : [7, 8]).map((value) => ({
        value,
        migrated: null,
      })),
    );
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
  const family = {
    database: fingerprint(file),
    ...(journal ? { journal } : {}),
    ...(wal ? { wal } : {}),
  };
  return createHash("sha256")
    .update(JSON.stringify([JSON.stringify(family), header]))
    .digest("hex");
}

it.each(["unchanged", "changed data", "same-content commit", "replaced file"])(
  "verifies a 2026.9.34 inventory through migration and native close: %s",
  async (change) => {
    // DELETE mode keeps same-content commit evidence after close, independent of timestamps.
    const { root, pathname, env } = fixture(
      "source.sqlite",
      `INSERT INTO retained VALUES (7); ${change === "same-content commit" ? "PRAGMA journal_mode=DELETE;" : ""}`,
    );
    const missing = path.join(root, "missing.sqlite");
    const generations = { [pathname]: legacyGeneration(pathname), [missing]: null };
    expect(readUpdateDatabaseGenerations([pathname])[pathname]).not.toBe(generations[pathname]);
    if (change === "replaced file") {
      fs.renameSync(pathname, `${pathname}.old`);
      fs.copyFileSync(`${pathname}.old`, pathname);
    }
    {
      using writer = new DatabaseSync(pathname);
      if (change === "changed data" || change === "same-content commit") {
        writer.exec("UPDATE retained SET value = 8;");
        if (change === "same-content commit") {
          writer.exec("UPDATE retained SET value = 7;");
        }
      }
    }
    const { receipt, warnings } = await withCapture(env, generations, async () => {
      using database = new DatabaseSync(pathname);
      migrate(database, pathname);
      expect(database.prepare("SELECT value FROM retained").all()).toEqual([
        { value: change === "changed data" ? 8 : 7 },
      ]);
    });
    expect(receipt?.unchanged).toBe(change === "unchanged");
    if (change === "unchanged") {
      expect(warnings).toEqual([]);
      expect(receipt).toMatchObject({
        fromGenerations: generations,
        generations: { [pathname]: legacyGeneration(pathname), [missing]: null },
      });
    } else {
      expect(warnings).toEqual([
        "Databases changed after the updater captured them; continuing Doctor with current state, but automatic database restoration is unavailable for this update.",
      ]);
    }
  },
);

it.each([
  { version: "2026.9.7", ownsRun: true, profile: "fresh" },
  { version: "2026.9.8", ownsRun: true, profile: "fresh" },
  { version: "2026.9.33", ownsRun: true, profile: "fresh" },
  { version: "2026.9.34", ownsRun: true, profile: "fresh" },
  { version: "2026.9.37", ownsRun: true, profile: "fresh" },
  { version: "2026.9.37", ownsRun: true, profile: "restored" },
  { version: "2026.9.37", ownsRun: false, profile: "fresh" },
  { version: "2026.10.33", ownsRun: true, profile: "fresh" },
])(
  "round-trips the $version capture through Doctor and unmarked rollback (ownsRun=$ownsRun, profile=$profile)",
  async ({ version, ownsRun, profile }) => {
    const { root, env, pathname } = fixture("source.sqlite", "SELECT 1;");
    const parent = readUpdateRunDriver(ownsRun ? process.pid : process.ppid);
    createUpdateRun({ trigger: "cli", before: { version }, origin: { driver: parent } }, { env });
    // The updater closes its ledger writer before handing the inventory to Doctor.
    await closeOpenClawStateDatabaseAsync();
    const shared = fs.realpathSync(resolveOpenClawStateSqlitePath(env));
    if (profile === "restored") {
      // The published updater restores a standalone rollback-journal image.
      using restoredState = new DatabaseSync(shared);
      restoredState.exec("PRAGMA journal_mode=DELETE");
    }
    // Earlier parents can inspect a single store without requesting the shared ledger.
    const missing = path.join(root, "missing.sqlite");
    const paths =
      version === "2026.9.8" || version === "2026.9.33" || version === "2026.9.34"
        ? [pathname]
        : [pathname, shared, missing];
    const maintenance = await acquireGatewayLock({
      env,
      role: "sqlite-maintenance",
      allowInTests: true,
      timeoutMs: 0,
    });
    if (!maintenance) {
      throw new Error("Test could not acquire rollback maintenance");
    }
    try {
      const physical = ownsRun && version !== "2026.10.33";
      const capture = physical
        ? Object.fromEntries(
            paths.map((file) => [file, file === missing ? null : legacyGeneration(file)]),
          )
        : readUpdateDatabaseGenerations(paths);
      const { receipt } = await withCapture(env, capture, async () => {
        if (profile === "restored") {
          await openOpenClawStateDatabaseForDoctor({ env });
          // Agent maintenance needs a second writer while Doctor retains its state handle.
          using leaseWriter = new DatabaseSync(shared, { timeout: 0 });
          leaseWriter.exec("BEGIN IMMEDIATE; ROLLBACK");
        }
        using db = new DatabaseSync(pathname);
        migrate(db, pathname);
      });
      expect(receipt).toMatchObject({ unchanged: true, fromGenerations: capture });
      expect(receipt?.generations?.[pathname]).not.toBe(capture[pathname]);
      const stagingRoot = path.join(root, "staging");
      fs.mkdirSync(stagingRoot);
      const worker = { nodeRunner: process.execPath, sourceEnv: env, stagingRoot };
      const restored = parseUpdateStateInspectionWorker(
        await runUpdateStateInspectionWorker({
          ...worker,
          input: {
            mode: "database-generations",
            paths,
            stateDir: env.OPENCLAW_STATE_DIR,
            config: {},
          },
          databases: await readUpdateStateDatabaseSizes(paths, worker),
        }),
        z.record(z.string(), z.string().nullable()),
      );
      expect(restored).toEqual(receipt?.generations);
      // A candidate-produced recapture must stay current even in the old updater's run.
      expect(await readUpdateDatabaseGenerationsIsolated([pathname], { env })).toEqual(
        readUpdateDatabaseGenerations([pathname]),
      );
    } finally {
      await maintenance.release();
    }
  },
);

async function withCapture(
  env: NodeJS.ProcessEnv,
  generations: ReturnType<typeof readUpdateDatabaseGenerations>,
  operation: () => Promise<void>,
  assertDatabaseAccess?: (requested: string) => void,
  assertOwnerCurrent: () => void = () => {},
) {
  const warnings: string[] = [];
  const capture = createUpdateDoctorDatabaseWriteCapture(generations, {
    env,
    signal: new AbortController().signal,
    warn: (message) => warnings.push(message),
  })!;
  const scope = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent,
    assertDatabaseAccess: assertDatabaseAccess ?? (() => {}),
  });
  try {
    await capture.admit();
    await scope.run(() => capture.run(operation));
    await scope.close();
    await capture.settle();
    return { receipt: capture.receipt, warnings };
  } finally {
    try {
      await scope.close();
    } finally {
      await closeOpenClawStateDatabaseAsync();
    }
  }
}

it.each(
  (["doctor", "version", "readability"] as const).flatMap((scope) =>
    (["clean", "retained WAL", "retained journal", "wrong mode"] as const).map((shape) => ({
      scope,
      shape,
    })),
  ),
)("captures $scope phases before migrating legacy approvals ($shape)", async ({ scope, shape }) =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { env, stateDir } = state;
    const pathname = openOpenClawStateDatabase({ env }).path;
    const sourcePath = await state.writeJson("exec-approvals.json", {
      version: 1,
      defaults: { security: "deny" },
      agents: {},
      socket: { path: "/tmp/fixture.sock", token: "synthetic-token" },
    });
    await closeOpenClawStateDatabaseAsync();
    const retained = shape === "retained WAL" || shape === "retained journal";
    if (retained) {
      const setup = spawnNodeEvalSync(`
          const { DatabaseSync } = await import('node:sqlite');
          const db = new DatabaseSync(${JSON.stringify(pathname)});
          const wal = ${shape === "retained WAL"};
          db.exec(wal ? 'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;' : 'PRAGMA journal_mode=PERSIST;');
          db.exec('CREATE TABLE retained(value);');
          if (wal) {
            const reader = new DatabaseSync(${JSON.stringify(pathname)}, { readOnly: true });
            reader.exec('BEGIN; SELECT * FROM retained;');
            db.close(); reader.exec('COMMIT'); reader.close();
          } else db.close();
        `);
      expect(setup.status, setup.stderr).toBe(0);
      expect(
        fs.statSync(`${pathname}-${shape === "retained WAL" ? "wal" : "journal"}`).size,
      ).toBeGreaterThan(32);
    } else if (shape === "wrong mode") {
      fs.chmodSync(pathname, 0o644);
    }
    const generations = readUpdateDatabaseGenerations([
      pathname,
      state.statePath("client", "credentials.sqlite"),
    ]);
    const { receipt, warnings } = await withCapture(env, generations, async () => {
      const inspections = await import("./update-candidate-state.inspection.js");
      const observations = vi.spyOn(inspections, "readUpdateSqliteDatabaseGenerationPairIsolated");
      const transactions = vi.spyOn(sqliteTransactions, "runSqliteImmediateTransactionSync");
      await repairDoctorStateSchemaAsync({ env }, scope);
      const writing = scope !== "readability";
      expect(
        observations.mock.calls.filter(([paths]) => paths.length === 1 && paths[0] === pathname),
      ).toHaveLength((writing ? 2 : 0) + (retained ? 2 : 0));
      expect(transactions.mock.calls.length > 0).toBe(writing);
      await openOpenClawStateDatabaseForDoctor({ env });
      resolveDoctorUpdateAdmission(env).assertCurrent();
      const result = await migrateLegacyExecApprovals({
        env,
        stateDir,
        detected: detectLegacyExecApprovals({ stateDir, doctorOnlyStateMigrations: true }),
      });
      expect(result.warnings).toEqual([]);
      expect(fs.existsSync(sourcePath)).toBe(false);
    });
    expect(warnings).toEqual([]);
    expect(receipt?.unchanged).toBe(true);
    expect(
      JSON.parse(readExecApprovalsConfigRow(openOpenClawStateDatabase({ env }).db)!.raw_json),
    ).toMatchObject({ defaults: { security: "deny" } });
    expect(runClientCredentialOperation(env, { kind: "socket.read" })).toMatchObject({
      socket: { socket_path: "/tmp/fixture.sock", socket_token: "synthetic-token" },
    });
  }),
);

it.each(["native", "worker"] as const)(
  "completes retirement after Doctor migrations and %s parent bookkeeping",
  async (parent) =>
    withOpenClawTestState({}, async (state) => {
      const { stateDir: root, env, configPath } = state;
      const alias = path.join(root, "alias");
      fs.symlinkSync(root, alias, "junction");
      process.env.OPENCLAW_STATE_DIR = env.OPENCLAW_STATE_DIR = alias;
      const pathname = state.statePath("state", "openclaw.sqlite");
      const credentialsPath = state.statePath("client", "credentials.sqlite");
      await state.writeConfig({
        session: { idleMinutes: 45 },
        gateway: { mode: "local" },
      });
      const credential = { type: "api_key", provider: "openai", key: "synthetic-migration-key" };
      const authSource = await state.writeJson("agents/main/agent/auth-profiles.json", {
        version: 1,
        profiles: { "openai:default": credential },
      });
      writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });
      const { runId } = createUpdateRun({ trigger: "cli" }, { env });
      Object.assign(env, { [UPDATE_RUN_ID_ENV]: runId });
      await closeOpenClawStateDatabaseAsync();
      const sourcePaths = [pathname, credentialsPath];
      const sourceGenerations = readUpdateDatabaseGenerations(sourcePaths);
      const backup: UpdateDatabaseBackup = {
        directory: root,
        databases: [],
        missingPaths: [],
        sourcePaths,
        sourceGenerations: { ...sourceGenerations },
        warnings: [],
      };
      const first = await withCapture(env, sourceGenerations, async () => {
        for (const repair of [
          repairOpenClawStateDatabaseIndexesForDoctor,
          repairOpenClawStateDatabaseReadabilityForDoctor,
        ]) {
          expect((await repair({ env })).warnings).toEqual([]);
        }
        const preflight = await runDoctorConfigPreflight({
          retiredStateAdmitted: true,
          repairPrefixedConfig: true,
          doctorOnlyStateMigrations: true,
          invalidConfigNote: false,
          observe: false,
        });
        const authRepair = await repairAuthProfileMigration({
          cfg: preflight.snapshot.config,
          env,
          prompter: { shouldRepair: true, confirmAutoFix: async () => true },
        });
        expect(authRepair.warnings).toEqual([]);
        expect(authRepair.storeChanges.length).toBeGreaterThan(0);
        recordUpdateModelRetirement("deferred", env);
      });
      expect(first.warnings).toEqual([]);
      expect(first.receipt).toMatchObject({ unchanged: true, fromGenerations: sourceGenerations });
      recordUpdateDatabaseWrites(backup, first.receipt, { name: "pre-plugin doctor" });

      const completion = {
        step: "pre-plugin doctor",
        status: "completed" as const,
        endedAtMs: Date.now(),
      };
      if (parent === "native") {
        recordUpdateRunStep(runId, completion, { env });
      } else {
        await recordUpdateRunStepAsync(runId, completion, { env });
      }
      await observeUpdateParentDatabaseWrites(backup, { env });
      // A separate Doctor process must acquire exclusion while the parent stays alive.
      const moduleUrl = (entry: Parameters<typeof resolveRuntimeWorkerUrl>[0]) =>
        JSON.stringify(resolveRuntimeWorkerUrl(entry).href);
      const child = spawnNodeEvalSync(
        `
            import { createUpdateDoctorDatabaseWriteCapture } from ${moduleUrl(storageProcessTestEntrypoints.updateDoctorResult)};
            import { createOpenClawDatabaseMaintenanceScope } from ${moduleUrl(stateNativeProcessEntrypoints.maintenanceScope)};
            import { prepareOpenClawStateDatabaseSchema, closeOpenClawStateDatabaseAsync } from ${moduleUrl(stateNativeProcessEntrypoints.stateDatabase)};
            import { recordUpdateModelRetirement } from ${moduleUrl(storageProcessTestEntrypoints.updateModelRetirement)};
            const warnings = [];
            const capture = createUpdateDoctorDatabaseWriteCapture(${JSON.stringify(backup.migration!.to)}, {
              env: process.env, signal: new AbortController().signal,
              warn: message => warnings.push(message),
            });
            const scope = createOpenClawDatabaseMaintenanceScope({
              schemaMaintenance: true, assertOwnerCurrent() {}, assertDatabaseAccess() {},
            });
            try {
              await capture.admit();
              await scope.run(() => capture.run(async () => {
                const result = await prepareOpenClawStateDatabaseSchema({ env: process.env }, "doctor");
                warnings.push(...result.warnings);
                recordUpdateModelRetirement("completed", process.env);
              }));
              await scope.close();
              await capture.settle();
              process.stdout.write(JSON.stringify({ receipt: capture.receipt, warnings }));
            } finally {
              await scope.close();
              await closeOpenClawStateDatabaseAsync();
            }
        `,
        { env, timeout: 60_000 },
      );
      expect(child.status, child.stderr).toBe(0);
      const second: Awaited<ReturnType<typeof withCapture>> = JSON.parse(child.stdout);
      expect(second.receipt).toMatchObject({ unchanged: true });
      recordUpdateDatabaseWrites(backup, second.receipt, { name: "post-plugin doctor" });
      expect(backup.sourceGenerations).toEqual(sourceGenerations);
      expect(second.warnings).toEqual([]);
      expect(backup.restoreRefusal).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(configPath, "utf8")).session.reset.idleMinutes).toBe(45);
      expect(fs.existsSync(authSource)).toBe(false);
      expect(loadPersistedSharedAuthProfileStore(env)?.profiles).toEqual({
        "openai:default": credential,
      });
      expect(getUpdateRun(runId, { env })?.steps).toContainEqual(
        expect.objectContaining({
          step: "finalize:doctor:model-retirement",
          status: "completed",
        }),
      );
    }),
);

it.each(["source observation", "returned acquisition", "revoked authority"] as const)(
  "retires a refused cold Doctor writer before admitting its successor (%s)",
  async (boundary) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      writeConfigMachineState(
        "async-open-proof",
        { retained: "synthetic payload" },
        { env: state.env },
      );
      const pathname = openOpenClawStateDatabase({ env: state.env }).path;
      await closeOpenClawStateDatabaseAsync();
      const generations = readUpdateDatabaseGenerations([
        pathname,
        state.statePath("client", "credentials.sqlite"),
      ]);
      const controller = new AbortController();
      const interrupted = new Error(`cold writer refused at ${boundary}`);
      let current = true;
      const { receipt } = await withCapture(
        state.env,
        generations,
        async () => {
          const inspections = await import("./update-candidate-state.inspection.js");
          const read = inspections.readUpdateSqliteDatabaseGenerationPairIsolated;
          const native = await import("../state/openclaw-state-db-open.js");
          const acquire = native.openUnpublishedStateDatabaseAsync;
          let acquired: Awaited<ReturnType<typeof acquire>> | undefined;
          let stopped = false;
          const observer = vi
            .spyOn(inspections, "readUpdateSqliteDatabaseGenerationPairIsolated")
            .mockImplementation(async (...args) => {
              const result = await read(...args);
              if (boundary === "source observation" && !stopped && args[0].includes(pathname)) {
                stopped = true;
                controller.abort(interrupted);
              }
              return result;
            });
          const nativeOpen = vi
            .spyOn(native, "openUnpublishedStateDatabaseAsync")
            .mockImplementation(async (...args) => {
              const opened = await acquire(...args);
              acquired = opened;
              if (!stopped && boundary !== "source observation") {
                stopped = true;
                if (boundary === "revoked authority") {
                  current = false;
                } else {
                  controller.abort(interrupted);
                }
              }
              return opened;
            });
          const synchronous = vi.spyOn(sqliteReadOnlyWorker, "runSqliteReadOnlyWorkerSync");
          try {
            await expect(
              sqliteReadOnlyWorker.withSqliteReadOnlyWorkerScope(
                () => openOpenClawStateDatabaseForDoctor({ env: state.env, path: pathname }),
                { signal: controller.signal, deadlineOwnedByCaller: false },
              ),
            ).rejects.toBe(interrupted);
            if (boundary !== "source observation") {
              expect(acquired).toBeDefined();
              expect(acquired?.db.isOpen).toBe(false);
            }
            current = true;
            expect(
              openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(pathname),
            ).toBeUndefined();
            const opened = await sqliteReadOnlyWorker.withSqliteReadOnlyWorkerScope(() =>
              openOpenClawStateDatabaseForDoctor({ env: state.env, path: pathname }),
            );
            expect(
              opened.db
                .prepare(
                  "SELECT value_json FROM config_machine_state WHERE state_key='async-open-proof'",
                )
                .get(),
            ).toEqual({ value_json: '{"retained":"synthetic payload"}' });
            const acquisitions = observer.mock.calls.length;
            expect(openOpenClawStateDatabase({ env: state.env, path: pathname })).toBe(opened);
            expect(observer).toHaveBeenCalledTimes(acquisitions);
            expect(synchronous).not.toHaveBeenCalled();
          } finally {
            current = true;
            observer.mockRestore();
            nativeOpen.mockRestore();
            synchronous.mockRestore();
            await closeOpenClawStateDatabaseAsync();
          }
        },
        undefined,
        () => {
          if (!current) {
            throw interrupted;
          }
        },
      );
      expect(receipt?.unchanged).toBe(boundary !== "source observation");
    });
  },
);

it.each(["SDK sync", "Doctor async"] as const)(
  "attributes a captured absent shared store and its new credential companion during bootstrap (%s)",
  async (reader) => {
    const { root, pathname, env } = fixture(path.join("state", "openclaw.sqlite"));
    const localPath = path.join(root, "client", "credentials.sqlite");
    const generations = readUpdateDatabaseGenerations([pathname, localPath]);
    const { receipt, warnings } = await withCapture(
      env,
      generations,
      async () => {
        if (reader === "Doctor async") {
          await openOpenClawStateDatabaseForDoctor({ env });
        } else {
          openOpenClawStateDatabase({ env });
        }
        await closeOpenClawStateDatabaseAsync();
      },
      (requested) =>
        expect(requested).toBe(path.join(env.OPENCLAW_STATE_DIR!, "state/openclaw.sqlite")),
    );
    expect(warnings).toEqual([]);
    expect(receipt).toMatchObject({
      unchanged: true,
      generations: { [pathname]: expect.any(String), [localPath]: expect.any(String) },
    });
  },
);

it.each(["captured-generation", null, undefined])(
  "backs up only an uncaptured relocated source (%s)",
  (generation) => {
    using database = new DatabaseSync(":memory:");
    const pathname = "/synthetic/relocated/state.sqlite";
    const refuse = vi.fn();
    const backup = vi.fn(() => {
      expect(hasUpdateDoctorMigrationCapture()).toBe(false);
      expect(getUpdateDoctorMigrationSource(pathname)).toBeUndefined();
      return {
        capture: { path: pathname, generation: "fresh-generation", assertCurrent() {} },
        backupPath: "/synthetic/relocated/scoped.bak",
      };
    });
    const capture = {
      expected: () => generation,
      rebuiltIndex: () => undefined,
      assertCurrent() {},
      accept() {},
      refuse,
    };
    runWithDoctorMigrationBackup(backup, () =>
      runWithUpdateDoctorMigrationCapture(capture, () => {
        const getBackup = () =>
          getDoctorMigrationBackup(database, { path: pathname, env: {}, tables: ["retained"] });
        if (generation === undefined) {
          expect(getBackup()).toMatchObject({
            capture: { path: pathname, generation: "fresh-generation" },
          });
        } else {
          expect(getBackup).toThrow("Updater migration requires its captured source generation");
        }
        expect(hasUpdateDoctorMigrationCapture()).toBe(true);
      }),
    );
    expect(backup).toHaveBeenCalledTimes(generation === undefined ? 1 : 0);
    expect(refuse).toHaveBeenCalledTimes(generation === undefined ? 1 : 0);
    expect(hasUpdateDoctorMigrationCapture()).toBe(false);
  },
);
