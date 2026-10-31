import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPersistedSharedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import {
  observeUpdateParentDatabaseWrites,
  recordUpdateDatabaseWrites,
} from "../cli/update-cli/update-command-database-receipts.js";
import { runDoctorConfigPreflight } from "../commands/doctor-config-preflight.js";
import { repairAuthProfileMigration } from "../commands/doctor/auth-profile-repair.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { stateNativeProcessEntrypoints } from "../state/native-process-runtime.test-support.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseIndexesForDoctor,
  repairOpenClawStateDatabaseReadabilityForDoctor,
} from "../state/openclaw-state-db.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import * as sqliteReadOnlyWorker from "./sqlite-readonly-worker.js";
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
  beginUpdateSqliteCompanion,
  getDoctorMigrationBackup,
  getUpdateDoctorMigrationSource,
  hasUpdateDoctorMigrationCapture,
  runUpdateSqliteMigration,
  runWithDoctorMigrationBackup,
  runWithUpdateDoctorMigrationCapture,
} from "./update-doctor-migration-attribution.js";
import { createUpdateDoctorDatabaseWriteCapture } from "./update-doctor-result.js";
import { readUpdateRunDriver } from "./update-run-driver.js";
import { createUpdateRun, getUpdateRun, recordUpdateRunStep } from "./update-run-ledger.js";
import { recordUpdateRunStepAsync } from "./update-run-write.async.js";

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
  runUpdateSqliteMigration(database, pathname, () =>
    database.exec("ALTER TABLE retained ADD COLUMN migrated;"),
  );
}

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
    using database = new DatabaseSync(pathname);
    migrate(database, pathname);
    expect(database.prepare("SELECT value FROM retained").all()).toEqual([{ value: 7 }]);
  });
  expect(warnings).toEqual([]);
  expect(receipt).toMatchObject({ unchanged: true, fromGenerations: generations });
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
    const { root, pathname, env } = fixture("source.sqlite", "INSERT INTO retained VALUES (7);");
    const missing = path.join(root, "missing.sqlite");
    const generations = { [pathname]: legacyGeneration(pathname), [missing]: null };
    expect(readUpdateDatabaseGenerations([pathname])[pathname]).not.toBe(generations[pathname]);
    if (change === "replaced file") {
      fs.renameSync(pathname, `${pathname}.old`);
      fs.copyFileSync(`${pathname}.old`, pathname);
    }
    // Retain committed WAL evidence; closing the last writer can erase its commit history.
    using writer = new DatabaseSync(pathname);
    if (change === "changed data" || change === "same-content commit") {
      writer.exec("UPDATE retained SET value = 8;");
      if (change === "same-content commit") {
        writer.exec("UPDATE retained SET value = 7;");
      }
    }
    const { receipt, warnings } = await withCapture(env, generations, async () => {
      using database = new DatabaseSync(pathname);
      if (change === "unchanged") {
        migrate(database, pathname);
        expect(database.prepare("SELECT value FROM retained").all()).toEqual([{ value: 7 }]);
      } else {
        expect(() => migrate(database, pathname)).toThrow(
          "SQLite migration source changed after update capture:",
        );
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

it.each(["native", "worker"] as const)(
  "completes retirement after Doctor migrations and %s parent bookkeeping",
  async (parent) =>
    withOpenClawTestState({}, async (state) => {
      const { stateDir: root, env, configPath } = state;
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
          expect(repair({ env }).warnings).toEqual([]);
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

it("attributes a captured absent shared store and its new credential companion during bootstrap", async () => {
  const { root, pathname, env } = fixture(path.join("state", "openclaw.sqlite"));
  const localPath = path.join(root, "client", "credentials.sqlite");
  const generations = readUpdateDatabaseGenerations([pathname, localPath]);
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

it.each(["captured-generation", null, undefined])(
  "backs up only an uncaptured relocated source (%s)",
  (generation) => {
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
    const capture = { expected: () => generation, assertCurrent() {}, accept() {}, refuse };
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
