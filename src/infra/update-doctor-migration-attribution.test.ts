import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchemaSteps } from "../state/openclaw-agent-db-schema.js";
import { OPENCLAW_AGENT_SCHEMA_V24_SQL } from "../state/openclaw-agent-schema-v24.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_V25_SQL } from "../state/openclaw-agent-schema-v25.test-support.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
  prepareOpenClawStateDatabaseSchema,
  repairOpenClawStateDatabaseIndexesForDoctor,
  repairOpenClawStateDatabaseReadabilityForDoctor,
} from "../state/openclaw-state-db.js";
import { addPreCutoverClientCredentialTablesForTest } from "../state/openclaw-state-schema.test-support.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runSqliteIntegrityOperationInWorker } from "./sqlite-integrity-operation.js";
import { prepareAgentDatabaseMigrationDiscovery } from "./state-migrations.media-persistence-targets.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";
import {
  detectSharedAuthStoreMigration,
  migrateSharedAuthStore,
} from "./state-migrations.shared-auth-store.js";
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

it.each(["read-only reader opens", "last writable reader closes"])(
  "migrates a captured WAL database when its %s without writing",
  async (transition) => {
    const root = fs.realpathSync(directories.make("captured-wal-reader-"));
    const pathname = path.join(root, "source.sqlite");
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    {
      using database = new DatabaseSync(pathname);
      database.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE retained(value); INSERT INTO retained VALUES (7);",
      );
    }
    // SQLite only removes the zero-write WAL index when a writable handle closes.
    const reader =
      transition === "last writable reader closes" ? new DatabaseSync(pathname) : undefined;
    reader?.prepare("SELECT * FROM retained").all();
    const generations = readUpdateDatabaseGenerations([pathname]);
    const { receipt, warnings } = await withCapture(env, generations, async () => {
      reader?.close();
      if (transition === "read-only reader opens") {
        using readOnly = new DatabaseSync(pathname, { readOnly: true });
        readOnly.prepare("SELECT * FROM retained").all();
      }
      expect(readUpdateDatabaseGenerations([pathname])[pathname]).not.toBe(generations[pathname]);
      const database = new DatabaseSync(pathname);
      try {
        runUpdateSqliteMigration(database, pathname, () => {
          database.exec("ALTER TABLE retained ADD COLUMN migrated;");
        });
        expect(database.prepare("SELECT value FROM retained").all()).toEqual([{ value: 7 }]);
      } finally {
        database.close();
      }
    });
    expect(warnings).toEqual([]);
    expect(receipt).toMatchObject({ unchanged: true, fromGenerations: generations });
  },
);

it.each(["already exclusive", "retain exclusive"])(
  "keeps native custody when a migration is %s",
  async (mode) => {
    const root = fs.realpathSync(directories.make("captured-exclusive-"));
    const pathname = path.join(root, "source.sqlite");
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
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
    const root = fs.realpathSync(directories.make("captured-wal-writer-"));
    const pathname = path.join(root, "source.sqlite");
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    {
      using database = new DatabaseSync(pathname);
      database.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE retained(value); INSERT INTO retained VALUES (7);",
      );
    }
    const generations = readUpdateDatabaseGenerations([pathname]);
    const { receipt } = await withCapture(env, generations, async () => {
      using writer = new DatabaseSync(pathname);
      writer.exec("UPDATE retained SET value = 8;");
      if (change === "same content") {
        writer.exec("UPDATE retained SET value = 7;");
      }
      writer.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      using database = new DatabaseSync(pathname);
      expect(() =>
        runUpdateSqliteMigration(database, pathname, () => {
          database.exec("ALTER TABLE retained ADD COLUMN migrated;");
        }),
      ).toThrow("SQLite migration source changed after update capture.");
    });
    expect(receipt).toMatchObject({ unchanged: false });
  },
);

// Published v2026.9.33's unversioned wire format, independent of the current digest owner.
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

it.each([false, true])(
  "retains a 2026.9.33 capture through migration and native close (changed: %s)",
  async (changed) => {
    const root = fs.realpathSync(directories.make("legacy-generation-"));
    const pathname = path.join(root, "source.sqlite");
    const missing = path.join(root, "missing.sqlite");
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    {
      using db = new DatabaseSync(pathname);
      db.exec("CREATE TABLE retained(value); INSERT INTO retained VALUES (7);");
    }
    const generations = { [pathname]: legacyGeneration(pathname), [missing]: null };
    expect(readUpdateDatabaseGenerations([pathname])[pathname]).not.toBe(generations[pathname]);
    if (changed) {
      using writer = new DatabaseSync(pathname);
      writer.exec("UPDATE retained SET value = 8;");
    }
    const migration = vi.fn();
    const { receipt, warnings } = await withCapture(env, generations, async () => {
      using db = openNodeSqliteDatabase(pathname);
      const run = () =>
        runUpdateSqliteMigration(db, pathname, () => {
          migration();
          db.exec("ALTER TABLE retained ADD COLUMN migrated;");
        });
      if (changed) {
        expect(run).toThrow("SQLite migration source changed after update capture.");
      } else {
        run();
      }
    });
    expect(migration).toHaveBeenCalledTimes(changed ? 0 : 1);
    expect(receipt?.unchanged).toBe(!changed);
    if (!changed) {
      expect(warnings).toEqual([]);
      expect(receipt).toMatchObject({
        fromGenerations: generations,
        generations: { [pathname]: legacyGeneration(pathname), [missing]: null },
      });
    }
  },
);

it.each([true, false])(
  "attributes schema, media and shared-auth migration (legacy: %s)",
  async (legacy) => {
    const version = legacy ? 24 : 25;
    const root = fs.realpathSync(directories.make("legacy-agent-generation-"));
    const pathname = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    const shared = openOpenClawStateDatabase({ env }).path;
    await closeOpenClawStateDatabaseAsync();
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    const store = JSON.stringify({ version: 1, profiles: {} });
    {
      using db = new DatabaseSync(pathname);
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec(legacy ? OPENCLAW_AGENT_SCHEMA_V24_SQL : OPENCLAW_AGENT_SCHEMA_V25_SQL);
      db.exec(`PRAGMA user_version = ${version};
      INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
      VALUES ('primary', 'agent', ${version}, 'main', 1, 1);`);
      db.prepare("INSERT INTO auth_profile_store VALUES ('primary', ?, 1)").run(store);
    }
    fs.chmodSync(pathname, 0o600);
    const generations = legacy
      ? {
          [pathname]: legacyGeneration(pathname),
          [shared]: legacyGeneration(shared),
        }
      : readUpdateDatabaseGenerations([pathname, shared]);
    const { receipt, warnings } = await withCapture(env, generations, async () => {
      await withAgentDatabaseMaintenanceLease({ env, processBound: true }, async (lease) => {
        using db = openNodeSqliteDatabase(pathname);
        await runSqliteIntegrityOperationInWorker(
          ensureOpenClawAgentDatabaseSchemaSteps(db, {
            agentId: "main",
            path: pathname,
            env,
            versionMigrationOnly: true,
          }),
          {
            busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
            signal: lease.signal,
            beforeResume: () => lease.assertOwned(),
          },
        );
        expect(db.prepare("PRAGMA user_version").get()?.user_version).toBeGreaterThan(24);
      });
      const preparedDiscovery = prepareAgentDatabaseMigrationDiscovery({
        env,
        configuredAgentDatabaseTargets: [{ agentId: "main", path: pathname }],
      });
      preparedDiscovery.versionMigrations = [{ path: pathname, foundVersion: version }];
      expect((await migrateLegacyMediaPersistence({ env, preparedDiscovery })).warnings).toEqual(
        [],
      );
      const detected = detectSharedAuthStoreMigration({
        stateDir: root,
        env,
        doctorOnlyStateMigrations: true,
      });
      expect(detected.hasLegacy).toBe(true);
      const relocation = await migrateSharedAuthStore({
        detected,
        stateDir: root,
        env,
      });
      expect(relocation.warnings).toEqual([]);
      expect(relocation.changes).toContain(
        "Relocated shared auth profiles into shared SQLite state.",
      );
      await closeOpenClawStateDatabaseAsync();
    });
    expect(warnings).toEqual([]);
    expect(receipt).toMatchObject({ unchanged: true, fromGenerations: generations });
    expect(receipt?.generations).toEqual(
      legacy
        ? { [pathname]: legacyGeneration(pathname), [shared]: legacyGeneration(shared) }
        : readUpdateDatabaseGenerations([pathname, shared]),
    );
  },
);

it("answers the unmarked 9.33 rollback request only for its recorded parent producer", async () => {
  const root = fs.realpathSync(directories.make("legacy-rollback-generation-"));
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const pathname = path.join(root, "source.sqlite");
  {
    using db = new DatabaseSync(pathname);
    db.exec("CREATE TABLE retained(value);");
  }
  const parent = readUpdateRunDriver();
  expect(parent).toBeDefined();
  createUpdateRun(
    { trigger: "cli", before: { version: "2026.9.33" }, origin: { driver: parent } },
    { env },
  );
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
});

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
          "SQLite migration source changed after update capture.",
        );
      }
      await closeOpenClawStateDatabaseAsync();
    });
    expect(receipt).toMatchObject({ unchanged: writer === "lease", fromGenerations: generations });
  },
);

it("attributes a captured absent shared store and its new credential companion during bootstrap", async () => {
  const root = fs.realpathSync(directories.make("captured-fresh-state-"));
  const pathname = path.join(root, "state", "openclaw.sqlite");
  const localPath = path.join(root, "client", "credentials.sqlite");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
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
